package main

import (
	"encoding/json"
	"path/filepath"
	"testing"
)

func TestHTTPActiveMetadataOnlyRoomSurvivesRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "private", "history.json")
	store := openSyntheticStore(t, path)
	storeMust(t, store.PutRoom(Room{
		ID: "000091@s.whatsapp.net", Title: "Synthetic active conversation", Kind: "direct",
		LastActivityAt: "2026-01-01T00:00:00Z",
	}))
	storeMust(t, store.PutRoom(Room{
		ID: "000092@s.whatsapp.net", Title: "Synthetic address book only", Kind: "direct",
	}))
	reopened := openSyntheticStore(t, path)
	handler, err := NewHandler(httpTestToken, reopened, httpTestSender{state: "open"})
	storeMust(t, err)
	server := httpTestServer(t, handler)
	response := httpWire(t, server, wireRequest{method: "GET", path: "/rooms", auth: httpTestBearer})
	var answer struct {
		Rooms []Room `json:"rooms"`
	}
	storeMust(t, json.Unmarshal(wireAnswer(t, response, 200), &answer))
	if len(answer.Rooms) != 1 || answer.Rooms[0].ID != "000091@s.whatsapp.net" ||
		answer.Rooms[0].LastActivityAt != "2026-01-01T00:00:00Z" {
		t.Fatalf("active metadata-only chat must remain visible while address-book-only row stays hidden: %+v", answer.Rooms)
	}
}
