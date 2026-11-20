package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waCommon"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/proto/waHistorySync"
	"go.mau.fi/whatsmeow/proto/waSyncAction"
	"go.mau.fi/whatsmeow/proto/waWeb"
	"go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	"google.golang.org/protobuf/proto"
)

func TestActiveRoomsHistoryVisibility(t *testing.T) {
	for _, tc := range []struct {
		name, user, server               string
		archived, left, message, visible bool
	}{
		{"active", "000001", types.DefaultUserServer, false, false, true, true},
		{"archived", "000002", types.DefaultUserServer, true, false, true, false},
		{"left group", "000003", types.GroupServer, false, true, true, false},
		{"empty despite timestamp", "000004", types.DefaultUserServer, false, false, false, false},
		{"status", "status", types.BroadcastServer, false, false, true, false},
		{"system", "000005", types.NewsletterServer, false, false, true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, handler := httpTestHarness(t, httpTestSender{state: "open"})
			l := link{store: s, client: &whatsmeow.Client{}}
			id := types.NewJID(tc.user, tc.server).String()
			conversation := &waHistorySync.Conversation{
				ID: proto.String(id), Archived: proto.Bool(tc.archived), ReadOnly: proto.Bool(tc.left),
				ConversationTimestamp: proto.Uint64(1735776000),
			}
			if tc.message {
				conversation.Messages = []*waHistorySync.HistorySyncMsg{{Message: &waWeb.WebMessageInfo{
					Key:              &waCommon.MessageKey{ID: proto.String("fixture"), Participant: proto.String("000099@s.whatsapp.net")},
					Message:          &waE2E.Message{Conversation: proto.String("Synthetic message")},
					MessageTimestamp: proto.Uint64(1735776000),
				}}}
			}
			l.handle(t.Context(), &events.HistorySync{Data: &waHistorySync.HistorySync{Conversations: []*waHistorySync.Conversation{conversation}}})

			req := httptest.NewRequest(http.MethodGet, "/rooms", nil)
			req.Header.Set("Authorization", httpTestBearer)
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)
			var body struct{ Rooms []Room }
			if rec.Code != http.StatusOK {
				t.Fatalf("GET /rooms status = %d", rec.Code)
			}
			storeMust(t, json.Unmarshal(rec.Body.Bytes(), &body))
			if tc.visible {
				if len(body.Rooms) != 1 || body.Rooms[0].ID != id {
					t.Fatalf("active room missing: %+v", body.Rooms)
				}
			} else if len(body.Rooms) != 0 {
				t.Fatalf("inactive room leaked: %+v", body.Rooms)
			}
			if tc.archived || tc.left {
				if _, ok := s.Find(id, "fixture"); !ok {
					t.Fatal("visibility filtering discarded cached history")
				}
			}
		})
	}
}

