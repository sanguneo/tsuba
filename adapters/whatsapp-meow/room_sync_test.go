package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waAdv"
	"go.mau.fi/whatsmeow/proto/waSyncAction"
	"go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	"google.golang.org/protobuf/proto"
)

func TestRoomSyncConnectedHydratesLegacySQLite(t *testing.T) {
	active := types.NewJID("000071", types.DefaultUserServer)
	archived := types.NewJID("000072", types.DefaultUserServer)
	empty := types.NewJID("000073", types.DefaultUserServer)
	contactOnly := types.NewJID("000074", types.DefaultUserServer)
	s := legacyRoomSyncStore(t)
	ctx := t.Context()
	device := roomSyncDevice(t)
	storeMust(t, device.Contacts.PutContactName(ctx, active, "Synthetic first", "Synthetic saved name"))
	storeMust(t, device.Contacts.PutContactName(ctx, empty, "Empty", "Empty"))
	storeMust(t, device.Contacts.PutContactName(ctx, contactOnly, "Address book only", "Address book only"))
	storeMust(t, device.ChatSettings.PutArchived(ctx, archived, true))
	// The SDK client owns no socket: its optional joined-group IQ will not go out.
	l := &link{client: whatsmeow.NewClient(device, nil), store: s, state: "connecting"}

	l.handle(ctx, &events.Connected{})

	rooms := roomSyncHTTPRooms(t, s)
	if len(rooms) != 1 || rooms[0].ID != active.String() || rooms[0].Title != "Synthetic saved name" {
		t.Fatalf("upgraded /rooms contains stale names or inactive chats: %+v", rooms)
	}
	if _, found := s.Find(archived.String(), "fixture"); !found {
		t.Error("archive hydration removed cached history")
	}
	if _, _, err := s.Page(contactOnly.String(), 1, ""); err == nil {
		t.Error("hydration admitted an uncached address-book contact")
	}

	// SQLite still contains the old values when a newer event has already
	// updated the adapter or updated the cache in a previous process.
	at := time.Unix(1735776000, 0)
	l.handle(ctx, &events.Contact{JID: active, Timestamp: at, Action: &waSyncAction.ContactAction{FullName: proto.String("Newer live name")}})
	l.handle(ctx, &events.Archive{JID: archived, Timestamp: at, Action: &waSyncAction.ArchiveChatAction{Archived: proto.Bool(false)}})
	l.handle(ctx, &events.Connected{})
	if titles := activeTitles(s); len(titles) != 2 || titles[active.String()] != "Newer live name" || titles[archived.String()] != "Stale display name" {
		t.Fatalf("hydration overwrote live metadata: %v", titles)
	}
}

func TestRoomSyncLegacyLIDUsesOnlyUnambiguousSQLiteLabels(t *testing.T) {
	lid := types.NewJID("000075", types.HiddenUserServer)
	phone := types.NewJID("000076", types.DefaultUserServer)
	const snapshot = `{"version":1,"rooms":[
		{"room":{"id":"000075@lid","title":"WhatsApp chat","kind":"direct","unread":0},"messages":[{"id":"fixture","roomId":"000075@lid","sender":"Synthetic","text":"Synthetic","kind":"text","sentAt":"2025-01-01T00:00:00Z","fromMe":false}]}
	]}`
	for _, tc := range []struct {
		name, local, live, want string
		mapped, conflict        bool
	}{
		{name: "saved PN label", mapped: true, want: "Synthetic PN name"},
		{name: "local LID label wins", mapped: true, local: "Synthetic local name", want: "Synthetic local name"},
		{name: "no mapping", want: lid.User},
		{name: "conflicting retained mappings", mapped: true, conflict: true, want: lid.User},
		{name: "newer event wins", mapped: true, live: "Newer LID name", want: "Newer LID name"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := openLegacyRoomSyncStore(t, snapshot)
			device := roomSyncDevice(t)
			ctx := t.Context()
			storeMust(t, device.Contacts.PutContactName(ctx, phone, "", "Synthetic PN name"))
			if tc.local != "" {
				storeMust(t, device.Contacts.PutContactName(ctx, lid, "", tc.local))
			}
			if tc.mapped {
				storeMust(t, device.LIDs.PutLIDMapping(ctx, lid, phone))
			}
			l := &link{client: whatsmeow.NewClient(device, nil), store: s, state: "connecting"}
			if tc.live != "" {
				l.handle(ctx, &events.Contact{JID: lid, Timestamp: time.Unix(1735776000, 0), Action: &waSyncAction.ContactAction{FullName: proto.String(tc.live)}})
			}
			if tc.conflict {
				for _, other := range []string{"000077@s.whatsapp.net", "000078@s.whatsapp.net"} {
					l.handle(ctx, &events.Contact{JID: lid, Action: &waSyncAction.ContactAction{PnJID: proto.String(other)}})
				}
			}

			l.handle(ctx, &events.Connected{})
			rooms := roomSyncHTTPRooms(t, s)
			if len(rooms) != 1 || rooms[0].ID != lid.String() || rooms[0].Title != tc.want {
				t.Fatalf("authenticated /rooms got %+v, want only %s titled %q", rooms, lid, tc.want)
			}
			if _, _, err := s.Page(phone.String(), 1, ""); err == nil {
				t.Fatal("hydration created an address-book-only PN room")
			}
		})
	}
}

