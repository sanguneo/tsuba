package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"time"
)

type streamReady struct {
	success
	Resumed bool              `json:"resumed"`
	Cursor  map[string]string `json:"cursor"`
}

type streamMessage struct {
	success
	Message *Message `json:"message"`
}

type streamCursor struct {
	success
	Cursor map[string]string `json:"cursor"`
}

func (h *adapterHTTP) stream(w http.ResponseWriter, r *http.Request) {
	query, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil {
		writeFailure(w, "INVALID_REQUEST")
		return
	}
	if query.Has("since") {
		writeFailure(w, "NOT_SUPPORTED")
		return
	}
	select {
	case h.streams <- struct{}{}:
		defer func() { <-h.streams }()
	default:
		writeFailure(w, "BUSY")
		return
	}

	// Register before ready becomes visible so a message published in response
	// to ready can't fall between the response and subscription.
	updates, unsubscribe := h.store.Subscribe()
	defer unsubscribe()
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Accel-Buffering", "no")
	out := eventStream{w, http.NewResponseController(w)}
	ok := success{OK: true}
	if err := out.emit("ready", streamReady{ok, false, map[string]string{}}); err != nil {
		return
	}

	const quiet = 25 * time.Second
	ping := time.NewTimer(quiet)
	defer ping.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-ping.C:
			if err := out.emit("ping", ok); err != nil {
				return
			}
		case update, open := <-updates:
			if !open {
				// Store closes a lagging subscriber instead of dropping updates.
				// The client must reread history; an incomplete stream is not OK.
				spec := httpFailures["BUSY"]
				if err := out.emit("error", failure{Error: errorBody{"BUSY", spec.message}}); err != nil {
					return
				}
				return
			}
			switch update.Event {
			case "message", "message.edited":
				message := h.messageAvatars(r.Context(), []Message{*update.Message})[0]
				if err := out.emit(update.Event, streamMessage{ok, &message}); err != nil {
					return
				}
				if update.Event == "message" {
					cursor := map[string]string{update.Message.RoomID: update.Message.ID}
					if err := out.emit("cursor", streamCursor{ok, cursor}); err != nil {
						return
					}
				}
			case "message.deleted":
				if err := out.emit(update.Event, struct {
					success
					RoomID     string   `json:"roomId"`
					MessageIDs []string `json:"messageIds"`
				}{ok, update.RoomID, update.MessageIDs}); err != nil {
					return
				}
			default:
				continue // Never emit an undeclared update.
			}
		}
		ping.Reset(quiet)
	}
}

type eventStream struct {
	writer     http.ResponseWriter
	controller *http.ResponseController
}

func (out eventStream) emit(event string, payload any) error {
	// A client that stops reading the wire must not hold a slot forever.
	// If the wire itself times out, no terminal event can be guaranteed.
	if err := out.controller.SetWriteDeadline(time.Now().Add(5 * time.Second)); err != nil &&
		!errors.Is(err, http.ErrNotSupported) {
		return err
	}
	data, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	if _, err := fmt.Fprintf(out.writer, "event: %s\ndata: %s\n\n", event, data); err != nil {
		return err
	}
	if err := out.controller.Flush(); err != nil {
		return err
	}
	if err := out.controller.SetWriteDeadline(time.Time{}); err != nil && !errors.Is(err, http.ErrNotSupported) {
		return err
	}
	return nil
}
