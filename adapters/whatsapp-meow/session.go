package main

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"syscall"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/store/sqlstore"
	waLog "go.mau.fi/whatsmeow/util/log"
	_ "modernc.org/sqlite"
)

var (
	errSessionOwned = errors.New("session directory is not owned by whatsapp-meow")
	errSessionBusy  = errors.New("session directory is already in use")
)

type session struct {
	lock      *os.File
	container *sqlstore.Container
	link      *link
}

func openSession(ctx context.Context, dir string, cache *Store) (*session, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("create session directory: %w", err)
	}
	info, err := os.Lstat(dir)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return nil, errSessionOwned
	}
	if err = os.Chmod(dir, 0o700); err != nil {
		return nil, fmt.Errorf("protect session directory: %w", err)
	}
	for _, name := range []string{".lock", ".whatsapp-meow", "device.db", "device.db-wal", "device.db-shm", "history.json", "qr.txt", "pair-code.txt"} {
		entry, statErr := os.Lstat(filepath.Join(dir, name))
		if statErr != nil && !errors.Is(statErr, os.ErrNotExist) {
			return nil, fmt.Errorf("inspect private session file: %w", statErr)
		}
		if statErr == nil && !entry.Mode().IsRegular() {
			return nil, errSessionOwned
		}
	}
	lock, err := os.OpenFile(filepath.Join(dir, ".lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, fmt.Errorf("open session lock: %w", err)
	}
	if err = syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		if closeErr := lock.Close(); closeErr != nil {
			return nil, fmt.Errorf("close busy session lock: %w", closeErr)
		}
		return nil, errSessionBusy
	}
	s := &session{lock: lock}
	if err = claimSessionDirectory(dir); err != nil {
		return nil, errors.Join(err, s.Close())
	}
	dbFile, err := os.OpenFile(filepath.Join(dir, "device.db"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, errors.Join(fmt.Errorf("create private device store: %w", err), s.Close())
	}
	if err = dbFile.Close(); err != nil {
		return nil, errors.Join(err, s.Close())
	}
	dbURL := url.URL{Scheme: "file", Path: filepath.Join(dir, "device.db")}
	dbURL.RawQuery = "_pragma=foreign_keys(1)&_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)"
	s.container, err = sqlstore.New(ctx, "sqlite", dbURL.String(), waLog.Noop)
	if err != nil {
		return nil, errors.Join(fmt.Errorf("open private device store: %w", err), s.Close())
	}
	device, err := s.container.GetFirstDevice(ctx)
	if err != nil {
		return nil, errors.Join(fmt.Errorf("read private device: %w", err), s.Close())
	}
	client := whatsmeow.NewClient(device, waLog.Noop)
	client.EnableAutoReconnect = false
	client.InitialAutoReconnect = false
	client.DisableLoginAutoReconnect = false
	client.BackgroundEventCtx = ctx
	client.EmitAppStateEventsOnFullSync = true
	s.link = &link{client: client, store: cache, state: "connecting"}
	client.AddEventHandler(func(event any) { s.link.handle(ctx, event) })
	return s, nil
}

func claimSessionDirectory(dir string) error {
	marker := filepath.Join(dir, ".whatsapp-meow")
	data, err := os.ReadFile(marker)
	if err == nil {
		if string(data) != "tsuba-whatsapp-meow-v1\n" {
			return errSessionOwned
		}
		return nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("read session ownership: %w", err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return fmt.Errorf("inspect session directory: %w", err)
	}
	for _, entry := range entries {
		if entry.Name() != ".lock" {
			return errSessionOwned
		}
	}
	if err = os.WriteFile(marker, []byte("tsuba-whatsapp-meow-v1\n"), 0o600); err != nil {
		return fmt.Errorf("record session ownership: %w", err)
	}
	return nil
}

func (s *session) Close() error {
	if s.link != nil {
		s.link.client.Disconnect()
	}
	var dbErr error
	if s.container != nil {
		dbErr = s.container.Close()
	}
	return errors.Join(dbErr, s.lock.Close())
}
