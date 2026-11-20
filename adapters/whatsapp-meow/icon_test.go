package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"testing"
)

func TestHTTPProviderIconParity(t *testing.T) {
	reference, err := os.ReadFile("../whatsapp-user/icon.svg")
	storeMust(t, err)
	_, handler := httpTestHarness(t, httpTestSender{state: "connecting"})
	server := httpTestServer(t, handler)
	icon := httpWire(t, server, wireRequest{method: "GET", path: "/icon", auth: httpTestBearer})
	body, err := io.ReadAll(icon.Body)
	storeMust(t, err)
	t.Logf("%s headers=%v body=%s", icon.Status, icon.Header, body)
	if icon.StatusCode != 200 || icon.Header.Get("Content-Type") != "image/svg+xml" ||
		icon.Header.Get("X-Content-Type-Options") != "nosniff" ||
		icon.Header.Get("Content-Security-Policy") != "default-src 'none'; sandbox" ||
		!bytes.Equal(body, reference) {
		t.Fatal("Go provider must serve the same inert SVG bytes as whatsapp-user")
	}
	caps := httpWire(t, server, wireRequest{method: "GET", path: "/capabilities", auth: httpTestBearer})
	var answer struct {
		Provider providerIdentity `json:"provider"`
	}
	storeMust(t, json.Unmarshal(wireAnswer(t, caps, 200), &answer))
	hash := sha256.Sum256(reference)
	if answer.Provider.Name != "WhatsApp" || answer.Provider.ID != "whatsapp-meow" ||
		answer.Provider.Icon != hex.EncodeToString(hash[:8]) {
		t.Fatalf("provider identity or byte hash differs: %+v", answer.Provider)
	}
}
