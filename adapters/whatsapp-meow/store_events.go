package main

import (
	"slices"

	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
)

func (s *Store) PutRoom(room Room) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return &APIError{Code: "INTERNAL"}
	}
	if room.ID == "" || room.Unread < 0 || (room.LastActivityAt != "" && parseStoreTime(room.LastActivityAt).IsZero()) {
		return &APIError{Code: "INVALID_REQUEST"}
	}
	entry := s.rooms[room.ID]
	mergeRoom(&entry, cloneRoom(room))
	return s.commit(entry)
}

func mergeRoom(entry *cachedRoom, room Room) {
	if entry.Room.ID == "" {
		entry.Room = room
		if entry.Room.Title == "" || entry.Room.Kind == "" {
			chat, err := types.ParseJID(room.ID)
			if err != nil {
				chat = types.EmptyJID
			}
			fallback := defaultRoom(chat)
			if room.Title == "" {
				entry.Room.Title = fallback.Title
			}
			if room.Kind == "" {
				entry.Room.Kind = fallback.Kind
			}
		}
		return
	}
	if room.Title != "" {
		entry.Room.Title = room.Title
	}
	if room.Kind != "" {
		entry.Room.Kind = room.Kind
	}
	entry.Room.Unread = room.Unread
	if room.Features != nil {
		entry.Room.Features = room.Features
	}
	if parseStoreTime(room.LastActivityAt).After(parseStoreTime(entry.Room.LastActivityAt)) {
		entry.Room.LastActivityAt = room.LastActivityAt
		entry.Room.LastMessage = room.LastMessage
	}
}

func (s *Store) Apply(evt *events.Message, live bool) error {
	mapped := mapMessageEvent(evt)
	if mapped.room.ID == "" {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return &APIError{Code: "INTERNAL"}
	}
	if mapped.message == nil {
		if _, exists := s.rooms[mapped.room.ID]; exists {
			return nil
		}
		return s.commit(cachedRoom{Room: mapped.room})
	}
	return s.put(*mapped.message, mapped.room, live)
}

func (s *Store) Put(msg Message, live bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return &APIError{Code: "INTERNAL"}
	}
	return s.put(msg, Room{ID: msg.RoomID}, live)
}

func validStoredMessage(msg Message) bool {
	return msg.ID != "" && msg.RoomID != "" && msg.Sender != "" &&
		(msg.Kind == "text" || msg.Kind == "service" || msg.Kind == "media") &&
		!parseStoreTime(msg.SentAt).IsZero() &&
		(msg.EditedAt == "" || !parseStoreTime(msg.EditedAt).IsZero()) &&
		(msg.DeliveryStatus == "" || (msg.FromMe && receiptRank(msg.DeliveryStatus) > 0))
}