func TestActiveRoomsLateTitlesAndArchiveChanges(t *testing.T) {
	s := openSyntheticStore(t, "")
	l := link{store: s}
	direct := types.NewJID("000011", types.DefaultUserServer)
	group := types.NewJID("000012", types.GroupServer)
	bot := types.NewJID("000013", types.BotServer)
	at := time.Unix(1735776000, 0)
	for _, chat := range []types.JID{direct, group, bot} {
		msg := httpFixtureMessage(chat.String(), "fixture", "Synthetic message")
		storeMust(t, s.Put(msg, false))
	}
	ctx := t.Context()
	l.handle(ctx, &events.PushName{JID: direct, Message: &types.MessageInfo{Timestamp: at}, NewPushName: "Pushed"})
	l.handle(ctx, &events.Contact{JID: direct, Timestamp: at, Action: &waSyncAction.ContactAction{FullName: proto.String(" Saved label ")}})
	l.handle(ctx, &events.PushName{JID: direct, Message: &types.MessageInfo{Timestamp: at.Add(time.Second)}, NewPushName: "Later push"})
	l.handle(ctx, &events.GroupInfo{JID: group, Timestamp: at, Name: &types.GroupName{Name: " Current subject "}})
	l.handle(ctx, &events.PushName{JID: bot, NewPushName: bot.User})
	if got := activeTitles(s); got[direct.String()] != "Saved label" || got[group.String()] != "Current subject" || got[bot.String()] != "Meta AI bot" {
		t.Errorf("wrong title precedence: %v", got)
	}
	l.handle(ctx, &events.Contact{JID: direct, Timestamp: at.Add(2 * time.Second)})
	l.handle(ctx, &events.PushName{JID: direct, Message: &types.MessageInfo{Timestamp: at}, NewPushName: "Stale replay"})
	if got := activeTitles(s)[direct.String()]; got != "Later push" {
		t.Errorf("late or replayed name = %q, want latest push", got)
	}
	l.handle(ctx, &events.Archive{JID: direct, Timestamp: at, Action: &waSyncAction.ArchiveChatAction{Archived: proto.Bool(true)}})
	if got := activeTitles(s); len(got) != 2 || got[direct.String()] != "" {
		t.Errorf("archive did not hide existing room: %v", got)
	}
	l.handle(ctx, &events.Archive{JID: direct, Timestamp: at.Add(time.Second), Action: &waSyncAction.ArchiveChatAction{Archived: proto.Bool(false)}})
	if got := activeTitles(s); len(got) != 3 || got[direct.String()] != "Later push" {
		t.Errorf("unarchive did not restore the same room and title: %v", got)
	}
}

func TestActiveRoomsGroupDepartureSurvivesRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "private", "cache.json")
	s := openSyntheticStore(t, path)
	own := types.NewJID("000021", types.DefaultUserServer)
	group := types.NewJID("000022", types.GroupServer)
	l := link{store: s, client: &whatsmeow.Client{Store: &store.Device{ID: &own}}}
	l.handle(t.Context(), &events.GroupInfo{
		JID: group, Leave: []types.JID{own}, Timestamp: time.Unix(1735776000, 0),
	})
	restored := openSyntheticStore(t, path)
	storeMust(t, restored.Put(httpFixtureMessage(group.String(), "fixture", "Synthetic message"), false))
	if len(restored.Rooms()) != 0 {
		t.Fatal("later history surfaced a group the account had left")
	}
	l.store = restored
	l.handle(t.Context(), &events.JoinedGroup{GroupInfo: types.GroupInfo{JID: group, GroupName: types.GroupName{Name: "Rejoined group"}}})
	if got := activeTitles(restored)[group.String()]; got != "Rejoined group" {
		t.Fatalf("group membership did not restore room: %q", got)
	}
}

func TestActiveRoomsSavedContactNamesLinkedLIDRooms(t *testing.T) {
	s := openSyntheticStore(t, "")
	l := link{store: s}
	phone := types.NewJID("000031", types.DefaultUserServer)
	lid := types.NewJID("000032", types.HiddenUserServer)
	l.handle(t.Context(), &events.Contact{JID: phone, Action: &waSyncAction.ContactAction{
		FirstName: proto.String("Address book"), LidJID: proto.String(lid.String()),
	}})
	if len(s.Rooms()) != 0 {
		t.Fatal("address-book update created an active room")
	}
	storeMust(t, s.Put(httpFixtureMessage(lid.String(), "fixture", "Synthetic message"), false))
	if got := activeTitles(s); len(got) != 1 || got[lid.String()] != "Address book" {
		t.Fatalf("saved PN name did not carry over to LID: %v", got)
	}
	other := types.NewJID("000033", types.DefaultUserServer)
	l.handle(t.Context(), &events.Contact{JID: other, Action: &waSyncAction.ContactAction{
		FirstName: proto.String("Unrelated"), LidJID: proto.String(lid.String()),
	}})
	if got := activeTitles(s)[lid.String()]; got != lid.User {
		t.Fatalf("ambiguous PN alias assigned another contact's name: %q", got)
	}
}

func activeTitles(s *Store) map[string]string {
	titles := make(map[string]string)
	for _, room := range s.Rooms() {
		titles[room.ID] = room.Title
	}
	return titles
}
