package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"reflect"
	"strings"
	"testing"
)

func TestHTTPCapabilitiesMatchContractAndCanonicalRevision(t *testing.T) {
	spec, err := os.ReadFile("../../contract/openapi.json")
	if err != nil {
		t.Fatal(err)
	}
	var contract struct {
		Info struct {
			Version string `json:"version"`
		} `json:"info"`
	}
	if err := json.Unmarshal(spec, &contract); err != nil {
		t.Fatal(err)
	}
	_, handler := httpTestHarness(t, httpTestSender{state: "connecting"})
	server := httpTestServer(t, handler)
	resp := httpWire(t, server, wireRequest{method: "GET", path: "/capabilities", auth: httpTestBearer})
	var answer map[string]any
	if err := json.Unmarshal(wireAnswer(t, resp, 200), &answer); err != nil {
		t.Fatal(err)
	}
	if answer["ok"] != true || !reflect.DeepEqual(answer["contract"], map[string]any{"version": contract.Info.Version}) {
		t.Fatalf("capabilities did not announce contract version %s", contract.Info.Version)
	}
	features := map[string]any{
		"attachments.read": map[string]any{},
		"attachments.send": map[string]any{"maxBytes": float64(64000000), "caption": true, "captionMaxLength": float64(1024), "receipt": "accepted"},
		"avatars.read":     map[string]any{},
		"messages.reply":   map[string]any{},
		"rooms.list":       map[string]any{},
		"messages.read":    map[string]any{"paging": "before-id", "maxLimit": float64(100)},
		"messages.stream":  map[string]any{"resume": "none", "events": []any{"message.edited", "message.deleted"}},
		"messages.send":    map[string]any{"maxLength": float64(2048), "receipt": "accepted"},
	}
	want := map[string]any{
		"adapter":  map[string]any{"name": "tsuba-whatsapp-meow", "version": "0.1.0"},
		"account":  map[string]any{"kind": "user"},
		"provider": map[string]any{"id": "whatsapp-meow", "name": "WhatsApp", "icon": iconVersion()},
		"features": features,
	}
	for key, value := range want {
		if !reflect.DeepEqual(answer[key], value) {
			t.Fatalf("unexpected %s declaration: %#v", key, answer[key])
		}
	}
	canonical, err := json.Marshal(want) // Map keys are sorted independently of the transport structs.
	if err != nil {
		t.Fatal(err)
	}
	hash := sha256.Sum256(canonical)
	if answer["revision"] != hex.EncodeToString(hash[:8]) {
		t.Fatalf("revision=%v, not the canonical declaration hash", answer["revision"])
	}
}

func TestHTTPRoomAndWriteGatesUseSessionState(t *testing.T) {
	for _, row := range []struct {
		state, code string
		status      int
	}{
		{"open", "NOT_SUPPORTED", 501},
		{"connecting", "BUSY", 503},
		{"conflict", "BUSY", 503},
		{"forbidden", "FORBIDDEN", 403},
		{"logged-out", "REAUTH_REQUIRED", 503},
	} {
		t.Run(row.state, func(t *testing.T) {
			store, handler := httpTestHarness(t, httpTestSender{state: row.state, canBot: true})
			for _, room := range []string{httpTestRoom, httpTestBot, httpTestKnownBot} {
				httpPut(t, store, httpFixtureMessage(room, "fixture", "synthetic"), false)
			}
			server := httpTestServer(t, handler)
			resp := httpWire(t, server, wireRequest{method: "GET", path: "/rooms", auth: httpTestBearer})
			if row.state == "logged-out" {
				wireError(t, wireAnswer(t, resp, 503), "REAUTH_REQUIRED")
			} else {
				var rooms struct {
					OK       bool   `json:"ok"`
					Complete *bool  `json:"complete"`
					Rooms    []Room `json:"rooms"`
				}
				if err := json.Unmarshal(wireAnswer(t, resp, 200), &rooms); err != nil || !rooms.OK ||
					rooms.Complete == nil || *rooms.Complete || len(rooms.Rooms) != 3 {
					t.Fatalf("unexpected room list: %+v (%v)", rooms, err)
				}
				for _, room := range rooms.Rooms {
					var want map[string]bool
					if strings.HasSuffix(room.ID, "@bot") {
						want = map[string]bool{"messages.reply": false, "attachments.send": false}
						if room.ID == httpTestBot || (room.ID == httpTestKnownBot && row.state != "open") {
							want["messages.send"] = false
						}
					}
					if !reflect.DeepEqual(room.Features, want) {
						t.Fatalf("unexpected room narrowing for state %q: %v", row.state, room.Features)
					}
				}
			}
			send := httpWire(t, server, wireRequest{"POST", "/send", httpTestBearer, "application/json", httpSendJSON(httpTestBot, "synthetic")})
			wireError(t, wireAnswer(t, send, row.status), row.code)
		})
	}
}

func TestHTTPTokenRejectsShortOrWhitespace(t *testing.T) {
	for _, token := range []string{"short", "with ASCII whitespace", strings.Repeat("a", 16) + "\u00a0"} {
		if _, err := NewHandler(token, nil, nil); err == nil {
			t.Fatal("unsafe token was accepted")
		}
	}
}
