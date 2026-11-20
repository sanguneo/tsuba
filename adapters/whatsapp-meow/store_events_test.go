package main

import (
	"bytes"
	"encoding/json"
	"path/filepath"
	"testing"

	"go.mau.fi/whatsmeow/proto/waCommon"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	"google.golang.org/protobuf/proto"
)

func TestStoreRawMediaSurvivesRestartWithoutLeakingToJSON(t *testing.T) {
	path := filepath.Join(t.TempDir(), "private", "cache.json")
	s := openSyntheticStore(t, path)
	msg := syntheticStoreMessage(1)
	msg.Kind = "media"
	msg.Attachments = []Attachment{{ID: "synthetic-image", Kind: "image"}}
	msg.raw = &waE2E.Message{ImageMessage: &waE2E.ImageMessage{MediaKey: []byte("synthetic-media-key")}}
	storeMust(t, s.Put(msg, false))
	msg.raw.ImageMessage.MediaKey[0] = 'X'
	msg.Attachments[0].ID = "mutated"

	restored := openSyntheticStore(t, path)
	raw := restored.Raw(msg.RoomID, msg.ID)
	if got := raw.GetImageMessage().GetMediaKey(); string(got) != "synthetic-media-key" {
		t.Fatalf("raw payload not restored: %q", got)
	}
	raw.ImageMessage.MediaKey[0] = 'Y'
	page, _, err := restored.Page(msg.RoomID, 1, "")
	storeMust(t, err)
	if len(page) != 1 || len(page[0].Attachments) != 1 || page[0].Attachments[0].ID != "synthetic-image" ||
		string(page[0].raw.GetImageMessage().GetMediaKey()) != "synthetic-media-key" {
		t.Fatal("restarted message lost attachments or shared mutable raw data")
	}
	wire, err := json.Marshal(page)
	storeMust(t, err)
	if bytes.Contains(wire, []byte("mediaKey")) || bytes.Contains(wire, []byte("c3ludGhldGljLW1lZGlhLWtleQ==")) {
		t.Fatal("private protobuf leaked into the message envelope")
	}
}

func TestStoreRawTracksEditedAndRetainedMessageWindows(t *testing.T) {
	path := filepath.Join(t.TempDir(), "private", "cache.json")
	s := openSyntheticStore(t, path)
	for i := range storeMessageLimit + 1 {
		msg := syntheticStoreMessage(i)
		if i == 0 || i == 1 || i == storeMessageLimit {
			msg.raw = &waE2E.Message{Conversation: proto.String("original")}
		}
		storeMust(t, s.Put(msg, false))
	}
	evicted := syntheticStoreMessage(0)
	if s.Raw(evicted.RoomID, evicted.ID) != nil {
		t.Fatal("raw payload outlived memory window")
	}
	edit := syntheticStoreMessage(storeMessageLimit)
	edit.EditedAt = edit.SentAt
	edit.ReplyTo = "synthetic-reply"
	edit.Attachments = []Attachment{{ID: "edited", Kind: "image"}}
	edit.raw = &waE2E.Message{ImageMessage: &waE2E.ImageMessage{Caption: proto.String("edited")}}
	storeMust(t, s.Put(edit, false))

	restored := openSyntheticStore(t, path)
	memoryOnly := syntheticStoreMessage(1)
	if restored.Raw(memoryOnly.RoomID, memoryOnly.ID) != nil {
		t.Fatal("raw payload outlived disk window")
	}
	got, ok := restored.Find(edit.RoomID, edit.ID)
	if !ok || got.ReplyTo != edit.ReplyTo || len(got.Attachments) != 1 || got.Attachments[0].ID != "edited" ||
		!proto.Equal(restored.Raw(edit.RoomID, edit.ID), edit.raw) {
		t.Fatal("cached edit lost raw content, attachments, or reply linkage")
	}
}

func TestClientRevokeOnlyRemovesKnownMessageFromMatchingChat(t *testing.T) {
	s := openSyntheticStore(t, filepath.Join(t.TempDir(), "private", "cache.json"))
	l := link{store: s}
	msg := syntheticStoreMessage(1)
	msg.raw = &waE2E.Message{Conversation: proto.String("synthetic")}
	storeMust(t, s.Put(msg, false))
	updates, cancel := s.Subscribe()
	defer cancel()
	chat, err := types.ParseJID(msg.RoomID)
	storeMust(t, err)
	notification := &events.Message{
		Info: types.MessageInfo{MessageSource: types.MessageSource{Chat: chat}},
		Message: &waE2E.Message{ProtocolMessage: &waE2E.ProtocolMessage{
			Type: waE2E.ProtocolMessage_REVOKE.Enum(),
			Key:  &waCommon.MessageKey{ID: proto.String(msg.ID), RemoteJID: proto.String("000002@s.whatsapp.net")},
		}},
	}
	l.handle(t.Context(), notification)
	requireNoStoreUpdate(t, updates)
	if _, ok := s.Find(msg.RoomID, msg.ID); !ok {
		t.Fatal("cross-chat revoke removed the message")
	}
	notification.Message.ProtocolMessage.Key.RemoteJID = proto.String(msg.RoomID)
	l.handle(t.Context(), notification)
	update := nextStoreUpdate(t, updates)
	if update.Event != "message.deleted" || update.RoomID != msg.RoomID || len(update.MessageIDs) != 1 || update.MessageIDs[0] != msg.ID {
		t.Fatalf("incorrect deletion event: %+v", update)
	}
	if _, ok := s.Find(msg.RoomID, msg.ID); ok || s.Raw(msg.RoomID, msg.ID) != nil {
		t.Fatal("revoked message or raw payload remained in the cache")
	}
	l.handle(t.Context(), notification)
	requireNoStoreUpdate(t, updates)
}
