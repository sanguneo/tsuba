package main

import (
	"encoding/json"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/proto/waWeb"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	"google.golang.org/protobuf/proto"
)

func defaultRoom(chat types.JID) Room {
	room := Room{ID: chat.ToNonAD().String(), Kind: "direct", Title: "WhatsApp chat"}
	switch chat.Server {
	case types.GroupServer:
		room.Kind, room.Title = "group", "WhatsApp group"
	default:
		if chat.IsBot() {
			room.Title = "Meta AI bot"
		}
	}
	return room
}

type mappedEvent struct {
	room    Room
	message *Message
}

func mapMessageEvent(evt *events.Message, self ...types.JID) mappedEvent {
	if evt == nil {
		return mappedEvent{}
	}
	info := evt.Info
	chat := info.Chat.ToNonAD()
	switch chat.Server {
	case types.DefaultUserServer, types.HiddenUserServer,
		types.BotServer, types.GroupServer:
	default:
		return mappedEvent{}
	}
	if chat.User == "" {
		return mappedEvent{}
	}

	result := mappedEvent{}
	if chat.IsBot() {
		result.room = defaultRoom(chat)
	}
	if evt.IsViewOnce || evt.IsViewOnceV2 || evt.IsViewOnceV2Extension {
		return result
	}
	content := evt.RawMessage
	if content == nil {
		content = evt.Message
	}
	content, wrappedEdit := unwrapTextMessage(content)
	if content == nil || info.ID == "" || info.Timestamp.IsZero() {
		return result
	}
	sender := info.Sender.ToNonAD()
	if sender.IsEmpty() && !info.IsFromMe && defaultRoom(chat).Kind == "direct" {
		sender = chat
	}

	id, editedAt := info.ID, time.Time{}
	if protocol := content.GetProtocolMessage(); protocol != nil {
		key := protocol.GetKey()
		if protocol.GetType() != waE2E.ProtocolMessage_MESSAGE_EDIT || key.GetID() == "" {
			return result
		}
		content, _ = unwrapTextMessage(protocol.GetEditedMessage())
		matchesEnvelope := (key.FromMe == nil || key.GetFromMe() == info.IsFromMe) &&
			matchesEditJID(key.GetRemoteJID(), chat) && matchesEditJID(key.GetParticipant(), sender)
		// Inbound direct bot edits can carry a receiver-relative key. It
		// identifies only the target ID; keep the room and author from the envelope.
		receiverKey := !info.IsFromMe && info.Sender.ToNonAD() == chat && sender.IsBot() &&
			content.GetRichResponseMessage() != nil && key.GetFromMe() &&
			key.GetParticipant() == "" && key.GetRemoteJID() != "" &&
			slices.ContainsFunc(self, func(own types.JID) bool {
				return matchesEditJID(key.GetRemoteJID(), own.ToNonAD())
			})
		if !matchesEnvelope && !receiverKey {
			return result
		}
		id, editedAt = key.GetID(), info.MsgBotInfo.EditSenderTimestampMS
		if ms := protocol.GetTimestampMS(); ms > 0 {
			editedAt = time.UnixMilli(ms)
		} else if editedAt.IsZero() {
			editedAt = info.Timestamp
		}
		if target := info.MsgBotInfo.EditTargetID; target != "" && target != id {
			return result
		}
	} else {
		switch info.MsgBotInfo.EditType {
		case types.EditTypeInner, types.EditTypeLast, types.EditTypeFull:
			if !info.Sender.ToNonAD().IsBot() || info.IsFromMe {
				return result
			}
			if target := info.MsgBotInfo.EditTargetID; target != "" {
				id = target
			} else if !wrappedEdit && !evt.IsEdit && info.Edit != types.EditAttributeMessageEdit {
				return result
			}
			editedAt = info.MsgBotInfo.EditSenderTimestampMS
			if editedAt.IsZero() {
				editedAt = info.Timestamp
			}
		default:
			if wrappedEdit || evt.IsEdit || info.Edit == types.EditAttributeMessageEdit {
				editedAt = info.Timestamp
			}
		}
	}
	text, reply := displayText(content)
	attachment, caption, mediaReply, media, isMedia := mediaMetadata(content)
	if isMedia {
		text, reply = caption, mediaReply
	}
	if strings.TrimSpace(text) == "" && !isMedia {
		return result
	}
	room := defaultRoom(chat)
	if name := strings.TrimSpace(info.PushName); !info.IsFromMe && name != "" && sender == chat && !chat.IsBot() && room.Kind == "direct" {
		room.Title = name
	}
	name := strings.TrimSpace(info.PushName)
	switch {
	case info.IsFromMe:
		name = "You"
	case name != "":
	case sender.IsBot():
		name = "Meta AI bot"
	default:
		name = "WhatsApp sender"
	}
	msg := Message{
		ID: id, RoomID: room.ID, SenderID: sender.String(), Sender: name,
		Text: text, Kind: "text", SentAt: formatStoreTime(info.Timestamp),
		FromMe: info.IsFromMe, ReplyTo: reply,
		raw: proto.CloneOf(content),
	}
	if isMedia {
		msg.Kind = "media"
		if hasMediaLocation(media) {
			attachment.ID = mediaID(room.ID, id)
			msg.Attachments = []Attachment{attachment}
		}
	}
	if !editedAt.IsZero() {
		msg.EditedAt = formatStoreTime(editedAt)
	}
	if msg.FromMe && evt.SourceWebMsg != nil {
		switch evt.SourceWebMsg.GetStatus() {
		case waWeb.WebMessageInfo_SERVER_ACK:
			msg.DeliveryStatus = "sent"
		case waWeb.WebMessageInfo_DELIVERY_ACK:
			msg.DeliveryStatus = "delivered"
		case waWeb.WebMessageInfo_READ, waWeb.WebMessageInfo_PLAYED:
			msg.DeliveryStatus = "read"
		default:
			// No confirmed outbound receipt.
		}
		for _, r := range evt.SourceWebMsg.GetUserReceipt() {
			switch {
			case r.GetReadTimestamp() > 0 || r.GetPlayedTimestamp() > 0:
				msg.DeliveryStatus = "read"
			case r.GetReceiptTimestamp() > 0 && receiptRank(msg.DeliveryStatus) < receiptRank("delivered"):
				msg.DeliveryStatus = "delivered"
			}
		}
	}
	return mappedEvent{room: room, message: &msg}
}

