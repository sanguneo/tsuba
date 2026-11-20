package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/types/events"
)

var (
	errLoginFailed = errors.New("login did not complete; run login again")
	phonePattern   = regexp.MustCompile(`^[0-9]{6,15}$`)
)

// Pairing artifacts are private local files, never stdout, HTTP, or logs.
// QR rendering is intentionally external to keep the Go dependency set small.
func login(ctx context.Context, s *session, dir string) error {
	if s.link.client.Store.ID != nil {
		return errors.New("already linked; use serve")
	}
	ctx, cancel := context.WithTimeout(ctx, 3*time.Minute)
	defer cancel()
	qr, err := s.link.client.GetQRChannel(ctx)
	if err != nil {
		return errLoginFailed
	}
	connected := make(chan struct{}, 1)
	handler := s.link.client.AddEventHandler(func(event any) {
		if _, ok := event.(*events.Connected); ok {
			select {
			case connected <- struct{}{}:
			default:
			}
		}
	})
	defer s.link.client.RemoveEventHandler(handler)
	defer removePairingFiles(dir)
	if err = s.link.client.Connect(); err != nil {
		return errLoginFailed
	}
	phoneFile := os.Getenv("TSUBA_WHATSAPP_MEOW_PAIR_PHONE_FILE")
	pairRequested := false
	return awaitLogin(ctx, qr, connected, func(payload string) error {
		if err := os.WriteFile(filepath.Join(dir, "qr.txt"), []byte(payload), 0o600); err != nil {
			return fmt.Errorf("save private QR payload: %w", err)
		}
		fmt.Println("QR payload refreshed in the private session directory")
		if phoneFile != "" && !pairRequested {
			pairRequested = true
			phone, readErr := os.ReadFile(phoneFile)
			if readErr != nil || !phonePattern.MatchString(strings.TrimSpace(string(phone))) {
				return errors.New("pair phone file must contain international digits only")
			}
			code, pairErr := s.link.client.PairPhone(ctx, strings.TrimSpace(string(phone)), true, whatsmeow.PairClientChrome, "Chrome (Linux)")
			if pairErr != nil {
				return errLoginFailed
			}
			if err := os.WriteFile(filepath.Join(dir, "pair-code.txt"), []byte(code), 0o600); err != nil {
				return fmt.Errorf("save private pair code: %w", err)
			}
			fmt.Println("pair code saved in the private session directory")
		}
		return nil
	})
}

func awaitLogin(ctx context.Context, qr <-chan whatsmeow.QRChannelItem, connected <-chan struct{}, showCode func(string) error) error {
	linked := false
	var historyDone <-chan time.Time
	for {
		select {
		case item, ok := <-qr:
			if !ok {
				qr = nil
				continue
			}
			switch item.Event {
			case whatsmeow.QRChannelEventCode:
				if err := showCode(item.Code); err != nil {
					return err
				}
			case whatsmeow.QRChannelEventError, whatsmeow.QRChannelTimeout.Event:
				return errLoginFailed
			case whatsmeow.QRChannelSuccess.Event:
				// The SDK has saved the device and acknowledged pairing.
				linked = true
			}
		case <-connected:
			linked = true
			connected = nil
			timer := time.NewTimer(time.Minute)
			defer timer.Stop()
			historyDone = timer.C
		case <-historyDone:
			return nil
		case <-ctx.Done():
			// The deadline bounds best-effort history too, not just pairing.
			if linked {
				return nil
			}
			return errLoginFailed
		}
	}
}

func removePairingFiles(dir string) {
	for _, name := range []string{"qr.txt", "pair-code.txt"} {
		if err := os.Remove(filepath.Join(dir, name)); err != nil && !errors.Is(err, os.ErrNotExist) {
			fmt.Fprintln(os.Stderr, "private pairing artifact cleanup failed")
		}
	}
}
