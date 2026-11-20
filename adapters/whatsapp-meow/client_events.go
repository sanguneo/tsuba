package main

import (
	"context"
	"fmt"
	"os"
	"time"

	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
)

// Upstream dispatches extensible events as any. Keep that boundary here, never
// pass unknown SDK variants into the domain store.
func (l *link) handle(ctx context.Context, event any) {
	var err error
	switch e := event.(type) {
	case *events.Connected:
		l.setState("open")
	case *events.Disconnected:
		if l.State() == "open" {
			l.setState("connecting")
		}
	case *events.LoggedOut:
		l.setState("logged-out")
	case *events.StreamReplaced:
		l.setState("conflict")
	case *events.TemporaryBan:
		l.setState("forbidden")
	case *events.ConnectFailure:
		l.setState("logged-out")
	case *events.Message:
		err = l.store.Apply(e, true)
	case *events.HistorySync:
		err = l.history(e)
	case *events.UndecryptableMessage:
		if e.Info.Chat.IsBot() {
			err = l.store.PutRoom(Room{ID: e.Info.Chat.String(), Kind: "direct"})
		}
	case *events.JoinedGroup:
		err = l.store.PutRoom(Room{ID: e.JID.String(), Title: e.Name, Kind: "group"})
	case *events.GroupInfo:
		if e.Name != nil {
			err = l.store.PutRoom(Room{ID: e.JID.String(), Title: e.Name.Name, Kind: "group"})
		}
	case *events.PushName:
		err = l.store.PutRoom(Room{ID: e.JID.String(), Title: e.NewPushName, Kind: "direct"})
	case *events.Contact:
		if e.Action != nil {
			name := e.Action.GetFullName()
			if name == "" {
				name = e.Action.GetFirstName()
			}
			err = l.store.PutRoom(Room{ID: e.JID.String(), Title: name, Kind: "direct"})
		}
	case *events.Receipt:
		status := ""
		switch e.Type {
		case types.ReceiptTypeDelivered:
			status = "delivered"
		case types.ReceiptTypeRead, types.ReceiptTypePlayed:
			status = "read"
		}
		if status != "" && !e.IsFromMe {
			err = l.store.Receipt(e.Chat.String(), e.MessageIDs, status)
		}
	}
	if err != nil {
		// Never include SDK error strings, JIDs, names, or message contents.
		fmt.Fprintln(os.Stderr, "whatsapp-meow cache update failed")
	}
}

func (l *link) history(event *events.HistorySync) error {
	for _, conversation := range event.Data.GetConversations() {
		jid, err := types.ParseJID(conversation.GetID())
		if err != nil || !canonicalRoom.MatchString(jid.ToNonAD().String()) {
			continue
		}
		kind := "direct"
		if jid.Server == types.GroupServer {
			kind = "group"
		}
		room := Room{
			ID: jid.String(), Title: conversation.GetName(),
			Kind: kind, Unread: int(conversation.GetUnreadCount()),
		}
		if at := conversation.GetConversationTimestamp(); at > 0 {
			room.LastActivityAt = time.Unix(int64(at), 0).UTC().Format(time.RFC3339)
		}
		if err = l.store.PutRoom(room); err != nil {
			return err
		}
		for _, item := range conversation.GetMessages() {
			message, parseErr := l.client.ParseWebMessage(jid, item.GetMessage())
			if parseErr != nil {
				continue
			}
			if err = l.store.Apply(message, false); err != nil {
				return err
			}
		}
	}
	return nil
}
