package main

import (
	"testing"
	"time"

	"go.mau.fi/whatsmeow/proto/waAICommon"
	"go.mau.fi/whatsmeow/proto/waCommon"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
)

const syntheticBotRoom = "1@bot"

func syntheticBotEvent(id string, content *waE2E.Message) *events.Message {
	bot := types.NewJID("1", types.BotServer)
	return &events.Message{
		Info: types.MessageInfo{
			MessageSource: types.MessageSource{Chat: bot, Sender: bot},
			ID:            id, Timestamp: time.Date(2025, 1, 2, 3, 4, 5, 0, time.UTC),
		},
		RawMessage: content,
	}
}

func syntheticRich(data string) *waE2E.Message {
	return &waE2E.Message{RichResponseMessage: &waE2E.AIRichResponseMessage{
		UnifiedResponse: &waAICommon.AIRichResponseUnifiedResponse{Data: []byte(data)},
	}}
}

func TestMappingRichSectionsSkipMalformedBlocksAndKeepRoom(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name string
		msg  *waE2E.Message
		want string
	}{
		{"mixed sections", syntheticRich(`{"sections":[null,42,{"view_model":{"primitive":{"text":"alpha"}}},{"view_model":{"primitive":{"text":[1]}}},{"view_model":{"primitive":{"text":"  "}}},{"view_model":{"primitive":{"text":"beta"}}}]}`), "alpha\nbeta"},
		{"truncated JSON", syntheticRich(`{"sections":[`), ""},
		{"bad UTF-8", syntheticRich("{\"sections\":[{\"view_model\":{\"primitive\":{\"text\":\"\xff\"}}}]}"), ""},
		{"metadata without text", syntheticRich(`{"sections":[{"view_model":{"primitive":{"url":"ignored"}}}]}`), ""},
		{"wrapped view once", &waE2E.Message{EphemeralMessage: &waE2E.FutureProofMessage{Message: &waE2E.Message{
			ViewOnceMessageV2: &waE2E.FutureProofMessage{Message: &waE2E.Message{Conversation: new("do not show")}},
		}}}, ""},
		{"reaction", &waE2E.Message{ReactionMessage: &waE2E.ReactionMessage{Text: new("not a message")}}, ""},
		{"extended quote", &waE2E.Message{ExtendedTextMessage: &waE2E.ExtendedTextMessage{
			Text: new("quoted"), ContextInfo: &waE2E.ContextInfo{StanzaID: new("previous")},
		}}, "quoted"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s := openSyntheticStore(t, "")
			storeMust(t, s.Apply(syntheticBotEvent("entry", tc.msg), true))
			rooms := s.Rooms()
			if len(rooms) != 1 || rooms[0].ID != syntheticBotRoom || rooms[0].Kind != "direct" {
				t.Fatalf("bot room not preserved: %+v", rooms)
			}
			msg, found := s.Find(syntheticBotRoom, "entry")
			if found != (tc.want != "") || msg.Text != tc.want {
				t.Fatalf("message = %+v, found = %v; want text %q", msg, found, tc.want)
			}
			if tc.name == "extended quote" && msg.ReplyTo != "previous" {
				t.Fatalf("replyTo = %q", msg.ReplyTo)
			}
		})
	}
}

func TestMappingRichProtocolEditChecksKeyAndUpdatesOriginal(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name, room, sender string
		fromMe, applied    bool
	}{
		{"matching key", syntheticBotRoom, syntheticBotRoom, false, true},
		{"wrong room", "2@bot", syntheticBotRoom, false, false},
		{"wrong direction", syntheticBotRoom, syntheticBotRoom, true, false},
		{"wrong participant", syntheticBotRoom, "2@bot", false, false},
		{"absent participant", syntheticBotRoom, "", false, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := openSyntheticStore(t, "")
			original := syntheticBotEvent("root", &waE2E.Message{Conversation: new("first")})
			storeMust(t, s.Apply(original, false))
			updates, cancel := s.Subscribe()
			defer cancel()
			at := original.Info.Timestamp.Add(2500 * time.Millisecond)
			edit := syntheticBotEvent("envelope", &waE2E.Message{EditedMessage: &waE2E.FutureProofMessage{
				Message: &waE2E.Message{ProtocolMessage: &waE2E.ProtocolMessage{
					Key:  &waCommon.MessageKey{ID: new("root"), RemoteJID: &tc.room, Participant: &tc.sender, FromMe: &tc.fromMe},
					Type: waE2E.ProtocolMessage_MESSAGE_EDIT.Enum(), TimestampMS: new(at.UnixMilli()),
					EditedMessage: syntheticRich(`{"sections":[{"view_model":{"primitive":{"text":"revised"}}}]}`),
				}},
			}})
			edit.Info.Timestamp = at.Add(time.Second)
			storeMust(t, s.Apply(edit, true))
			msg, ok := s.Find(syntheticBotRoom, "root")
			if !ok || msg.SentAt != "2025-01-02T03:04:05Z" {
				t.Fatalf("original paging anchor changed: %+v", msg)
			}
			if _, extra := s.Find(syntheticBotRoom, "envelope"); extra {
				t.Fatal("edit was stored under its envelope ID")
			}
			if !tc.applied {
				if msg.Text != "first" || msg.EditedAt != "" {
					t.Fatalf("bad key changed message: %+v", msg)
				}
				requireNoStoreUpdate(t, updates)
				return
			}
			if msg.Text != "revised" || msg.EditedAt != "2025-01-02T03:04:07.5Z" {
				t.Fatalf("edit not applied using protocol timestamp: %+v", msg)
			}
			update := nextStoreUpdate(t, updates)
			if update.Event != "message.edited" || update.Message == nil || *update.Message != msg {
				t.Fatalf("edit did not emit the complete updated message: %+v", update)
			}
		})
	}
}

func TestMappingBotEditTargetsOriginalAndRejectsStaleEdit(t *testing.T) {
	t.Parallel()
	s := openSyntheticStore(t, "")
	storeMust(t, s.Apply(syntheticBotEvent("base", &waE2E.Message{Conversation: new("initial")}), false))
	for _, edit := range []struct {
		text    string
		seconds int
	}{{"later", 5}, {"stale", 2}} {
		evt := syntheticBotEvent("edit-stanza", &waE2E.Message{Conversation: &edit.text})
		evt.Info.MsgBotInfo = types.MsgBotInfo{
			EditType: types.EditTypeFull, EditTargetID: "base",
			EditSenderTimestampMS: evt.Info.Timestamp.Add(time.Duration(edit.seconds) * time.Second),
		}
		storeMust(t, s.Apply(evt, true))
	}
	page, _, err := s.Page(syntheticBotRoom, 10, "")
	storeMust(t, err)
	if len(page) != 1 || page[0].ID != "base" || page[0].Text != "later" || page[0].EditedAt != "2025-01-02T03:04:10Z" {
		t.Fatalf("bot edit target or ordering lost: %+v", page)
	}
}
