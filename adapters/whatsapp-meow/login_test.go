package main

import (
	"context"
	"errors"
	"testing"
	"testing/synctest"
	"time"

	"go.mau.fi/whatsmeow"
)

func TestAwaitLoginDeadline(t *testing.T) {
	for _, tc := range []struct {
		name      string
		qrResult  whatsmeow.QRChannelItem
		connected bool
		deadline  time.Duration
		wantWait  time.Duration
		wantErr   error
	}{
		{"connected with history window still open", whatsmeow.QRChannelSuccess, true, time.Second, time.Second, nil},
		{"paired without reconnect", whatsmeow.QRChannelSuccess, false, time.Second, time.Second, nil},
		{"connected with time for history", whatsmeow.QRChannelSuccess, true, 2 * time.Minute, time.Minute, nil},
		{"unconfirmed QR channel close", whatsmeow.QRChannelItem{}, false, time.Second, time.Second, errLoginFailed},
		{"SDK timeout", whatsmeow.QRChannelTimeout, false, time.Second, 0, errLoginFailed},
		{"SDK pairing error", whatsmeow.QRChannelItem{Event: whatsmeow.QRChannelEventError}, false, time.Second, 0, errLoginFailed},
	} {
		t.Run(tc.name, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				ctx, cancel := context.WithTimeout(t.Context(), tc.deadline)
				defer cancel()
				qr := make(chan whatsmeow.QRChannelItem, 1)
				connected := make(chan struct{}, 1)
				if tc.qrResult.Event != "" {
					qr <- tc.qrResult
				}
				close(qr)
				if tc.connected {
					connected <- struct{}{}
				}
				start := time.Now()
				err := awaitLogin(ctx, qr, connected, nil)
				if !errors.Is(err, tc.wantErr) {
					t.Fatalf("login result = %v, want %v", err, tc.wantErr)
				}
				if elapsed := time.Since(start); elapsed != tc.wantWait {
					t.Fatalf("elapsed fake time = %v, want %v", elapsed, tc.wantWait)
				}
			})
		})
	}
}
