package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"

	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"
)

func TestMediaMapping(t *testing.T) {
	for _, row := range []struct {
		name          string
		raw           *waE2E.Message
		kind, caption string
	}{
		{"image", &waE2E.Message{ImageMessage: &waE2E.ImageMessage{
			Mimetype: new("IMAGE/PNG; codec=synthetic"), Caption: new("synthetic caption"),
			MediaKey: []byte{1}, DirectPath: new("/synthetic"), FileLength: new(uint64(12)),
			Width: new(uint32(2)), Height: new(uint32(3)), ContextInfo: &waE2E.ContextInfo{StanzaID: new("quoted")},
		}}, "image", "synthetic caption"},
		{"video", &waE2E.Message{VideoMessage: &waE2E.VideoMessage{MediaKey: []byte{1}, DirectPath: new("/synthetic")}}, "video", ""},
		{"animation", &waE2E.Message{VideoMessage: &waE2E.VideoMessage{MediaKey: []byte{1}, DirectPath: new("/synthetic"), GifPlayback: new(true)}}, "animation", ""},
		{"audio", &waE2E.Message{AudioMessage: &waE2E.AudioMessage{MediaKey: []byte{1}, DirectPath: new("/synthetic")}}, "audio", ""},
		{"voice", &waE2E.Message{AudioMessage: &waE2E.AudioMessage{MediaKey: []byte{1}, DirectPath: new("/synthetic"), PTT: new(true)}}, "voice", ""},
		{"document", &waE2E.Message{DocumentMessage: &waE2E.DocumentMessage{MediaKey: []byte{1}, DirectPath: new("/synthetic"), FileName: new("synthetic.pdf")}}, "file", ""},
		{"sticker", &waE2E.Message{StickerMessage: &waE2E.StickerMessage{MediaKey: []byte{1}, DirectPath: new("/synthetic")}}, "sticker", ""},
	} {
		t.Run(row.name, func(t *testing.T) {
			event := syntheticBotEvent("synthetic-media", row.raw)
			event.Info.Chat = types.NewJID("000000", types.GroupServer)
			msg := mapMessageEvent(event).message
			if msg == nil || msg.Kind != "media" || msg.Text != row.caption || len(msg.Attachments) != 1 ||
				msg.Attachments[0].Kind != row.kind || msg.Attachments[0].ID != "message:MDAwMDAwQGcudXMAc3ludGhldGljLW1lZGlh" {
				t.Fatalf("media mapping lost attachment/caption: %+v", msg)
			}
			if row.name == "image" {
				a := msg.Attachments[0]
				if a.MimeType != "image/png" || a.Size != 12 || a.Width != 2 || a.Height != 3 || msg.ReplyTo != "quoted" {
					t.Fatalf("image metadata lost: %+v", msg)
				}
			}
			wire, err := json.Marshal(msg)
			storeMust(t, err)
			if strings.Contains(string(wire), "mediaKey") || strings.Contains(string(wire), "directPath") {
				t.Fatalf("private transport fields leaked: %s", wire)
			}
		})
	}
}

func TestMediaMappingExcludesViewOnceAndUnlocatableBytes(t *testing.T) {
	image := &waE2E.ImageMessage{Caption: new("synthetic"), MediaKey: []byte{1}, DirectPath: new("/synthetic")}
	for _, raw := range []*waE2E.Message{
		{ViewOnceMessage: &waE2E.FutureProofMessage{Message: &waE2E.Message{ImageMessage: image}}},
		{ImageMessage: &waE2E.ImageMessage{ViewOnce: new(true), Caption: new("synthetic")}},
		{PtvMessage: &waE2E.VideoMessage{ViewOnce: new(true), MediaKey: []byte{1}, DirectPath: new("/synthetic")}},
	} {
		if msg := mapMessageEvent(syntheticBotEvent("once", raw)).message; msg != nil {
			t.Fatal("view-once content must not be exposed")
		}
	}
	msg := mapMessageEvent(syntheticBotEvent("caption", &waE2E.Message{ImageMessage: &waE2E.ImageMessage{Caption: new("synthetic")}})).message
	if msg == nil || msg.Text != "synthetic" || len(msg.Attachments) != 0 {
		t.Fatal("missing transport metadata must not create a broken attachment")
	}
	wrapped := &waE2E.Message{DocumentWithCaptionMessage: &waE2E.FutureProofMessage{Message: &waE2E.Message{DocumentMessage: &waE2E.DocumentMessage{
		Caption: new("synthetic wrapped"), MediaKey: []byte{1}, DirectPath: new("/synthetic"),
	}}}}
	msg = mapMessageEvent(syntheticBotEvent("wrapped", wrapped)).message
	if msg == nil || msg.Text != "synthetic wrapped" || len(msg.Attachments) != 1 {
		t.Fatal("document caption wrapper lost")
	}
}

func TestHTTPMediaExposesRetainedVideoNote(t *testing.T) {
	sender := &httpMediaSender{httpTestSender: httpTestSender{state: "open"}}
	store, handler := httpTestHarness(t, sender)
	event := syntheticBotEvent("video-note", &waE2E.Message{PtvMessage: &waE2E.VideoMessage{
		Mimetype: new("video/mp4"), MediaKey: []byte{1}, DirectPath: new("/synthetic"), Seconds: new(uint32(4)),
	}})
	event.Info.Chat = types.NewJID("000000", types.GroupServer)
	storeMust(t, store.Apply(event, false))
	server := httpTestServer(t, handler)

	page := httpWire(t, server, wireRequest{method: http.MethodGet, path: "/messages?roomId=" + httpTestRoom, auth: httpTestBearer})
	var listing struct {
		Messages []Message `json:"messages"`
	}
	storeMust(t, json.Unmarshal(wireAnswer(t, page, http.StatusOK), &listing))
	if len(listing.Messages) != 1 || listing.Messages[0].Kind != "media" || len(listing.Messages[0].Attachments) != 1 {
		t.Fatalf("video note should appear as one media message with one attachment: %+v", listing.Messages)
	}
	attachment := listing.Messages[0].Attachments[0]
	if attachment.Kind != "video" || attachment.DurationSeconds != 4 {
		t.Fatalf("video note lost its video metadata: %+v", attachment)
	}
	file := httpWire(t, server, wireRequest{method: http.MethodGet, path: "/media?id=" + url.QueryEscape(attachment.ID), auth: httpTestBearer})
	body, err := io.ReadAll(file.Body)
	storeMust(t, err)
	if file.StatusCode != http.StatusOK || file.Header.Get("Content-Type") != "video/mp4" || len(body) == 0 {
		t.Fatalf("video note attachment did not resolve: status=%d type=%q bytes=%d", file.StatusCode, file.Header.Get("Content-Type"), len(body))
	}
}

func TestMediaLocationRejectsMalformedAliases(t *testing.T) {
	for _, id := range []string{"", "message:", "message:@@@", "message:MDAwMDAwQGcudXMA", "message:MDAwMDAwQGcudXMAeAAA", "message:YQBi"} {
		if _, _, ok := mediaLocation(id); ok {
			t.Fatalf("accepted invalid opaque media id %q", id)
		}
	}
	room, id, ok := mediaLocation(mediaID(httpTestRoom, "retained"))
	if !ok || room != httpTestRoom || id != "retained" {
		t.Fatal("valid media id rejected")
	}
}
