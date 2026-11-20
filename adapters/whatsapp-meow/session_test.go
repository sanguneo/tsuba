package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"go.mau.fi/whatsmeow"
)

func TestSessionRejectsForeignStore(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "store.db"), []byte("synthetic foreign store"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := openSession(t.Context(), dir, nil)
	if !errors.Is(err, errSessionOwned) {
		t.Fatalf("foreign session accepted: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "device.db")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("adapter created a database in foreign session: %v", err)
	}
}

func TestSessionExclusiveAndReusableWithoutConnecting(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "independent")
	first, err := openSession(t.Context(), dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	if first.link.client.EnableAutoReconnect || first.link.client.InitialAutoReconnect {
		t.Error("uncertain sends could reconnect and retry")
	}
	if first.link.client.IsConnected() {
		t.Fatal("session construction connected to WhatsApp")
	}
	_, err = openSession(t.Context(), dir, nil)
	if !errors.Is(err, errSessionBusy) {
		t.Errorf("parallel ownership accepted: %v", err)
	}
	if err = first.Close(); err != nil {
		t.Fatal(err)
	}
	second, err := openSession(t.Context(), dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err = second.Close(); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(dir)
	if err != nil || info.Mode().Perm() != 0o700 {
		t.Fatalf("session directory is not private: %v", err)
	}
}

func TestSendErrorMapsExplicitRefusalsAndHidesUnknowns(t *testing.T) {
	cases := []struct {
		err  error
		code string
	}{
		{whatsmeow.ErrNotLoggedIn, "REAUTH_REQUIRED"},
		{whatsmeow.ErrIQNotAuthorized, "REAUTH_REQUIRED"},
		{whatsmeow.ErrIQForbidden, "FORBIDDEN"},
		{whatsmeow.ErrNotInGroup, "FORBIDDEN"},
		{whatsmeow.ErrNoPermissionInGroup, "FORBIDDEN"},
		{whatsmeow.ErrIQNotFound, "NOT_FOUND"},
		{whatsmeow.ErrGroupNotFound, "NOT_FOUND"},
		{whatsmeow.ErrRecipientNotOnWhatsApp, "NOT_FOUND"},
		{whatsmeow.ErrIQRateOverLimit, "RATE_LIMITED"},
		{fmt.Errorf("%w 403", whatsmeow.ErrServerReturnedError), "FORBIDDEN"},
		{fmt.Errorf("%w 401", whatsmeow.ErrServerReturnedError), "REAUTH_REQUIRED"},
		{fmt.Errorf("%w 404", whatsmeow.ErrServerReturnedError), "NOT_FOUND"},
		{fmt.Errorf("%w 429", whatsmeow.ErrServerReturnedError), "RATE_LIMITED"},
		{fmt.Errorf("%w 500", whatsmeow.ErrServerReturnedError), "INTERNAL"},
		{context.DeadlineExceeded, "INTERNAL"},
		{errors.New("synthetic private transport detail"), "INTERNAL"},
	}
	for _, tc := range cases {
		t.Run(tc.code+"/"+tc.err.Error(), func(t *testing.T) {
			var api *APIError
			if !errors.As(sendError(tc.err), &api) || api.Code != tc.code {
				t.Fatalf("wrong refusal mapping: %v", sendError(tc.err))
			}
		})
	}
}

func TestSendDisconnectedRefusesBeforeSDK(t *testing.T) {
	for _, state := range []string{"logged-out", "connecting", "conflict", "forbidden"} {
		t.Run(state, func(t *testing.T) {
			l := &link{state: state}
			_, err := l.Send(t.Context(), SendRequest{RoomID: "synthetic@lid", Text: "synthetic"})
			var api *APIError
			if !errors.As(err, &api) {
				t.Fatalf("missing refusal: %v", err)
			}
			want := "BUSY"
			switch state {
			case "logged-out":
				want = "REAUTH_REQUIRED"
			case "forbidden":
				want = "FORBIDDEN"
			}
			if api.Code != want {
				t.Fatalf("got %s want %s", api.Code, want)
			}
		})
	}
}