func matchesEditJID(raw string, expected types.JID) bool {
	if raw == "" {
		return true
	}
	actual, err := types.ParseJID(raw)
	return err == nil && !expected.IsEmpty() && actual.ToNonAD() == expected
}

func unwrapTextMessage(msg *waE2E.Message) (*waE2E.Message, bool) {
	edited := false
	for range 16 {
		switch {
		case msg == nil, msg.GetViewOnceMessage() != nil, msg.GetViewOnceMessageV2() != nil,
			msg.GetViewOnceMessageV2Extension() != nil:
			return nil, false
		case msg.GetDeviceSentMessage() != nil:
			msg = msg.GetDeviceSentMessage().GetMessage()
		case msg.GetBotInvokeMessage() != nil:
			msg = msg.GetBotInvokeMessage().GetMessage()
		case msg.GetEphemeralMessage() != nil:
			msg = msg.GetEphemeralMessage().GetMessage()
		case msg.GetDocumentWithCaptionMessage() != nil:
			msg = msg.GetDocumentWithCaptionMessage().GetMessage()
		case msg.GetEditedMessage() != nil:
			edited = true
			msg = msg.GetEditedMessage().GetMessage()
		default:
			return msg, edited
		}
	}
	return nil, false
}

func displayText(msg *waE2E.Message) (text, reply string) {
	switch {
	case msg == nil, msg.GetProtocolMessage() != nil, msg.GetReactionMessage() != nil:
		return "", ""
	case msg.GetRichResponseMessage() != nil:
		rich := msg.GetRichResponseMessage()
		data := rich.GetUnifiedResponse().GetData()
		if !utf8.Valid(data) {
			return "", ""
		}
		var payload struct {
			Sections []json.RawMessage `json:"sections"`
		}
		if err := json.Unmarshal(data, &payload); err != nil {
			return "", ""
		}
		var lines []string
		for _, raw := range payload.Sections {
			var section struct {
				ViewModel struct {
					Primitive struct {
						Text string `json:"text"`
					} `json:"primitive"`
				} `json:"view_model"`
			}
			if err := json.Unmarshal(raw, &section); err == nil && strings.TrimSpace(section.ViewModel.Primitive.Text) != "" {
				lines = append(lines, section.ViewModel.Primitive.Text)
			}
		}
		return strings.Join(lines, "\n"), rich.GetContextInfo().GetStanzaID()
	case msg.GetExtendedTextMessage() != nil:
		ext := msg.GetExtendedTextMessage()
		return ext.GetText(), ext.GetContextInfo().GetStanzaID()
	default:
		return msg.GetConversation(), ""
	}
}
