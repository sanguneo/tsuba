package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"syscall"
	"time"

	waStore "go.mau.fi/whatsmeow/store"
)

func main() {
	// SQLite, snapshots, QR and pairing artifacts are account credentials.
	syscall.Umask(0o077)
	waStore.DeviceProps.RequireFullSync = new(true)
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	if err := run(ctx, os.Args[1:]); err != nil {
		// Errors from the external SDK are never printed: they may contain JIDs.
		fmt.Fprintln(os.Stderr, "whatsapp-meow could not complete the command; check configuration, session ownership and link state")
		os.Exit(1)
	}
}

func run(ctx context.Context, args []string) (result error) {
	if len(args) != 1 || (args[0] != "login" && args[0] != "serve") {
		fmt.Println("usage: whatsapp-meow login | serve")
		return errors.New("expected login or serve")
	}
	dir := os.Getenv("TSUBA_WHATSAPP_MEOW_SESSION_DIR")
	if dir == "" {
		dir = filepath.Join("sessions", "whatsapp-meow")
	}
	absolute, err := filepath.Abs(dir)
	if err != nil {
		return err
	}
	s, err := openSession(ctx, absolute, nil)
	if err != nil {
		return err
	}
	var cache *Store
	defer func() {
		result = errors.Join(result, s.Close())
		if cache != nil {
			result = errors.Join(result, cache.Close())
		}
	}()
	cache, err = NewStore(filepath.Join(absolute, "history.json"))
	if err != nil {
		return err
	}
	s.link.store = cache
	if args[0] == "login" {
		if err := login(ctx, s, absolute); err != nil {
			return err
		}
		fmt.Println("linked; start the adapter with serve")
		return nil
	}
	if s.link.client.Store.ID == nil {
		return errors.New("not linked; run login first")
	}
	return serve(ctx, s.link)
}

func serve(ctx context.Context, l *link) error {
	token := os.Getenv("TSUBA_WHATSAPP_MEOW_HTTP_TOKEN")
	if token == "" {
		token = os.Getenv("TSUBA_TOKEN")
	}
	handler, err := NewHandler(token, l.store, l)
	if err != nil {
		return err
	}
	host := os.Getenv("TSUBA_HOST")
	if host == "" {
		host = "127.0.0.1"
	}
	port := 8796
	if value := os.Getenv("TSUBA_WHATSAPP_MEOW_PORT"); value != "" {
		port, err = strconv.Atoi(value)
		if err != nil || port < 1 || port > 65535 {
			return errors.New("invalid HTTP port")
		}
	}
	listener, err := net.Listen("tcp", net.JoinHostPort(host, strconv.Itoa(port)))
	if err != nil {
		return err
	}
	defer listener.Close()
	if err = l.client.Connect(); err != nil {
		return errors.New("WhatsApp connection failed")
	}
	server := &http.Server{
		Handler: handler, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 90 * time.Second,
		BaseContext: func(net.Listener) context.Context { return ctx },
	}
	done := make(chan error, 1)
	go func() { done <- server.Serve(listener) }()
	stopRegistration := startRegistration(ctx, port, token)
	defer stopRegistration()
	fmt.Println("whatsapp-meow HTTP server started")
	select {
	case err = <-done:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		if err = server.Shutdown(shutdownCtx); err != nil {
			return err
		}
		err = <-done
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	}
	return nil
}
