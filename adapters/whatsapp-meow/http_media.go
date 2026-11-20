package main

import (
	"context"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"go.mau.fi/whatsmeow/proto/waE2E"
)

// Match whatsapp-user's bounded, buffered multipart upload ceiling.
const (
	maxUploadBytes = 64_000_000
	maxCaption     = 1024
)

type UploadRequest struct {
	RoomID   string
	Bytes    []byte
	MimeType string
	Name     string
	Caption  string
	ReplyTo  *string
}

type MediaFile struct {
	Body     io.ReadCloser
	MimeType string
	Name     string
}

type mediaSender interface {
	Upload(context.Context, UploadRequest) (Message, error)
	Download(context.Context, *waE2E.Message) (MediaFile, error)
}

func (h *adapterHTTP) media(w http.ResponseWriter, r *http.Request) {
	query, err := url.ParseQuery(r.URL.RawQuery)
	id := query.Get("id")
	if err != nil || id == "" {
		writeFailure(w, "INVALID_REQUEST")
		return
	}
	if h.sender.State() == "logged-out" {
		writeFailure(w, "REAUTH_REQUIRED")
		return
	}
	if h.avatars != nil {
		if snapshot, ok := h.avatars.resolveMedia(id); ok {
			setMediaHeaders(w, snapshot.contentType, snapshot.name)
			w.Write(snapshot.bytes)
			return
		}
	}
	room, message, ok := mediaLocation(id)
	if !ok {
		writeFailure(w, "NOT_FOUND")
		return
	}
	raw := h.store.Raw(room, message)
	_, _, _, downloadable, found := mediaMetadata(raw)
	if !found || !hasMediaLocation(downloadable) {
		writeFailure(w, "NOT_FOUND")
		return
	}
	if code := sendStateCode(h.sender.State()); code != "" {
		writeFailure(w, code)
		return
	}
	transport, ok := h.sender.(mediaSender)
	if !ok {
		writeFailure(w, "NOT_SUPPORTED")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	file, err := transport.Download(ctx, raw)
	if err != nil {
		writeFailure(w, safeCode(err))
		return
	}
	defer file.Body.Close()
	setMediaHeaders(w, file.MimeType, file.Name)
	io.Copy(w, file.Body)
}

func setMediaHeaders(w http.ResponseWriter, mimeType, name string) {
	mimeType = strings.ToLower(strings.TrimSpace(strings.Split(mimeType, ";")[0]))
	disposition := "attachment"
	switch mimeType {
	case "image/jpeg", "image/png", "image/gif", "image/webp", "image/avif",
		"video/mp4", "video/webm", "video/ogg", "audio/mpeg", "audio/ogg",
		"audio/mp4", "audio/aac", "audio/webm", "audio/wav", "audio/flac":
		disposition = "inline"
	default:
		mimeType = "application/octet-stream"
	}
	if name != "" {
		fallback := strings.Map(func(r rune) rune {
			if r < 0x20 || r > 0x7e || r == '"' || r == '\\' {
				return '_'
			}
			return r
		}, name)
		encoded := strings.ReplaceAll(url.QueryEscape(name), "+", "%20")
		disposition += `; filename="` + fallback + `"; filename*=UTF-8''` + encoded
	}
	w.Header().Set("Content-Type", mimeType)
	w.Header().Set("Content-Disposition", disposition)
	w.Header().Set("Content-Security-Policy", "default-src 'none'; sandbox")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "private, max-age=86400")
}

func sendStateCode(state string) string {
	switch state {
	case "open":
		return ""
	case "logged-out":
		return "REAUTH_REQUIRED"
	case "forbidden":
		return "FORBIDDEN"
	default:
		return "BUSY"
	}
}
