package main

import (
	"maps"
	"reflect"
	"slices"
	"strings"
	"time"

	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	"google.golang.org/protobuf/proto"
)

type roomLabel struct {
	Name string    `json:"name,omitempty"`
	At   time.Time `json:"at,omitzero"`
}

type roomMeta struct {
	Archived      bool      `json:"archived,omitempty"`
	ArchiveAt     time.Time `json:"archiveAt,omitzero"`
	Left          bool      `json:"left,omitempty"`
	MemberAt      time.Time `json:"memberAt,omitzero"`
	Observed      bool      `json:"observed,omitempty"`
	Subject       roomLabel `json:"subject,omitzero"`
	Contact       roomLabel `json:"contact,omitzero"`
	Push          roomLabel `json:"push,omitzero"`
	Verified      roomLabel `json:"verified,omitzero"`
	Alias         string    `json:"alias,omitempty"`
	AliasConflict bool      `json:"aliasConflict,omitempty"`
}

func (label *roomLabel) update(name string, at time.Time) {
	if !at.Before(label.At) {
		*label = roomLabel{Name: name, At: at}
	}
}

func (s *Store) roomTitle(entry cachedRoom, jid types.JID) string {
	if jid.Server == types.GroupServer {
		for _, name := range []string{entry.Meta.Subject.Name, entry.Room.Title} {
			if name != "" && name != "WhatsApp group" {
				return name
			}
		}
		return jid.User
	}
	meta, alternate := entry.Meta, s.rooms[entry.Meta.Alias].Meta
	if meta.AliasConflict || alternate.AliasConflict || alternate.Alias != jid.String() {
		meta.Alias, alternate = "", roomMeta{}
	}
	chatName := entry.Room.Title
	if chatName == defaultRoom(jid).Title {
		chatName = ""
	}
	push, otherPush := meta.Push, alternate.Push
	if otherPush.At.After(push.At) {
		push, otherPush = otherPush, push
	}
	alias, _ := types.ParseJID(meta.Alias)
	names := []string{meta.Contact.Name, alternate.Contact.Name, chatName, push.Name, otherPush.Name, meta.Verified.Name, alternate.Verified.Name}
	if jid.IsBot() {
		names = []string{chatName, meta.Contact.Name, meta.Verified.Name, push.Name}
	}
	for _, name := range names {
		if name != "" && name != jid.String() && name != jid.User && name != meta.Alias && name != alias.User {
			return name
		}
	}
	if jid.IsBot() {
		return "Meta AI bot"
	}
	if alias.Server == types.DefaultUserServer {
		return alias.User
	}
	return jid.User
}

// botSender runs under a store lock and projects the current bot contact name
// without changing the message's original author or rewriting stored history.
func (s *Store) botSender(msg Message) string {
	if !msg.FromMe {
		if jid, err := types.ParseJID(msg.SenderID); err == nil && jid.IsBot() {
			name := s.roomTitle(s.rooms[msg.SenderID], jid)
			if name != defaultRoom(jid).Title {
				return name
			}
		}
	}
	return msg.Sender
}

func (s *Store) PutRoom(room Room) error {
	return s.updateRoom(room, nil)
}

func (s *Store) updateRoom(room Room, update func(*roomMeta)) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return &APIError{Code: "INTERNAL"}
	}
	if room.ID == "" || room.Unread < 0 || (room.LastActivityAt != "" && parseStoreTime(room.LastActivityAt).IsZero()) {
		return &APIError{Code: "INVALID_REQUEST"}
	}
	entry := s.rooms[room.ID]
	if cutoff := s.deletions[room.ID]; !cutoff.IsZero() &&
		(s.roomDeleted(room.ID) || (room.LastActivityAt != "" && !parseStoreTime(room.LastActivityAt).After(cutoff))) {
		return nil
	}
	if entry.Room.ID == "" || room.Kind != "" || update == nil {
		room.Avatar = ""
		mergeRoom(&entry, cloneRoom(room))
	}
	if update != nil {
		update(&entry.Meta)
	}
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

