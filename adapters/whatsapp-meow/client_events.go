package main

import (
	"context"
	"fmt"
	"os"
	"slices"
	"strings"
	"time"

	"go.mau.fi/whatsmeow/proto/waE2E"
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
		if l.client != nil && l.client.Store != nil {
			err = l.store.hydrateRooms(ctx, l.client.Store, l.client)
		}
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
		err = l.applyMessage(e, true)
	case *events.HistorySync:
		err = l.history(e)
	case *events.UndecryptableMessage:
		if chat := e.Info.Chat.ToNonAD(); chat.IsBot() {
			err = l.store.updateRoom(Room{ID: chat.String()}, func(meta *roomMeta) {
				meta.Observed = true
			})
		}
	case *events.JoinedGroup:
		err = l.store.updateRoom(Room{ID: e.JID.String()}, func(meta *roomMeta) {
			meta.Observed, meta.Left = true, false
			meta.MemberAt = time.Now().Truncate(time.Second)
			meta.Subject.accept(roomLabel{Name: strings.TrimSpace(e.Name), At: e.NameSetAt})
		})
	case *events.GroupInfo:
		left := e.Delete != nil
		if l.client != nil && l.client.Store != nil {
			own, lid := l.client.Store.GetJID().ToNonAD(), l.client.Store.GetLID().ToNonAD()
			left = left || slices.ContainsFunc(e.Leave, func(member types.JID) bool {
				member = member.ToNonAD()
				return !member.IsEmpty() && (member == own || member == lid)
			})
		}
		if left || e.Name != nil {
			err = l.store.updateRoom(Room{ID: e.JID.String()}, func(meta *roomMeta) {
				if left && !e.Timestamp.Before(meta.MemberAt) {
					meta.Left, meta.MemberAt = true, e.Timestamp
				}
				if e.Name != nil {
					at := e.Name.NameSetAt
					if at.IsZero() {
						at = e.Timestamp
					}
					meta.Subject.accept(roomLabel{Name: strings.TrimSpace(e.Name.Name), At: at})
				}
			})
		}
	case *events.PushName:
		var at time.Time
		if e.Message != nil {
			if e.Message.IsFromMe {
				break
			}
			at = e.Message.Timestamp
		}
		err = l.store.updateLabel(e.JID, e.JIDAlt, func(meta *roomMeta) {
			meta.Push.accept(roomLabel{Name: strings.TrimSpace(e.NewPushName), At: at})
		})
	case *events.Contact:
		name := strings.TrimSpace(e.Action.GetFullName())
		if name == "" {
			name = strings.TrimSpace(e.Action.GetFirstName())
		}
		alt := e.Action.GetLidJID()
		if e.JID.Server == types.HiddenUserServer {
			alt = e.Action.GetPnJID()
		}
		alias, _ := types.ParseJID(alt)
		err = l.store.updateLabel(e.JID, alias, func(meta *roomMeta) {
			if name != "" || e.Action == nil {
				meta.Contact.update(name, e.Timestamp)
			}
		})
	case *events.BusinessName:
		err = l.store.updateLabel(e.JID, types.EmptyJID, func(meta *roomMeta) {
			var at time.Time
			if e.Message != nil {
				at = e.Message.Timestamp
			}
			meta.Verified.accept(roomLabel{Name: strings.TrimSpace(e.NewBusinessName), At: at})
		})
	case *events.Archive:
		if chat := e.JID.ToNonAD(); e.Action != nil && canonicalRoom.MatchString(chat.String()) {
			err = l.store.updateRoom(Room{ID: chat.String()}, func(meta *roomMeta) {
				if !e.Timestamp.Before(meta.ArchiveAt) {
					meta.Archived, meta.ArchiveAt = e.Action.GetArchived(), e.Timestamp
				}
			})
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

func (l *link) applyMessage(event *events.Message, live bool) error {
	content := event.RawMessage
	if content == nil {
		content = event.Message
	}
	content, _ = unwrapTextMessage(content)
	if protocol := content.GetProtocolMessage(); protocol != nil && protocol.GetType() == waE2E.ProtocolMessage_REVOKE {
		chat := event.Info.Chat.ToNonAD()
		key := protocol.GetKey()
		if key.GetID() != "" && canonicalRoom.MatchString(chat.String()) && matchesEditJID(key.GetRemoteJID(), chat) {
			return l.store.revoke(chat.String(), key.GetID(), live)
		}
		return nil
	}
	if l.client != nil && l.client.Store != nil {
		return l.store.Apply(event, live, l.client.Store.GetJID(), l.client.Store.GetLID())
	}
	return l.store.Apply(event, live)
}

func personalAlias(jid, alias types.JID) bool {
	return jid.Server == types.DefaultUserServer && alias.Server == types.HiddenUserServer ||
		jid.Server == types.HiddenUserServer && alias.Server == types.DefaultUserServer
}

func (s *Store) updateLabel(jid, alias types.JID, update func(*roomMeta)) error {
	jid, alias = jid.ToNonAD(), alias.ToNonAD()
	if jid.Server == types.GroupServer || !canonicalRoom.MatchString(jid.String()) {
		return nil
	}
	linked := personalAlias(jid, alias) && canonicalRoom.MatchString(alias.String())
	if err := s.updateRoom(Room{ID: jid.String()}, func(meta *roomMeta) {
		if linked {
			recordAlias(meta, alias.String())
		}
		if update != nil {
			update(meta)
		}
	}); err != nil || !linked {
		return err
	}
	return s.updateRoom(Room{ID: alias.String()}, func(meta *roomMeta) {
		recordAlias(meta, jid.String())
	})
}

func recordAlias(meta *roomMeta, id string) {
	if meta.Alias != "" && meta.Alias != id {
		meta.AliasConflict = true
	}
	meta.Alias = id
}

func (l *link) history(event *events.HistorySync) error {
	for _, pushed := range event.Data.GetPushnames() {
		jid, err := types.ParseJID(pushed.GetID())
		if err == nil {
			if err = l.store.updateLabel(jid, types.EmptyJID, func(meta *roomMeta) {
				meta.Push.accept(roomLabel{Name: strings.TrimSpace(pushed.GetPushname())})
			}); err != nil {
				return err
			}
		}
	}
	for _, conversation := range event.Data.GetConversations() {
		jid, err := types.ParseJID(conversation.GetID())
		if err != nil || !canonicalRoom.MatchString(jid.ToNonAD().String()) {
			continue
		}
		jid = jid.ToNonAD()
		kind := "direct"
		if jid.Server == types.GroupServer {
			kind = "group"
		}
		name := strings.TrimSpace(conversation.GetName())
		if name == "" {
			name = strings.TrimSpace(conversation.GetDisplayName())
		}
		room := Room{
			ID: jid.String(), Title: name,
			Kind: kind, Unread: int(conversation.GetUnreadCount()),
		}
		if at := conversation.GetConversationTimestamp(); at > 0 {
			room.LastActivityAt = time.Unix(int64(at), 0).UTC().Format(time.RFC3339)
		}
		if err = l.store.updateRoom(room, func(meta *roomMeta) {
			if meta.ArchiveAt.IsZero() && conversation.Archived != nil {
				meta.Archived = conversation.GetArchived()
			}
			if kind == "group" && meta.MemberAt.IsZero() && conversation.ReadOnly != nil {
				meta.Left = conversation.GetReadOnly()
			}
		}); err != nil {
			return err
		}
		alt := conversation.GetLidJID()
		if jid.Server == types.HiddenUserServer {
			alt = conversation.GetPnJID()
		}
		if alias, parseErr := types.ParseJID(alt); parseErr == nil && personalAlias(jid, alias) {
			if err = l.store.updateLabel(jid, alias, nil); err != nil {
				return err
			}
		}
		for _, item := range conversation.GetMessages() {
			message, parseErr := l.client.ParseWebMessage(jid, item.GetMessage())
			if parseErr != nil {
				continue
			}
			if err = l.applyMessage(message, false); err != nil {
				return err
			}
		}
	}
	return nil
}
