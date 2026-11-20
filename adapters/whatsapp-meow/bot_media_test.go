package main

import (
	"encoding/json"
	"io"
	"net/url"
	"testing"
	"time"

	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"
)

func TestHTTPBotFullSnapshotWithoutEditTargetIsNewMessage(t *testing.T) {
	for _, row := range []struct {
		name, kind, mime string
		raw              *waE2E.Message
	}{
		{"image", "image", "image/png", &waE2E.Message{ImageMessage: &waE2E.ImageMessage{
			Mimetype: new("image/png"), MediaKey: []byte{1}, DirectPath: new("/synthetic-image"),
		}}},
		{"video", "video", "video/mp4", &waE2E.Message{VideoMessage: &waE2E.VideoMessage{
			Mimetype: new("video/mp4"), MediaKey: []byte{1}, DirectPath: new("/synthetic-video"),
		}}},
		{"text", "", "", &waE2E.Message{Conversation: new("Synthetic complete response")}},
	} {
		t.Run(row.name, func(t *testing.T) {
			sender := &httpMediaSender{httpTestSender: httpTestSender{state: "open"}}
			store, handler := httpTestHarness(t, sender)
			server := httpTestServer(t, handler)
			_, stream := openHTTPStream(t, server, "/stream")
			wantReady(t, stream)
			conn := &link{store: store}
			event := syntheticBotEvent("complete-response", row.raw)
			event.Info.MsgBotInfo = types.MsgBotInfo{
				EditType: types.EditTypeFull, EditSenderTimestampMS: event.Info.Timestamp.Add(-time.Second),
			}
			storeMust(t, conn.applyMessage(event, true))
			response := httpWire(t, server, wireRequest{
				method: "GET", path: "/messages?roomId=" + syntheticBotRoom, auth: httpTestBearer,
			})
			var page struct{ Messages []Message }
			storeMust(t, json.Unmarshal(wireAnswer(t, response, 200), &page))
			if len(page.Messages) != 1 {
				t.Fatalf("complete bot response without an edit target disappeared: %d messages", len(page.Messages))
			}
			message := page.Messages[0]
			if message.ID != "complete-response" || message.EditedAt != "" || message.SentAt != formatStoreTime(event.Info.Timestamp) {
				t.Fatalf("new full response was treated as an edit: %+v", message)
			}
			var frame streamMessage
			storeMust(t, json.Unmarshal(wantHTTPEvent(t, stream, "message"), &frame))
			if frame.Message == nil || frame.Message.ID != message.ID || frame.Message.Kind != message.Kind {
				t.Fatal("new full response did not reach SSE")
			}
			wantHTTPEvent(t, stream, "cursor")
			if row.kind != "" {
				if len(message.Attachments) != 1 || len(frame.Message.Attachments) != 1 || message.Attachments[0].Kind != row.kind ||
					message.Attachments[0].MimeType != row.mime || frame.Message.Attachments[0].ID != message.Attachments[0].ID {
					t.Fatalf("complete bot response lost its media: %+v", message)
				}
				file := httpWire(t, server, wireRequest{
					method: "GET", path: "/media?id=" + url.QueryEscape(message.Attachments[0].ID), auth: httpTestBearer,
				})
				body, err := io.ReadAll(file.Body)
				storeMust(t, err)
				if file.StatusCode != 200 || file.Header.Get("Content-Type") != row.mime || string(body) != "synthetic file bytes" ||
					file.Header.Get("X-Content-Type-Options") != "nosniff" ||
					file.Header.Get("Content-Security-Policy") != "default-src 'none'; sandbox" {
					t.Fatal("new full response did not expose its retained media safely")
				}
			} else if message.Text != "Synthetic complete response" {
				t.Fatal("complete full text response disappeared")
			}
			updates, unsubscribe := store.Subscribe()
			defer unsubscribe()
			storeMust(t, conn.applyMessage(event, true))
			requireNoStoreUpdate(t, updates)
			for _, stage := range []types.BotEditType{types.EditTypeInner, types.EditTypeLast} {
				incomplete := syntheticBotEvent("targetless-fragment", row.raw)
				incomplete.Info.MsgBotInfo.EditType = stage
				storeMust(t, conn.applyMessage(incomplete, true))
				requireNoStoreUpdate(t, updates)
			}
		})
	}
}