func (s *Store) Apply(evt *events.Message, live bool, self ...types.JID) error {
	mapped := mapMessageEvent(evt, self...)
	if mapped.room.ID == "" {
		return nil
	}
	if mapped.message == nil {
		content := evt.RawMessage
		if content == nil {
			content = evt.Message
		}
		content, wrappedEdit := unwrapTextMessage(content)
		original := !evt.IsEdit && !wrappedEdit && evt.Info.Edit == types.EditAttributeEmpty &&
			evt.Info.MsgBotInfo.EditType == "" && content.GetProtocolMessage() == nil && content.GetReactionMessage() == nil
		return s.observeRoom(mapped.room, evt.Info.Timestamp, live && evt.Info.ID != "" && original)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return &APIError{Code: "INTERNAL"}
	}
	var push roomLabel
	chat := evt.Info.Chat.ToNonAD()
	sender := evt.Info.Sender.ToNonAD()
	if !evt.Info.IsFromMe && chat.Server != types.GroupServer && (sender == chat || sender.IsEmpty()) {
		push = roomLabel{Name: strings.TrimSpace(evt.Info.PushName), At: evt.Info.Timestamp}
	}
	// The mapper's room title may be a PushName. Keep it separate from
	// conversation metadata so a later personal label can outrank it.
	return s.put(*mapped.message, messageRoom{Room: defaultRoom(chat), Push: push}, live)
}

func (s *Store) observeRoom(room Room, at time.Time, live bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return &APIError{Code: "INTERNAL"}
	}
	if !canonicalRoom.MatchString(room.ID) {
		return nil
	}
	if cutoff := s.deletions[room.ID]; !cutoff.IsZero() && (!live || !at.After(cutoff)) {
		return nil
	}
	entry := s.rooms[room.ID]
	if entry.Room.ID == "" {
		entry.Room = room
	}
	if live && at.After(parseStoreTime(entry.Room.LastActivityAt)) {
		entry.Room.LastActivityAt = formatStoreTime(at)
	} else if entry.Meta.Observed {
		return nil
	}
	entry.Meta.Observed = true
	return s.commit(entry)
}

// roomDeleted is used under the room lock. The cutoff remains after reopening
// so that a later replay cannot restore deleted messages to an active room.
func (s *Store) roomDeleted(id string) bool {
	cutoff := s.deletions[id]
	return !cutoff.IsZero() && !parseStoreTime(s.rooms[id].Room.LastActivityAt).After(cutoff)
}

func (s *Store) deleteChat(id string, cutoff time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return &APIError{Code: "INTERNAL"}
	}
	if !canonicalRoom.MatchString(id) || cutoff.IsZero() || !cutoff.After(s.deletions[id]) {
		return nil
	}
	previous, existed := s.rooms[id]
	before := s.deletions
	s.deletions = maps.Clone(before)
	if s.deletions == nil {
		s.deletions = make(map[string]time.Time)
	}
	s.deletions[id] = cutoff.UTC()
	if len(s.deletions) > storeDeletionLimit {
		oldest := id
		for candidate, at := range s.deletions {
			if order := at.Compare(s.deletions[oldest]); order < 0 || (order == 0 && candidate < oldest) {
				oldest = candidate
			}
		}
		delete(s.deletions, oldest)
	}

	entry := previous
	entry.Messages = slices.DeleteFunc(slices.Clone(entry.Messages), func(msg Message) bool {
		return !parseStoreTime(msg.SentAt).After(cutoff)
	})
	if len(entry.Messages) == 0 {
		delete(s.rooms, id)
	} else {
		entry.Raw = maps.Clone(entry.Raw)
		pruneRaw(&entry)
		entry.Room.Unread = 0
		setPreview(&entry.Room, entry.Messages[len(entry.Messages)-1])
		s.rooms[id] = entry
	}
	if err := s.save(); err != nil {
		s.deletions = before
		if existed {
			s.rooms[id] = previous
		}
		return err
	}
	return nil
}

func (s *Store) Put(msg Message, live bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return &APIError{Code: "INTERNAL"}
	}
	return s.put(msg, messageRoom{Room: Room{ID: msg.RoomID}}, live)
}