// put runs with the write lock held. Original messages and edits have
// different rules: a replay cannot overwrite text or move a paging anchor.
func (s *Store) put(msg Message, room Room, live bool) error {
	if !validStoredMessage(msg) {
		return &APIError{Code: "INVALID_REQUEST"}
	}
	entry := s.rooms[msg.RoomID]
	index := slices.IndexFunc(entry.Messages, func(existing Message) bool { return existing.ID == msg.ID })
	if index < 0 && msg.EditedAt != "" {
		return nil
	}
	event := "message"
	emit := live
	entry.Messages = slices.Clone(entry.Messages)
	if index >= 0 {
		old := entry.Messages[index]
		if old.FromMe != msg.FromMe || (msg.EditedAt != "" && (old.SenderID == "" || old.SenderID != msg.SenderID)) ||
			(old.SenderID != "" && msg.SenderID != "" && old.SenderID != msg.SenderID) {
			return nil
		}
		updated := old
		editedAt := parseStoreTime(msg.EditedAt)
		if msg.EditedAt != "" && !editedAt.Before(parseStoreTime(old.SentAt)) &&
			editedAt.After(parseStoreTime(old.EditedAt)) {
			updated.Text, updated.Kind, updated.EditedAt = msg.Text, msg.Kind, msg.EditedAt
		}
		receiptAdvanced := receiptRank(msg.DeliveryStatus) > receiptRank(old.DeliveryStatus)
		if receiptAdvanced {
			updated.DeliveryStatus = msg.DeliveryStatus
		}
		if old == updated {
			return nil
		}
		entry.Messages[index], msg = updated, updated
		event, emit = "message.edited", live || receiptAdvanced
	} else {
		index, _ := slices.BinarySearchFunc(entry.Messages, msg, compareMessageAge)
		if index == 0 && len(entry.Messages) == storeMessageLimit {
			return nil
		}
		entry.Messages = slices.Insert(entry.Messages, index, msg)
		if len(entry.Messages) > storeMessageLimit {
			entry.Messages = entry.Messages[1:]
		}
	}
	if entry.Room.ID == "" {
		mergeRoom(&entry, room)
	} else if room.Title != "" {
		chat, err := types.ParseJID(msg.RoomID)
		if err == nil && entry.Room.Title == defaultRoom(chat).Title {
			entry.Room.Title = room.Title
		}
	}
	if newest := entry.Messages[len(entry.Messages)-1]; newest.ID == msg.ID &&
		!parseStoreTime(msg.SentAt).Before(parseStoreTime(entry.Room.LastActivityAt)) {
		entry.Room.LastActivityAt = msg.SentAt
		text := msg.Text
		count := 0
		for i := range text {
			if count == 200 {
				text = text[:i]
				break
			}
			count++
		}
		entry.Room.LastMessage = &Preview{Text: text, FromMe: msg.FromMe}
	}
	if err := s.commit(entry); err != nil {
		return err
	}
	if emit && s.rooms[msg.RoomID].Room.ID != "" {
		s.publish(Update{Event: event, Message: &msg})
	}
	return nil
}

func receiptRank(status string) int {
	switch status {
	case "sent":
		return 1
	case "delivered":
		return 2
	case "read":
		return 3
	default:
		return 0
	}
}

func (s *Store) Receipt(roomID string, ids []string, status string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return &APIError{Code: "INTERNAL"}
	}
	if receiptRank(status) == 0 {
		return &APIError{Code: "INVALID_REQUEST"}
	}
	entry := s.rooms[roomID]
	entry.Messages = slices.Clone(entry.Messages)
	var changed []Message
	for i, msg := range entry.Messages {
		if msg.FromMe && receiptRank(status) > receiptRank(msg.DeliveryStatus) && slices.Contains(ids, msg.ID) {
			msg.DeliveryStatus = status
			entry.Messages[i] = msg
			changed = append(changed, msg)
		}
	}
	if len(changed) == 0 {
		return nil
	}
	if err := s.commit(entry); err != nil {
		return err
	}
	for _, msg := range changed {
		s.publish(Update{Event: "message.edited", Message: &msg})
	}
	return nil
}

func (s *Store) Subscribe() (<-chan Update, func()) {
	ch := make(chan Update, 64)
	s.mu.Lock()
	if s.closed {
		close(ch)
	} else {
		s.subs[ch] = struct{}{}
	}
	s.mu.Unlock()
	return ch, func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		s.unsubscribe(ch)
	}
}

func (s *Store) unsubscribe(ch chan Update) {
	if _, exists := s.subs[ch]; exists {
		delete(s.subs, ch)
		close(ch)
	}
}

func (s *Store) publish(update Update) {
	for ch := range s.subs {
		copy := update
		if update.Message != nil {
			msg := *update.Message
			copy.Message = &msg
		}
		copy.MessageIDs = slices.Clone(update.MessageIDs)
		select {
		case ch <- copy:
		default:
			// Disconnect rather than silently give a client an inconsistent stream.
			s.unsubscribe(ch)
		}
	}
}

func (s *Store) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.closed = true
	for ch := range s.subs {
		s.unsubscribe(ch)
	}
	return nil
}
