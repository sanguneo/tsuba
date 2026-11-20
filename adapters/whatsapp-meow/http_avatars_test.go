package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"go.mau.fi/whatsmeow/types"
)

func TestHTTPRoomAndSenderAvatarSnapshot(t *testing.T) {
	var lookups atomic.Int32
	cache := newRoomAvatarCache(&avatarTestSDK{lookup: func(context.Context, types.JID) (*types.ProfilePictureInfo, error) {
		lookups.Add(1)
		return &types.ProfilePictureInfo{URL: avatarTestURL}, nil
	}}, &http.Client{Transport: avatarTestTransport(func(*http.Request) (*http.Response, error) {
		return avatarTestResponse(200, "image/png", avatarTestPNG, 8), nil
	})})
	store, err := NewStore("")
	storeMust(t, err)
	defer store.Close()
	msg := httpFixtureMessage(httpTestRoom, "photo-source", "synthetic")
	msg.SenderID = "000001@s.whatsapp.net"
	storeMust(t, store.Put(msg, false))
	h := &adapterHTTP{store: store, sender: httpTestSender{state: "open"}, avatars: cache}
	// These are the production route functions; auth/method routing is covered
	// by TestHTTPRoutesAuthenticateBeforeMethodAndFeature.
	server := httpTestServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/rooms":
			h.rooms(w, r)
		case "/messages":
			h.messages(w, r)
		case "/media":
			h.media(w, r)
		default:
			http.NotFound(w, r)
		}
	}))
	roomResponse := httpWire(t, server, wireRequest{method: "GET", path: "/rooms"})
	var rooms struct {
		Rooms []Room `json:"rooms"`
	}
	storeMust(t, json.Unmarshal(wireAnswer(t, roomResponse, 200), &rooms))
	if len(rooms.Rooms) != 1 || rooms.Rooms[0].Avatar == "" {
		t.Fatal("room avatar missing")
	}
	page := httpWire(t, server, wireRequest{method: "GET", path: "/messages?roomId=" + httpTestRoom})
	var messages struct {
		Messages []Message `json:"messages"`
	}
	storeMust(t, json.Unmarshal(wireAnswer(t, page, 200), &messages))
	if len(messages.Messages) != 1 || messages.Messages[0].SenderAvatar != rooms.Rooms[0].Avatar {
		t.Fatal("sender avatar missing or snapshot id mismatched")
	}
	photo := httpWire(t, server, wireRequest{method: "GET", path: "/media?id=" + rooms.Rooms[0].Avatar})
	body, err := io.ReadAll(photo.Body)
	storeMust(t, err)
	t.Logf("%s headers=%v body=%x", photo.Status, photo.Header, body)
	if photo.StatusCode != 200 || photo.Header.Get("Content-Type") != "image/png" || string(body) != avatarTestPNG ||
		photo.Header.Get("X-Content-Type-Options") != "nosniff" {
		t.Fatal("room snapshot did not reach media HTTP")
	}
	if lookups.Load() != 2 {
		t.Fatal("media route triggered extra profile lookup")
	}
	cache.http.CloseIdleConnections()
	t.Log("PASS production rooms/messages/media handlers served synthetic cached room and sender photos")
}

func TestHTTPAvatarDisconnectedReadDoesNotStartLookup(t *testing.T) {
	cache := newRoomAvatarCache(&avatarTestSDK{lookup: func(context.Context, types.JID) (*types.ProfilePictureInfo, error) {
		t.Error("disconnected page started profile lookup")
		return nil, nil
	}}, nil)
	h := &adapterHTTP{sender: httpTestSender{state: "connecting"}, avatars: cache}
	messages := []Message{{SenderID: "000001@s.whatsapp.net"}}
	if got := h.messageAvatars(t.Context(), messages); got[0].SenderAvatar != "" {
		t.Fatal("unexpected disconnected avatar")
	}
	recorder := httptest.NewRecorder()
	h.media(recorder, httptest.NewRequest("GET", "/media?id=wa-room-v1-absent", nil))
	if recorder.Code != 404 {
		t.Fatal("missing cached picture should be 404")
	}
	cache.http.CloseIdleConnections()
}
