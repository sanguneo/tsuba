package main

import (
	"path/filepath"
	"testing"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waCommon"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/proto/waHistorySync"
	"go.mau.fi/whatsmeow/proto/waSyncAction"
	"go.mau.fi/whatsmeow/proto/waWeb"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	"google.golang.org/protobuf/proto"
)

func TestRoomActivityUnreadableMetaAIAndOnlyActiveRoomsSurviveRestart(t *testing.T) {
	const when = 1735776000
	for _, jid := range []types.JID{
		types.NewJID("000091", types.BotServer),
		types.NewJID("13135550000", types.DefaultUserServer), // Synthetic match for the SDK's legacy bot pattern.
		types.NewJID("000092", types.DefaultUserServer),
	} {
		t.Run(jid.Server+"/"+jid.User, func(t *testing.T) {
			contactsOnly := types.NewJID("000099", types.DefaultUserServer)
			path := filepath.Join(t.TempDir(), "private", "history.json")
			caseStore := openSyntheticStore(t, path)
			l := &link{store: caseStore, client: &whatsmeow.Client{}}
			l.handle(t.Context(), &events.Contact{JID: contactsOnly, Action: &waSyncAction.ContactAction{FullName: proto.String("Address book")}})
			conversation := &waHistorySync.Conversation{ID: proto.String(jid.String()), LastMsgTimestamp: proto.Uint64(when)}
			if jid.Server != types.BotServer {
				conversation.ConversationTimestamp = proto.Uint64(when)
			}
			l.handle(t.Context(), &events.HistorySync{Data: &waHistorySync.HistorySync{Conversations: []*waHistorySync.Conversation{conversation}}})

			reopened := openSyntheticStore(t, path)
			rooms := roomSyncHTTPRooms(t, reopened)
			if len(rooms) != 1 || rooms[0].ID != jid.String() || rooms[0].LastActivityAt != formatStoreTime(time.Unix(when, 0)) || rooms[0].LastMessage != nil {
				t.Fatalf("authenticated /rooms omitted active unreadable chat or showed an address-book-only JID: %+v", rooms)
			}
			if jid.IsBot() && rooms[0].Title != "Meta AI bot" {
				t.Fatalf("bot fallback title = %q", rooms[0].Title)
			}
		})
	}
}

func TestRoomActivityDeleteChatPurgesAndStaleHistoryCannotReopen(t *testing.T) {
	chat := types.NewJID("000093", types.DefaultUserServer)
	path := filepath.Join(t.TempDir(), "private", "history.json")
	s := openSyntheticStore(t, path)
	l := &link{store: s, client: &whatsmeow.Client{}}
	at := time.Unix(1735776000, 0)
	l.handle(t.Context(), &events.Message{
		Info: types.MessageInfo{
			MessageSource: types.MessageSource{Chat: chat, Sender: chat}, ID: "old", Timestamp: at,
		},
		Message: &waE2E.Message{Conversation: proto.String("Synthetic old message")},
	})
	if len(roomSyncHTTPRooms(t, s)) != 1 || s.Raw(chat.String(), "old") == nil {
		t.Fatal("precondition: expected readable cached room with raw message")
	}

	l.handle(t.Context(), &events.DeleteChat{
		JID: chat, Timestamp: at.Add(time.Second), FromFullSync: true,
		Action: &waSyncAction.DeleteChatAction{},
	})
	if rooms := roomSyncHTTPRooms(t, s); len(rooms) != 0 {
		t.Errorf("explicitly deleted chat remained visible: %+v", rooms)
	}
	if _, ok := s.Find(chat.String(), "old"); ok || s.Raw(chat.String(), "old") != nil {
		t.Error("deleted message text or raw payload remained accessible")
	}

	reopened := openSyntheticStore(t, path)
	l.store = reopened
	stale := &events.HistorySync{Data: &waHistorySync.HistorySync{Conversations: []*waHistorySync.Conversation{{
		ID: proto.String(chat.String()), ConversationTimestamp: proto.Uint64(uint64(at.Unix())),
		Messages: []*waHistorySync.HistorySyncMsg{{Message: &waWeb.WebMessageInfo{
			Key: &waCommon.MessageKey{ID: proto.String("old")}, MessageTimestamp: proto.Uint64(uint64(at.Unix())),
			Message: &waE2E.Message{Conversation: proto.String("Synthetic old message")},
		}}},
	}}}}
	// Even a refreshed conversation timestamp alone is not new chat activity
	// after a delete. The actual payload is still from before the cutoff.
	stale.Data.Conversations[0].ConversationTimestamp = proto.Uint64(uint64(at.Add(5 * time.Second).Unix()))
	l.handle(t.Context(), stale)
	if rooms := roomSyncHTTPRooms(t, reopened); len(rooms) != 0 {
		t.Errorf("stale history resurrected a deleted room after restart: %+v", rooms)
	}

	stale.Data.Conversations[0].ConversationTimestamp = proto.Uint64(uint64(at.Unix()))
	l.handle(t.Context(), &events.Message{
		Info: types.MessageInfo{
			MessageSource: types.MessageSource{Chat: chat, Sender: chat}, ID: "new", Timestamp: at.Add(2 * time.Second),
		},
		Message: &waE2E.Message{Conversation: proto.String("Synthetic new message")},
	})
	l.handle(t.Context(), stale)
	rooms := roomSyncHTTPRooms(t, reopened)
	if len(rooms) != 1 || rooms[0].ID != chat.String() || rooms[0].LastMessage == nil || rooms[0].LastMessage.Text != "Synthetic new message" {
		t.Fatalf("genuine post-delete activity did not reopen the chat with new content: %+v", rooms)
	}
	if _, ok := reopened.Find(chat.String(), "old"); ok || reopened.Raw(chat.String(), "old") != nil {
		t.Error("stale history repopulated deleted content after the room reopened")
	}
}

func TestRoomActivityDeleteRangeKeepsOnlyMessagesNewerThanCutoff(t *testing.T) {
	s := openSyntheticStore(t, filepath.Join(t.TempDir(), "private", "history.json"))
	chat := types.NewJID("000094", types.DefaultUserServer)
	at := time.Unix(1735776000, 0)
	for i, id := range []string{"deleted", "newer"} {
		msg := httpFixtureMessage(chat.String(), id, id)
		msg.SentAt = formatStoreTime(at.Add(time.Duration(i+1) * time.Second))
		msg.raw = &waE2E.Message{Conversation: proto.String(id)}
		storeMust(t, s.Put(msg, false))
	}
	l := &link{store: s}
	l.handle(t.Context(), &events.DeleteChat{JID: chat, Timestamp: at, Action: &waSyncAction.DeleteChatAction{
		MessageRange: &waSyncAction.SyncActionMessageRange{LastMessageTimestamp: proto.Int64(at.Unix() + 1)},
	}})
	page, _, err := s.Page(chat.String(), 10, "")
	storeMust(t, err)
	if len(page) != 1 || page[0].ID != "newer" || s.Raw(chat.String(), "deleted") != nil || s.Raw(chat.String(), "newer") == nil {
		t.Fatalf("late delete did not retain only genuinely newer messages: %+v", page)
	}
}
