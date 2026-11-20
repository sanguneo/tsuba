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
)

const (
	storeRoomLimit        = 500
	storeMessageLimit     = 200
	storeDiskMessageLimit = 50
	storeDiskByteLimit    = 128 << 20
)

var (
	errPrivateCache = errors.New("cache requires a private directory and file")
	errCorruptCache = errors.New("invalid message cache")
)

type cachedRoom struct {
	Room     Room      `json:"room"`
	Messages []Message `json:"messages"`
}

type cacheSnapshot struct {
	Version int          `json:"version"`
	Rooms   []cachedRoom `json:"rooms"`
}

type Store struct {
	mu     sync.RWMutex
	path   string
	rooms  map[string]cachedRoom
	subs   map[chan Update]struct{}
	closed bool
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
	for _, entry := range snapshot.Rooms {
		id := entry.Room.ID
		_, duplicateRoom := s.rooms[id]
		if id == "" || entry.Room.Title == "" || entry.Room.Unread < 0 ||
			(entry.Room.LastActivityAt != "" && parseStoreTime(entry.Room.LastActivityAt).IsZero()) ||
			duplicateRoom || len(entry.Messages) > storeDiskMessageLimit {
			return nil, errCorruptCache
		}
		ids := make(map[string]bool, len(entry.Messages))
		for _, msg := range entry.Messages {
			if !validStoredMessage(msg) || msg.RoomID != id || ids[msg.ID] {
				return nil, errCorruptCache
			}
			ids[msg.ID] = true
		}
		slices.SortFunc(entry.Messages, compareMessageAge)
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
	if s.path != "" {
		snapshot := cacheSnapshot{Version: 1, Rooms: s.orderedRooms()}
		snapshot.Rooms = snapshot.Rooms[:min(len(snapshot.Rooms), storeRoomLimit)]
		for i, item := range snapshot.Rooms {
			item.Messages = item.Messages[max(0, len(item.Messages)-storeDiskMessageLimit):]
			snapshot.Rooms[i] = item
		}
		if err := writeCache(s.path, snapshot); err != nil {
			if existed {
				s.rooms[id] = previous
			} else {
				delete(s.rooms, id)
			}
			return err
		}
	}
	delete(s.rooms, oldest)
	return nil
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
		rooms = append(rooms, cloneRoom(entry.Room))
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
	return append([]Message{}, entry.Messages[start:end]...), start > 0, nil
}

func (s *Store) Find(roomID, id string) (Message, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, msg := range s.rooms[roomID].Messages {
		if msg.ID == id {
			return msg, true
		}
	}
	return Message{}, false
}

func compareMessageAge(a, b Message) int {
	if order := parseStoreTime(a.SentAt).Compare(parseStoreTime(b.SentAt)); order != 0 {
		return order
	}
	return cmp.Compare(a.ID, b.ID)
}
