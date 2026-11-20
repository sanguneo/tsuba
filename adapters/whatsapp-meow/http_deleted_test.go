package main

import (
	"encoding/json"
	"testing"

	"go.mau.fi/whatsmeow/proto/waCommon"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"
)

func TestHTTPMediaDeleteStreamRemovesDownload(t *testing.T) {
	store, handler := httpTestHarness(t, &httpMediaSender{httpTestSender: httpTestSender{state: "open"}})
	server := httpTestServer(t, handler)
	raw := &waE2E.Message{ImageMessage: &waE2E.ImageMessage{
		MediaKey: []byte{1}, DirectPath: new("/synthetic"), Mimetype: new("image/png"),
	}}
	event := syntheticBotEvent("removed", raw)
	event.Info.Chat = types.NewJID("000000", types.GroupServer)
	storeMust(t, store.Apply(event, false))
	response, stream := openHTTPStream(t, server, "/stream")
	wantReady(t, stream)
	l := &link{store: store}
	revoke := syntheticBotEvent("revoke", &waE2E.Message{ProtocolMessage: &waE2E.ProtocolMessage{
		Type: waE2E.ProtocolMessage_REVOKE.Enum(), Key: &waCommon.MessageKey{ID: new("removed"), RemoteJID: new(httpTestRoom)},
	}})
	revoke.Info.Chat = event.Info.Chat
	storeMust(t, l.applyMessage(revoke, true))
	var answer struct {
		OK         bool     `json:"ok"`
		RoomID     string   `json:"roomId"`
		MessageIDs []string `json:"messageIds"`
	}
	storeMust(t, json.Unmarshal(wantHTTPEvent(t, stream, "message.deleted"), &answer))
	if !answer.OK || answer.RoomID != httpTestRoom || len(answer.MessageIDs) != 1 || answer.MessageIDs[0] != "removed" {
		t.Fatal("deletion did not reach SSE with known room and message")
	}
	resp := httpWire(t, server, wireRequest{method: "GET", path: "/media?id=" + mediaID(httpTestRoom, "removed"), auth: httpTestBearer})
	wireError(t, wireAnswer(t, resp, 404), "NOT_FOUND")
	storeMust(t, response.Body.Close())
}