func roomSyncDevice(t *testing.T) *store.Device {
	t.Helper()
	ctx := t.Context()
	container, err := sqlstore.New(ctx, "sqlite", "file:"+filepath.Join(t.TempDir(), "synthetic.db")+"?_pragma=foreign_keys(1)", nil)
	storeMust(t, err)
	t.Cleanup(func() { storeMust(t, container.Close()) })
	device := container.NewDevice()
	own := types.NewJID("000070", types.DefaultUserServer)
	device.ID = &own
	device.Account = &waAdv.ADVSignedDeviceIdentity{
		Details: []byte{}, AccountSignature: make([]byte, 64),
		AccountSignatureKey: make([]byte, 32), DeviceSignature: make([]byte, 64),
	}
	storeMust(t, device.Save(ctx))
	return device
}

func legacyRoomSyncStore(t *testing.T) *Store {
	t.Helper()
	const skeleton = `{"version":1,"rooms":[
		{"room":{"id":"000071@s.whatsapp.net","title":"WhatsApp chat","kind":"direct","unread":0},"messages":[{"id":"fixture","roomId":"000071@s.whatsapp.net","sender":"Synthetic","text":"Synthetic","kind":"text","sentAt":"2025-01-01T00:00:00Z","fromMe":false}]},
		{"room":{"id":"000072@s.whatsapp.net","title":"Stale display name","kind":"direct","unread":0},"messages":[{"id":"fixture","roomId":"000072@s.whatsapp.net","sender":"Synthetic","text":"Synthetic","kind":"text","sentAt":"2025-01-01T00:00:00Z","fromMe":false}]},
		{"room":{"id":"000073@s.whatsapp.net","title":"Empty","kind":"direct","unread":0},"messages":[]}
	]}`
	return openLegacyRoomSyncStore(t, skeleton)
}

func openLegacyRoomSyncStore(t *testing.T, snapshot string) *Store {
	t.Helper()
	path := filepath.Join(t.TempDir(), "private", "history.json")
	storeMust(t, os.Mkdir(filepath.Dir(path), 0o700))
	storeMust(t, os.WriteFile(path, []byte(snapshot), 0o600))
	return openSyntheticStore(t, path)
}

type groupSyncFunc func(context.Context) ([]*types.GroupInfo, error)

func (f groupSyncFunc) GetJoinedGroups(ctx context.Context) ([]*types.GroupInfo, error) {
	return f(ctx)
}

func TestRoomSyncDoesNotInferDepartureFromJoinedGroups(t *testing.T) {
	historyChat := types.NewJID("000081", types.GroupServer)
	knownChat := types.NewJID("000082", types.GroupServer)
	freshChat := types.NewJID("000083", types.GroupServer)
	leftChat := types.NewJID("000084", types.GroupServer)
	failure := errors.New("synthetic unavailable group query")
	for _, tc := range []struct {
		name   string
		groups []*types.GroupInfo
		err    error
	}{
		{name: "empty"},
		{name: "unknown", groups: []*types.GroupInfo{nil, {JID: types.NewJID("000090", types.BroadcastServer)}}},
		{name: "partial", groups: []*types.GroupInfo{
			{JID: knownChat, GroupName: types.GroupName{Name: "Stale baseline subject"}},
			{JID: freshChat, GroupName: types.GroupName{Name: "Joined baseline subject"}},
			{JID: leftChat, GroupName: types.GroupName{Name: "Stale left group"}},
		}},
		{name: "error with rows", groups: []*types.GroupInfo{{JID: freshChat}}, err: failure},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := openSyntheticStore(t, "")
			l := &link{store: s}
			storeMust(t, s.PutRoom(Room{ID: historyChat.String(), Title: "History", Kind: "group"}))
			for _, jid := range []types.JID{historyChat, knownChat, leftChat} {
				storeMust(t, s.Put(httpFixtureMessage(jid.String(), "fixture", "Synthetic"), false))
			}
			at := time.Unix(1735776000, 0)
			groups := groupSyncFunc(func(ctx context.Context) ([]*types.GroupInfo, error) {
				if deadline, ok := ctx.Deadline(); !ok || time.Until(deadline) > 10*time.Second {
					t.Errorf("group request lacks ten-second deadline")
				}
				l.handle(ctx, &events.GroupInfo{JID: knownChat, Timestamp: at, Name: &types.GroupName{Name: "Newer live subject"}})
				l.handle(ctx, &events.GroupInfo{JID: leftChat, Timestamp: at, Delete: &types.GroupDelete{}})
				return tc.groups, tc.err
			})
			if err := s.hydrateRooms(t.Context(), &store.Device{}, groups); !errors.Is(err, tc.err) {
				t.Fatalf("group lookup error = %v, want %v", err, tc.err)
			}
			want := map[string]string{historyChat.String(): "History", knownChat.String(): "Newer live subject"}
			if tc.name == "partial" {
				want[freshChat.String()] = "Joined baseline subject"
			}
			got := activeTitles(s)
			if len(got) != len(want) {
				t.Fatalf("room titles = %v, want %v", got, want)
			}
			for id, title := range want {
				if got[id] != title {
					t.Errorf("room %s = %q, want %q", id, got[id], title)
				}
			}
		})
	}
}

func roomSyncHTTPRooms(t *testing.T, s *Store) []Room {
	t.Helper()
	handler, err := NewHandler(httpTestToken, s, httpTestSender{state: "open"})
	storeMust(t, err)
	req := httptest.NewRequest(http.MethodGet, "/rooms", nil)
	req.Header.Set("Authorization", httpTestBearer)
	resp := httptest.NewRecorder()
	handler.ServeHTTP(resp, req)
	if resp.Code != http.StatusOK {
		t.Fatalf("GET /rooms status = %d", resp.Code)
	}
	var body struct{ Rooms []Room }
	storeMust(t, json.Unmarshal(resp.Body.Bytes(), &body))
	return body.Rooms
}
