package main

import (
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"net/http"
)

// Go embeds only files inside its module. Keep this copy byte-identical to
// whatsapp-user/icon.svg; the HTTP parity test checks the shipped assets.
//
//go:embed icon.svg
var providerIcon []byte

func iconVersion() string {
	sum := sha256.Sum256(providerIcon)
	return hex.EncodeToString(sum[:8])
}

func serveIcon(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "image/svg+xml")
	w.Header().Set("Cache-Control", "private, max-age=86400")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; sandbox")
	w.Write(providerIcon)
}
