package main

import (
	"encoding/json"
	"testing"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waCommon"
	"go.mau.fi/whatsmeow/proto/waE2E"
	wastore "go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/types"
)

func TestHTTPBotGenerationTimeBeforeRelayStillReplacesFullText(t *testing.T) {
	store, handler := httpTestHarness(t, httpTestSender{state: "open"})
	server := httpTestServer(t, handler)
	_, stream := openHTTPStream(t, server, "/stream")
	wantReady(t, stream)
	own := types.NewJID("900001", types.HiddenUserServer)
	conn := &link{store: store, client: &whatsmeow.Client{Store: &wastore.Device{LID: own}}}
	original := syntheticBotEvent("relay-anchor", streamRich(t, "Synthetic first"))
	relay := original.Info.Timestamp
	storeMust(t, conn.applyMessage(original, true))
	wantHTTPEvent(t, stream, "message")
	wantHTTPEvent(t, stream, "cursor")

	// Real bot sender_timestamp_ms and protocol timestampMS use generation
	// time, which can precede the first fragment's relay stanza timestamp.
	generated := relay.Add(-250 * time.Millisecond)
	for _, revision := range []struct {
		stage types.BotEditType
		text  string
	}{
		{types.EditTypeInner, "Synthetic first line.\nSynthetic complete second line."},
		{types.EditTypeLast, "Synthetic first line.\nSynthetic complete second line.\nSynthetic final line."},
	} {
		edit := syntheticBotEvent("relay-envelope", &waE2E.Message{ProtocolMessage: &waE2E.ProtocolMessage{
			Type: waE2E.ProtocolMessage_MESSAGE_EDIT.Enum(),
			Key: &waCommon.MessageKey{ID: new("relay-anchor"), RemoteJID: new(own.String()), FromMe: new(true)},
			EditedMessage: streamRich(t, revision.text), TimestampMS: new(generated.UnixMilli()),
		}})
		edit.Info.Timestamp = relay.Add(time.Second)
		edit.Info.MsgBotInfo = types.MsgBotInfo{
			EditType: revision.stage, EditTargetID: "relay-anchor", EditSenderTimestampMS: generated,
		}
		storeMust(t, conn.applyMessage(edit, true))
		response := httpWire(t, server, wireRequest{method: "GET", path: "/messages?roomId=" + syntheticBotRoom, auth: httpTestBearer})
		var page struct{ Messages []Message }
		storeMust(t, json.Unmarshal(wireAnswer(t, response, 200), &page))
		if len(page.Messages) != 1 || page.Messages[0].ID != "relay-anchor" || page.Messages[0].Text != revision.text ||
			page.Messages[0].SentAt != formatStoreTime(relay) || page.Messages[0].EditedAt != formatStoreTime(generated) {
			t.Fatalf("full bot revision generated before relay was dropped: %+v", page.Messages)
		}
		var frame streamMessage
		storeMust(t, json.Unmarshal(wantHTTPEvent(t, stream, "message.edited"), &frame))
		if frame.Message == nil || frame.Message.Text != revision.text {
			t.Fatal("full replacement did not reach SSE")
		}
	}
	updates, unsubscribe := store.Subscribe()
	defer unsubscribe()
	stale := syntheticBotEvent("stale", streamRich(t, "Synthetic stale"))
	stale.Info.MsgBotInfo = types.MsgBotInfo{
		EditType: types.EditTypeLast, EditTargetID: "relay-anchor", EditSenderTimestampMS: generated.Add(-time.Millisecond),
	}
	storeMust(t, conn.applyMessage(stale, true))
	requireNoStoreUpdate(t, updates)
}
