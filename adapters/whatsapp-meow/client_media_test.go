package main

import (
	"slices"
	"testing"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"google.golang.org/protobuf/proto"
)

func TestUploadedMediaMatchesWhatsAppWireFields(t *testing.T) {
	large := make([]byte, 16_000_001)
	tests := []struct {
		name, mime, field string
		size              int
		kind              whatsmeow.MediaType
	}{
		{"JPEG at inline limit", "image/jpeg", "imageMessage", 16_000_000, whatsmeow.MediaImage},
		{"PNG", "image/png", "imageMessage", 1, whatsmeow.MediaImage},
		{"PNG above inline limit", "image/png", "documentMessage", 16_000_001, whatsmeow.MediaDocument},
		{"MP4 above image limit", "video/mp4", "videoMessage", 16_000_001, whatsmeow.MediaVideo},
		{"WebM", "video/webm", "documentMessage", 1, whatsmeow.MediaDocument},
		{"WebP", "image/webp", "documentMessage", 1, whatsmeow.MediaDocument},
		{"audio", "audio/mpeg", "documentMessage", 1, whatsmeow.MediaDocument},
		{"PDF", "application/pdf", "documentMessage", 1, whatsmeow.MediaDocument},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			req := UploadRequest{Bytes: large[:tc.size], MimeType: tc.mime, Caption: "synthetic caption", Name: "sample.bin"}
			receipt := whatsmeow.UploadResponse{
				URL: "https://example.invalid/fixture", DirectPath: "/fixture",
				MediaKey: []byte{1, 2}, FileSHA256: []byte{3, 4}, FileEncSHA256: []byte{5, 6},
				FileLength: uint64(tc.size), StreamingSidecar: []byte{7, 8},
			}
			quote := &waE2E.ContextInfo{StanzaID: proto.String("quoted"), QuotedMessage: &waE2E.Message{Conversation: proto.String("reference")}}
			if got := uploadMediaType(req.MimeType, len(req.Bytes)); got != tc.kind {
				t.Fatalf("upload media key type = %q, want %q", got, tc.kind)
			}
			got := buildUploadedMedia(req, receipt, quote)
			message := got.ProtoReflect()
			fieldCount := 0
			for i := range message.Descriptor().Fields().Len() {
				if message.Has(message.Descriptor().Fields().Get(i)) {
					fieldCount++
				}
			}
			if fieldCount != 1 {
				t.Fatalf("message sets %d top-level fields, want 1", fieldCount)
			}
			var wire interface {
				whatsmeow.DownloadableMessage
				GetURL() string
				GetFileLength() uint64
				GetMimetype() string
				GetCaption() string
				GetContextInfo() *waE2E.ContextInfo
			}
			switch tc.field {
			case "imageMessage":
				wire = got.GetImageMessage()
			case "videoMessage":
				video := got.GetVideoMessage()
				wire = video
				if !slices.Equal(video.GetStreamingSidecar(), []byte{7, 8}) {
					t.Error("video is missing the SDK streaming sidecar")
				}
			case "documentMessage":
				document := got.GetDocumentMessage()
				wire = document
				if document.GetFileName() != "sample.bin" {
					t.Error("document is missing its original filename")
				}
			default:
				t.Fatalf("unexpected fixture variant %q", tc.field)
			}
			if wire.GetURL() != "https://example.invalid/fixture" || wire.GetDirectPath() != "/fixture" ||
				wire.GetFileLength() != uint64(tc.size) || wire.GetMimetype() != tc.mime || wire.GetCaption() != "synthetic caption" ||
				!slices.Equal(wire.GetMediaKey(), []byte{1, 2}) || !slices.Equal(wire.GetFileSHA256(), []byte{3, 4}) ||
				!slices.Equal(wire.GetFileEncSHA256(), []byte{5, 6}) || !proto.Equal(wire.GetContextInfo(), quote) {
				t.Errorf("expected %s with intact upload metadata, caption and quote; got %v", tc.field, got)
			}
		})
	}
}

func TestMediaUploadRejectsBotsBeforeContactingWhatsApp(t *testing.T) {
	l := &link{state: "open"}
	_, err := l.Upload(t.Context(), UploadRequest{RoomID: "1@bot", Bytes: []byte("synthetic")})
	if code := safeCode(err); code != "NOT_SUPPORTED" {
		t.Fatalf("bot upload error = %s, want NOT_SUPPORTED", code)
	}
}