type messageRoom struct {
	Room Room
	Push roomLabel
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
func (s *Store) put(msg Message, room messageRoom, live bool) error {
	if !validStoredMessage(msg) {
		return &APIError{Code: "INVALID_REQUEST"}
	}
	if cutoff := s.deletions[msg.RoomID]; !cutoff.IsZero() && !parseStoreTime(msg.SentAt).After(cutoff) {
		return nil
	}
	entry := s.rooms[msg.RoomID]
	before := entry.Meta
	entry.Meta.Push.accept(room.Push)
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
		editOrder := editedAt.Compare(parseStoreTime(old.EditedAt))
		sender, _ := types.ParseJID(msg.SenderID)
		// Bot snapshots can share a timestamp. A distinct live revision wins
		// in receive order; the equality check below still drops exact repeats.
		if msg.EditedAt != "" && !editedAt.Before(parseStoreTime(old.SentAt)) &&
			(editOrder > 0 || (editOrder == 0 && live && !msg.FromMe && sender.IsBot())) {
			updated.Text, updated.Kind, updated.EditedAt = msg.Text, msg.Kind, msg.EditedAt
			updated.Attachments, updated.ReplyTo, updated.raw = msg.Attachments, msg.ReplyTo, msg.raw
		}
		receiptAdvanced := receiptRank(msg.DeliveryStatus) > receiptRank(old.DeliveryStatus)
		if receiptAdvanced {
			updated.DeliveryStatus = msg.DeliveryStatus
		}
		oldPublic, updatedPublic := old, updated
		oldPublic.raw, updatedPublic.raw = nil, nil
		if proto.Equal(old.raw, updated.raw) && reflect.DeepEqual(oldPublic, updatedPublic) {
			if before != entry.Meta {
				return s.commit(entry)
			}
			return nil
		}
		entry.Messages[index], msg = updated, updated
		event, emit = "message.edited", live || receiptAdvanced
	} else {
		index, _ = slices.BinarySearchFunc(entry.Messages, msg, compareMessageAge)
		if index == 0 && len(entry.Messages) == storeMessageLimit {
			return nil
		}
		entry.Messages = slices.Insert(entry.Messages, index, msg)
		if len(entry.Messages) > storeMessageLimit {
			entry.Messages = entry.Messages[1:]
			index--
		}
	}
	if msg.raw != nil || len(entry.Raw) > 0 {
		entry.Raw = maps.Clone(entry.Raw)
		if msg.raw == nil {
			delete(entry.Raw, msg.ID)
		} else {
			if entry.Raw == nil {
				entry.Raw = make(rawPayloads)
			}
			entry.Raw[msg.ID] = proto.CloneOf(msg.raw)
		}
		pruneRaw(&entry)
	}
	msg.Attachments = slices.Clone(msg.Attachments)
	msg.SenderAvatar = ""
	entry.Messages[index] = msg
	entry.Messages[index].raw = entry.Raw[msg.ID]
	if entry.Room.ID == "" {
		mergeRoom(&entry, room.Room)
	}
	if newest := entry.Messages[len(entry.Messages)-1]; newest.ID == msg.ID &&
		!parseStoreTime(msg.SentAt).Before(parseStoreTime(entry.Room.LastActivityAt)) {
		setPreview(&entry.Room, msg)
	}
	if err := s.commit(entry); err != nil {
		return err
	}
	if emit && s.rooms[msg.RoomID].Room.ID != "" {
		msg.Sender = s.botSender(msg)
		s.publish(Update{Event: event, Message: &msg})
	}
	return nil
}

func (label *roomLabel) accept(incoming roomLabel) {
	if incoming.Name != "" {
		label.update(incoming.Name, incoming.At)
	}
}

func setPreview(room *Room, msg Message) {
	room.LastActivityAt = msg.SentAt
	text := msg.Text
	count := 0
	for i := range text {
		if count == 200 {
			text = text[:i]
			break
		}
		count++
	}
	room.LastMessage = &Preview{Text: text, FromMe: msg.FromMe}
}

func cloneMessage(msg Message) Message {
	msg.Attachments = slices.Clone(msg.Attachments)
	msg.raw = proto.CloneOf(msg.raw)
	return msg
}

func pruneRaw(entry *cachedRoom) {
	for id := range entry.Raw {
		if !slices.ContainsFunc(entry.Messages, func(msg Message) bool { return msg.ID == id }) {
			delete(entry.Raw, id)
		}
	}
}

func (s *Store) revoke(roomID, id string, live bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return &APIError{Code: "INTERNAL"}
	}
	entry := s.rooms[roomID]
	index := slices.IndexFunc(entry.Messages, func(msg Message) bool { return msg.ID == id })
	if index < 0 {
		return nil
	}
	entry.Raw = maps.Clone(entry.Raw)
	delete(entry.Raw, id)
	entry.Messages = slices.Delete(slices.Clone(entry.Messages), index, index+1)
	if index == len(entry.Messages) {
		entry.Room.LastMessage = nil
		if len(entry.Messages) > 0 {
			setPreview(&entry.Room, entry.Messages[len(entry.Messages)-1])
		}
	}
	if err := s.commit(entry); err != nil {
		return err
	}
	if live {
		s.publish(Update{Event: "message.deleted", RoomID: roomID, MessageIDs: []string{id}})
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
			msg := cloneMessage(*update.Message)
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
