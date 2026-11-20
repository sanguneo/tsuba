package main

import (
	"cmp"
	"encoding/json"
	"errors"
	"io"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"time"

	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"
	"google.golang.org/protobuf/proto"
)

const (
	storeRoomLimit        = 500
	storeDeletionLimit    = 500
	storeMessageLimit     = 200
	storeDiskMessageLimit = 50
	storeDiskByteLimit    = 128 << 20
)

var (
	errPrivateCache = errors.New("cache requires a private directory and file")
	errCorruptCache = errors.New("invalid message cache")
)

type cachedRoom struct {
	Room     Room        `json:"room"`
	Messages []Message   `json:"messages"`
	Meta     roomMeta    `json:"meta,omitzero"`
	Raw      rawPayloads `json:"raw,omitempty"`
}

// Wire protobuf preserves nested oneofs and fields unknown to the pinned SDK.
type rawPayloads map[string]*waE2E.Message

func (r rawPayloads) MarshalJSON() ([]byte, error) {
	encoded := make(map[string][]byte, len(r))
	for id, message := range r {
		payload, err := proto.MarshalOptions{AllowPartial: true}.Marshal(message)
		if err != nil {
			return nil, err
		}
		encoded[id] = payload
	}
	return json.Marshal(encoded)
}

func (r *rawPayloads) UnmarshalJSON(data []byte) error {
	var encoded map[string][]byte
	if err := json.Unmarshal(data, &encoded); err != nil {
		return err
	}
	decoded := make(rawPayloads, len(encoded))
	for id, payload := range encoded {
		message := &waE2E.Message{}
		if err := (proto.UnmarshalOptions{AllowPartial: true}).Unmarshal(payload, message); err != nil {
			return err
		}
		decoded[id] = message
	}
	*r = decoded
	return nil
}

type cacheSnapshot struct {
	Version   int                  `json:"version"`
	Rooms     []cachedRoom         `json:"rooms"`
	Deletions map[string]time.Time `json:"deletions,omitempty"`
}

type Store struct {
	mu        sync.RWMutex
	path      string
	rooms     map[string]cachedRoom
	deletions map[string]time.Time
	subs      map[chan Update]struct{}
	closed    bool
}

