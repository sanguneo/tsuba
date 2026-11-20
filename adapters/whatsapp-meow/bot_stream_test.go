package main

import (
	"encoding/json"
	"path/filepath"
	"testing"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waCommon"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/proto/waWeb"
	wastore "go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	"google.golang.org/protobuf/proto"
)

func streamRich(t *testing.T, texts ...string) *waE2E.Message {
	t.Helper()
	sections := make([]map[string]map[string]map[string]string, 0, len(texts))
	for _, text := range texts {
		sections = append(sections, map[string]map[string]map[string]string{
			"view_model": {"primitive": {"text": text}},
		})
	}
	data, err := json.Marshal(map[string]any{"sections": sections})
	storeMust(t, err)
	return syntheticRich(string(data))
}

func TestHTTPBotStreamReplacesEveryFullRevision(t *testing.T) {
	path := filepath.Join(t.TempDir(), "private", "history.json")
	store := openSyntheticStore(t, path)
	handler, err := NewHandler(httpTestToken, store, httpTestSender{state: "open"})
	storeMust(t, err)
	server := httpTestServer(t, handler)
	_, stream := openHTTPStream(t, server, "/stream")
	wantReady(t, stream)
	const id = "reply-anchor"
	sdk := new(whatsmeow.Client)
	own := types.NewJID("900001", types.HiddenUserServer)
	sdk.Store = &wastore.Device{LID: own}
	conn := &link{client: sdk, store: store}
	original, err := sdk.ParseWebMessage(types.EmptyJID, &waWeb.WebMessageInfo{
		Key:              &waCommon.MessageKey{ID: new(id), RemoteJID: new(syntheticBotRoom)},
		Message:          streamRich(t, "One bright star."),
		MessageTimestamp: new(uint64(1760000000)),
	})
	storeMust(t, err)
	original.Info.PushName = "Fixture push"
	senderName := "Fixture push"
	sentAt := formatStoreTime(original.Info.Timestamp)
	checkMessage := func(origin string, got Message, want string) {
		t.Helper()
		if got.ID != id || got.SentAt != sentAt || got.SenderID != syntheticBotRoom || got.FromMe || got.Text != want {
			t.Fatalf("%s: got %q at %s (%s/%s), want %q at the original anchor", origin, got.Text, got.SentAt, got.ID, got.SenderID, want)
		}
		if got.Sender != senderName {
			t.Fatalf("%s: sender %q, want %q", origin, got.Sender, senderName)
		}
	}
	checkFrame := func(event, want string) {
		t.Helper()
		var frame streamMessage
		storeMust(t, json.Unmarshal(wantHTTPEvent(t, stream, event), &frame))
		if !frame.OK || frame.Message == nil {
			t.Fatalf("missing message in %s frame", event)
		}
		checkMessage("SSE", *frame.Message, want)
	}
	checkPage := func(want string) {
		t.Helper()
		response := httpWire(t, server, wireRequest{
			method: "GET", path: "/messages?roomId=" + syntheticBotRoom, auth: httpTestBearer,
		})
		var answer struct {
			OK       bool
			Messages []Message
		}
		storeMust(t, json.Unmarshal(wireAnswer(t, response, 200), &answer))
		if !answer.OK || len(answer.Messages) != 1 {
			t.Fatalf("HTTP history has %d messages; want exactly the original anchor", len(answer.Messages))
		}
		checkMessage("HTTP", answer.Messages[0], want)
	}
	storeMust(t, conn.applyMessage(original, true))
	checkFrame("message", "One bright star.")
	var cursor streamCursor
	storeMust(t, json.Unmarshal(wantHTTPEvent(t, stream, "cursor"), &cursor))
	if !cursor.OK || len(cursor.Cursor) != 1 || cursor.Cursor[syntheticBotRoom] != id {
		t.Fatalf("unexpected initial cursor: %+v", cursor)
	}
	senderName = "Fixture verified"
	storeMust(t, store.updateRoom(Room{ID: syntheticBotRoom}, func(meta *roomMeta) {
		meta.Verified.Name = senderName
	}))
	checkPage("One bright star.")
	senderName = "Fixture contact"
	storeMust(t, store.updateRoom(Room{ID: syntheticBotRoom}, func(meta *roomMeta) {
		meta.Contact.Name = senderName
	}))
	checkPage("One bright star.")
	senderName = "Fixture chat"
	storeMust(t, store.PutRoom(Room{ID: syntheticBotRoom, Title: senderName}))
	checkPage("One bright star.")
	if msg, _ := store.Find(syntheticBotRoom, id); msg.Sender != senderName {
		t.Fatalf("cached sender %q, want %q", msg.Sender, senderName)
	}

	stamp := original.Info.Timestamp.Add(time.Second)
	protocol := func(replacement *waE2E.Message) *waE2E.Message {
		return &waE2E.Message{EphemeralMessage: &waE2E.FutureProofMessage{Message: &waE2E.Message{
			ProtocolMessage: &waE2E.ProtocolMessage{
				Type:          waE2E.ProtocolMessage_MESSAGE_EDIT.Enum(),
				Key:           &waCommon.MessageKey{ID: new(id), RemoteJID: new(own.String()), FromMe: new(true)},
				EditedMessage: replacement,
				TimestampMS:   new(stamp.UnixMilli()),
			},
		}}}
	}
	for _, rev := range []struct {
		name, envelope string
		stage          types.BotEditType
		flag           types.EditAttribute
		lines          []string
		want           string
	}{
		{"complete", "edit-full", types.EditTypeFull, "", []string{"Two bright stars."}, "Two bright stars."},
		{"intermediate", "edit-inner", types.EditTypeInner, "", []string{"Three bright stars.", "A moon."}, "Three bright stars.\nA moon."},
		{"protocol", "edit-protocol", "", types.EditAttributeAdminEdit, []string{"The sky has cleared."}, "The sky has cleared."},
		{"final", "edit-last", types.EditTypeLast, "", []string{"Four bright stars.", "The moon is full."}, "Four bright stars.\nThe moon is full."},
		{"top-level flag only", id, "", types.EditAttributeMessageEdit, []string{"Four bright stars.", "The moon is full and the sky is clear."}, "Four bright stars.\nThe moon is full and the sky is clear."},
	} {
		replacement := streamRich(t, rev.lines...)
		raw := replacement
		if rev.name == "protocol" {
			raw = protocol(replacement)
		}
		edit := syntheticBotEvent(rev.envelope, raw)
		edit.Info.Timestamp, edit.Info.Edit = stamp, rev.flag
		edit.Info.Sender.Device = 7 // The live device-qualified source is the same bot as history.
		if rev.stage != "" {
			edit.Info.MsgBotInfo = types.MsgBotInfo{EditType: rev.stage, EditTargetID: id, EditSenderTimestampMS: stamp}
		}
		storeMust(t, conn.applyMessage(edit.UnwrapRaw(), true))
		checkPage(rev.want)
		checkFrame("message.edited", rev.want)
		if persisted := store.Raw(syntheticBotRoom, id); !proto.Equal(persisted, replacement) {
			t.Fatalf("%s replacement did not retain its full raw payload", rev.name)
		}
	}

	updates, cancel := store.Subscribe()
	defer cancel()
	for _, unwanted := range []struct {
		name   string
		change func(*events.Message)
	}{
		{"stale", func(edit *events.Message) {
			edit.Info.MsgBotInfo.EditSenderTimestampMS = stamp.Add(-time.Millisecond)
		}},
		{"foreign sender", func(edit *events.Message) {
			edit.Info.Sender = types.NewJID("2", types.BotServer)
		}},
		{"wrong direction", func(edit *events.Message) {
			edit.Info.IsFromMe = true
		}},
		{"duplicate", func(edit *events.Message) {
			edit.RawMessage = streamRich(t, "Four bright stars.", "The moon is full and the sky is clear.")
		}},
	} {
		edit := syntheticBotEvent("rejected-edit", streamRich(t, unwanted.name))
		edit.Info.Timestamp = stamp
		edit.Info.MsgBotInfo = types.MsgBotInfo{EditType: types.EditTypeLast, EditTargetID: id, EditSenderTimestampMS: stamp}
		unwanted.change(edit)
		storeMust(t, conn.applyMessage(edit.UnwrapRaw(), true))
		requireNoStoreUpdate(t, updates)
	}
	const final = "Four bright stars.\nThe moon is full and the sky is clear."
	checkPage(final)
	reopened := openSyntheticStore(t, path)
	msg, found := reopened.Find(syntheticBotRoom, id)
	if !found {
		t.Fatal("original anchor was not persisted")
	}
	checkMessage("reopened store", msg, final)
}

func TestNonBotEditsStillRequireNewerTimestamp(t *testing.T) {
	store := openSyntheticStore(t, "")
	original := syntheticBotEvent("original", &waE2E.Message{Conversation: new("original")})
	peer := types.NewJID("900001", types.DefaultUserServer)
	original.Info.Chat, original.Info.Sender = peer, peer
	storeMust(t, store.Apply(original, false))

	at := original.Info.Timestamp.Add(2 * time.Second)
	for _, rev := range []struct {
		at   time.Time
		text string
	}{{at, "accepted"}, {at, "same timestamp"}, {at.Add(-time.Second), "stale"}} {
		edit := *original
		edit.Info.Timestamp, edit.Info.Edit = rev.at, types.EditAttributeMessageEdit
		edit.RawMessage = &waE2E.Message{Conversation: &rev.text}
		storeMust(t, store.Apply(&edit, true))
	}
	if msg, found := store.Find(peer.String(), "original"); !found || msg.Text != "accepted" {
		t.Fatalf("nonbot edit was overwritten by an equal-time or stale revision: %+v", msg)
	}
}
