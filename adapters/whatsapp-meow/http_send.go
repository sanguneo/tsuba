package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"mime"
	"net/http"
	"slices"
	"strings"
	"sync"
	"unicode/utf8"
)

type Sender interface {
	State() string
	CanSendBot(context.Context, string) bool
	Send(context.Context, SendRequest) (Message, error)
}

type SendRequest struct {
	RoomID  string  `json:"roomId"`
	Text    string  `json:"text"`
	ReplyTo *string `json:"replyTo,omitempty"`
}

// Admission order is write order. A canceled waiter can leave without waking
// its successor while the head is still running.
type writeLine struct {
	mu    sync.Mutex
	queue []chan struct{}
}

func (line *writeLine) enter() chan struct{} {
	line.mu.Lock()
	defer line.mu.Unlock()
	if len(line.queue) == 4 {
		return nil
	}
	ready := make(chan struct{})
	line.queue = append(line.queue, ready)
	if len(line.queue) == 1 {
		close(ready)
	}
	return ready
}

func (line *writeLine) leave(ready chan struct{}) {
	line.mu.Lock()
	defer line.mu.Unlock()
	i := slices.Index(line.queue, ready)
	line.queue = slices.Delete(line.queue, i, i+1)
	if i == 0 && len(line.queue) > 0 {
		close(line.queue[0])
	}
}

func (h *adapterHTTP) send(w http.ResponseWriter, r *http.Request) {
	ready := h.writes.enter()
	if ready == nil {
		// Prevent the HTTP/1 server from draining an unread request before
		// sending the refusal. HTTP/2 can reject the request independently.
		if r.ProtoMajor == 1 {
			w.Header().Set("Connection", "close")
		}
		writeFailure(w, "RATE_LIMITED")
		return
	}
	defer h.writes.leave(ready)

	req, valid := parseSend(w, r)
	if !valid {
		writeFailure(w, "INVALID_REQUEST")
		return
	}
	ctx := r.Context()
	select {
	case <-ctx.Done():
		return
	case <-ready:
	}
	if ctx.Err() != nil {
		return
	}
	switch h.sender.State() {
	case "open":
	case "logged-out":
		writeFailure(w, "REAUTH_REQUIRED")
		return
	case "forbidden":
		writeFailure(w, "FORBIDDEN")
		return
	default: // Connecting, conflict, or a state the transport does not know.
		writeFailure(w, "BUSY")
		return
	}
	if strings.HasSuffix(req.RoomID, "@bot") && !h.sender.CanSendBot(ctx, req.RoomID) {
		writeFailure(w, "NOT_SUPPORTED")
		return
	}
	if req.ReplyTo != nil {
		if strings.HasSuffix(req.RoomID, "@bot") {
			writeFailure(w, "NOT_SUPPORTED")
			return
		}
		if h.store.Raw(req.RoomID, *req.ReplyTo) == nil {
			writeFailure(w, "NOT_FOUND")
			return
		}
	}
	if ctx.Err() != nil {
		return
	}
	message, err := h.sender.Send(ctx, req)
	if err != nil {
		writeFailure(w, safeCode(err))
		return
	}
	// Once WhatsApp accepts a send, persist it even if the caller disconnects.
	// If persistence fails, we still cannot report a definite refusal.
	if message.ID == "" || message.RoomID != req.RoomID {
		writeFailure(w, "INTERNAL")
		return
	}
	if err := h.store.Put(message, true); err != nil {
		writeFailure(w, "INTERNAL")
		return
	}
	writeJSON(w, http.StatusOK, streamMessage{success{OK: true}, &message})
}

func parseSend(w http.ResponseWriter, r *http.Request) (SendRequest, bool) {
	const bodyLimit = 32 << 10 // Also fits 2048 escaped surrogate pairs.
	var req SendRequest
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" || r.ContentLength > bodyLimit {
		return req, false
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, bodyLimit))
	if err != nil || !utf8.Valid(body) {
		return req, false
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	if token, err := decoder.Token(); err != nil || token != json.Delim('{') {
		return req, false
	}
	seen := make(map[string]bool, 3)
	for decoder.More() {
		key, err := decoder.Token()
		field, ok := key.(string)
		if err != nil || !ok || seen[field] {
			return req, false
		}
		seen[field] = true
		var value *string
		if err := decoder.Decode(&value); err != nil || value == nil || *value == "" {
			return req, false
		}
		switch field {
		case "roomId":
			req.RoomID = *value
		case "text":
			req.Text = *value
		case "replyTo":
			req.ReplyTo = value
		default:
			return req, false
		}
	}
	if token, err := decoder.Token(); err != nil || token != json.Delim('}') {
		return req, false
	}
	if _, err := decoder.Token(); err != io.EOF {
		return req, false
	}
	return req, canonicalRoom.MatchString(req.RoomID) && req.Text != "" &&
		utf8.RuneCountInString(req.Text) <= maxSendText
}