func NewStore(path string) (*Store, error) {
	s := &Store{path: path, rooms: make(map[string]cachedRoom), subs: make(map[chan Update]struct{})}
	if path == "" {
		return s, nil
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	info, err := os.Lstat(dir)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() || info.Mode().Perm() != 0o700 {
		return nil, errPrivateCache
	}
	info, err = os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return s, nil
	}
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Mode().Perm() != 0o600 {
		return nil, errPrivateCache
	}
	if info.Size() > storeDiskByteLimit {
		return nil, errCorruptCache
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	d := json.NewDecoder(io.LimitReader(f, storeDiskByteLimit+1))
	d.DisallowUnknownFields()
	var snapshot cacheSnapshot
	decodeErr := d.Decode(&snapshot)
	var trailing json.RawMessage
	extraErr := d.Decode(&trailing)
	closeErr := f.Close()
	if decodeErr != nil || extraErr != io.EOF || snapshot.Version != 1 ||
		snapshot.Rooms == nil || len(snapshot.Rooms) > storeRoomLimit {
		return nil, errCorruptCache
	}
	if closeErr != nil {
		return nil, closeErr
	}
	if len(snapshot.Deletions) > storeDeletionLimit {
		return nil, errCorruptCache
	}
	for id, cutoff := range snapshot.Deletions {
		if !canonicalRoom.MatchString(id) || cutoff.IsZero() {
			return nil, errCorruptCache
		}
	}
	s.deletions = snapshot.Deletions
	for _, entry := range snapshot.Rooms {
		id := entry.Room.ID
		_, duplicateRoom := s.rooms[id]
		if id == "" || entry.Room.Title == "" || entry.Room.Unread < 0 ||
			(entry.Room.LastActivityAt != "" && parseStoreTime(entry.Room.LastActivityAt).IsZero()) ||
			duplicateRoom || len(entry.Messages) > storeDiskMessageLimit {
			return nil, errCorruptCache
		}
		ids := make(map[string]bool, len(entry.Messages))
		for i, msg := range entry.Messages {
			if !validStoredMessage(msg) || msg.RoomID != id || ids[msg.ID] {
				return nil, errCorruptCache
			}
			ids[msg.ID] = true
			entry.Messages[i].raw = entry.Raw[msg.ID]
			entry.Messages[i].SenderAvatar = ""
		}
		for id := range entry.Raw {
			if !ids[id] {
				return nil, errCorruptCache
			}
		}
		slices.SortFunc(entry.Messages, compareMessageAge)
		entry.Room.Avatar = ""
		s.rooms[id] = entry
	}
	return s, nil
}

// commit is called with the write lock held. No state or event is visible
// until the corresponding snapshot has replaced the old one.
func (s *Store) commit(entry cachedRoom) error {
	id := entry.Room.ID
	previous, existed := s.rooms[id]
	s.rooms[id] = entry
	var oldest string
	if len(s.rooms) > storeRoomLimit {
		ordered := s.orderedRooms()
		oldest = ordered[len(ordered)-1].Room.ID
	}
	if err := s.save(); err != nil {
		if existed {
			s.rooms[id] = previous
		} else {
			delete(s.rooms, id)
		}
		return err
	}
	delete(s.rooms, oldest)
	return nil
}

// save writes a bounded snapshot while the caller holds the write lock.
func (s *Store) save() error {
	if s.path == "" {
		return nil
	}
	snapshot := cacheSnapshot{Version: 1, Rooms: s.orderedRooms(), Deletions: s.deletions}
	if snapshot.Rooms == nil {
		snapshot.Rooms = []cachedRoom{}
	}
	snapshot.Rooms = snapshot.Rooms[:min(len(snapshot.Rooms), storeRoomLimit)]
	for i, item := range snapshot.Rooms {
		item.Messages = item.Messages[max(0, len(item.Messages)-storeDiskMessageLimit):]
		item.Raw = maps.Clone(item.Raw)
		pruneRaw(&item)
		snapshot.Rooms[i] = item
	}
	return writeCache(s.path, snapshot)
}

func writeCache(path string, snapshot cacheSnapshot) (err error) {
	f, err := os.CreateTemp(filepath.Dir(path), ".messages-*")
	if err != nil {
		return err
	}
	defer func() {
		if err != nil {
			if cleanup := os.Remove(f.Name()); !errors.Is(cleanup, os.ErrNotExist) {
				err = errors.Join(err, cleanup)
			}
		}
	}()
	err = json.NewEncoder(f).Encode(snapshot)
	if err == nil {
		var size int64
		size, err = f.Seek(0, io.SeekCurrent)
		if err == nil && size > storeDiskByteLimit {
			err = errCorruptCache
		}
	}
	if err == nil {
		err = f.Sync()
	}
	if err = errors.Join(err, f.Close()); err != nil {
		return err
	}
	return os.Rename(f.Name(), path)
}

func (s *Store) orderedRooms() []cachedRoom {
	rooms := slices.Collect(maps.Values(s.rooms))
	slices.SortFunc(rooms, func(a, b cachedRoom) int {
		if order := parseStoreTime(b.Room.LastActivityAt).Compare(parseStoreTime(a.Room.LastActivityAt)); order != 0 {
			return order
		}
		return cmp.Compare(a.Room.ID, b.Room.ID)
	})
	return rooms
}

func cloneRoom(room Room) Room {
	room.Features = maps.Clone(room.Features)
	if room.LastMessage != nil {
		preview := *room.LastMessage
		room.LastMessage = &preview
	}
	return room
}

func (s *Store) Rooms() []Room {
	s.mu.RLock()
	defer s.mu.RUnlock()
	ordered := s.orderedRooms()
	rooms := make([]Room, 0, len(ordered))
	for _, entry := range ordered {
		jid, err := types.ParseJID(entry.Room.ID)
		if err != nil || !canonicalRoom.MatchString(entry.Room.ID) ||
			entry.Meta.Archived || entry.Meta.Left ||
			s.roomDeleted(entry.Room.ID) ||
			(len(entry.Messages) == 0 && entry.Room.LastActivityAt == "" && !entry.Meta.Observed) {
			continue
		}
		room := cloneRoom(entry.Room)
		room.Title = s.roomTitle(entry, jid)
		rooms = append(rooms, room)
	}
	return rooms
}

func (s *Store) Page(roomID string, limit int, before string) ([]Message, bool, error) {
	if limit < 1 {
		return nil, false, &APIError{Code: "INVALID_REQUEST"}
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	entry, exists := s.rooms[roomID]
	if !exists {
		return nil, false, &APIError{Code: "NOT_FOUND"}
	}
	end := len(entry.Messages)
	if before != "" {
		end = slices.IndexFunc(entry.Messages, func(msg Message) bool { return msg.ID == before })
		if end < 0 {
			return nil, false, &APIError{Code: "NOT_FOUND"}
		}
	}
	start := max(0, end-limit)
	page := append([]Message{}, entry.Messages[start:end]...)
	for i, msg := range page {
		page[i] = cloneMessage(msg)
		page[i].Sender = s.botSender(msg)
	}
	return page, start > 0, nil
}

func (s *Store) Find(roomID, id string) (Message, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, msg := range s.rooms[roomID].Messages {
		if msg.ID == id {
			msg = cloneMessage(msg)
			msg.Sender = s.botSender(msg)
			return msg, true
		}
	}
	return Message{}, false
}

func (s *Store) Raw(roomID, id string) *waE2E.Message {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return proto.CloneOf(s.rooms[roomID].Raw[id])
}

func compareMessageAge(a, b Message) int {
	if order := parseStoreTime(a.SentAt).Compare(parseStoreTime(b.SentAt)); order != 0 {
		return order
	}
	return cmp.Compare(a.ID, b.ID)
}
