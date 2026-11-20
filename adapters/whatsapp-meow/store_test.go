package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"testing"
	"time"
)

func storeMust(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func openSyntheticStore(t *testing.T, path string) *Store {
	t.Helper()
	s, err := NewStore(path)
	storeMust(t, err)
	t.Cleanup(func() { storeMust(t, s.Close()) })
	return s
}

func nextStoreUpdate(t *testing.T, updates <-chan Update) Update {
	t.Helper()
	select {
	case update, ok := <-updates:
		if !ok {
			t.Fatal("updates closed unexpectedly")
		}
		return update
	case <-time.After(2 * time.Second):
		t.Fatal("expected update not emitted")
		return Update{}
	}
}

func requireNoStoreUpdate(t *testing.T, updates <-chan Update) {
	t.Helper()
	select {
	case update := <-updates:
		t.Fatalf("unexpected update: %+v", update)
	default:
	}
}

func syntheticStoreMessage(index int) Message {
	return Message{
		ID: fmt.Sprintf("m-%03d", index), RoomID: "000001@s.whatsapp.net", SenderID: "synthetic-sender",
		Sender: "You", Text: "sample", Kind: "text", FromMe: true,
		SentAt: time.Date(2025, 1, 2, 0, 0, index, 0, time.UTC).Format(time.RFC3339),
	}
}

func TestStoreHistoryDeduplicatesAndOnlyEmitsConfirmedAdvances(t *testing.T) {
	t.Parallel()
	s := openSyntheticStore(t, "")
	updates, cancel := s.Subscribe()
	defer cancel()
	first := syntheticStoreMessage(2)
	first.DeliveryStatus = "sent"
	storeMust(t, s.Put(first, false))
	storeMust(t, s.Put(first, true))
	requireNoStoreUpdate(t, updates)

	live := syntheticStoreMessage(3)
	storeMust(t, s.Put(live, true))
	update := nextStoreUpdate(t, updates)
	if update.Event != "message" || update.Message == nil || !reflect.DeepEqual(*update.Message, live) {
		t.Fatalf("live update = %+v", update)
	}

	replay := first
	replay.DeliveryStatus, replay.Text = "delivered", "do not replace original text"
	storeMust(t, s.Put(replay, false))
	update = nextStoreUpdate(t, updates)
	want := first
	want.DeliveryStatus = "delivered"
	if update.Event != "message.edited" || update.Message == nil || !reflect.DeepEqual(*update.Message, want) {
		t.Fatalf("history receipt update = %+v", update)
	}
	storeMust(t, s.Receipt(first.RoomID, []string{first.ID, "absent"}, "read"))
	if update = nextStoreUpdate(t, updates); update.Event != "message.edited" || update.Message == nil || update.Message.DeliveryStatus != "read" {
		t.Fatalf("read receipt = %+v", update)
	}
	storeMust(t, s.Receipt(first.RoomID, []string{first.ID}, "delivered"))
	requireNoStoreUpdate(t, updates)
	current, ok := s.Find(first.RoomID, first.ID)
	if !ok || current.DeliveryStatus != "read" || current.Text != first.Text {
		t.Fatalf("stale receipt or history overwrote confirmed state: %+v", current)
	}
}

func TestStorePageAndRestartKeepOnlyNewestCachedMessages(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), "private", "cache.json")
	s := openSyntheticStore(t, path)
	roomID := syntheticStoreMessage(0).RoomID
	for i := 204; i >= 0; i-- {
		storeMust(t, s.Put(syntheticStoreMessage(i), false))
	}
	page, earlier, err := s.Page(roomID, 200, "")
	storeMust(t, err)
	if len(page) != 200 || earlier || page[0].ID != "m-005" || page[199].ID != "m-204" {
		t.Fatalf("unexpected memory window: %d rows, earlier %v", len(page), earlier)
	}
	page, earlier, err = s.Page(roomID, 2, "m-009")
	storeMust(t, err)
	if len(page) != 2 || !earlier || page[0].ID != "m-007" || page[1].ID != "m-008" {
		t.Fatalf("wrong exclusive before page: %v, earlier %v", page, earlier)
	}
	_, _, err = s.Page(roomID, 2, "m-004")
	var notFound *APIError
	if !errors.As(err, &notFound) || notFound.Code != "NOT_FOUND" {
		t.Fatalf("evicted cursor should be NOT_FOUND, got %v", err)
	}
	storeMust(t, s.PutRoom(Room{ID: roomID, Kind: "direct", Title: "Known room", Unread: 2}))
	storeMust(t, s.PutRoom(Room{ID: roomID, Unread: 3}))
	storeMust(t, s.Close())

	reopened := openSyntheticStore(t, path)
	page, earlier, err = reopened.Page(roomID, 100, "")
	storeMust(t, err)
	if len(page) != 50 || earlier || page[0].ID != "m-155" || page[49].ID != "m-204" {
		t.Fatalf("unexpected disk window: %d rows, earlier %v", len(page), earlier)
	}
	rooms := reopened.Rooms()
	if len(rooms) != 1 || rooms[0].Title != "Known room" || rooms[0].Unread != 3 ||
		rooms[0].LastMessage == nil || rooms[0].LastMessage.Text != "sample" {
		t.Fatalf("room metadata was lost across merge or restart: %+v", rooms)
	}
	for item, want := range map[string]os.FileMode{path: 0o600, filepath.Dir(path): 0o700} {
		info, err := os.Stat(item)
		storeMust(t, err)
		if info.Mode().Perm() != want {
			t.Fatalf("mode of %q = %o, want %o", filepath.Base(item), info.Mode().Perm(), want)
		}
	}
}

func TestStoreRejectsCorruptCacheWithoutReplacingIt(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), "private", "cache.json")
	storeMust(t, os.Mkdir(filepath.Dir(path), 0o700))
	const corrupt = `{"version":1,"rooms":[]} junk`
	storeMust(t, os.WriteFile(path, []byte(corrupt), 0o600))
	if _, err := NewStore(path); err == nil {
		t.Fatal("corrupt cache opened")
	}
	data, err := os.ReadFile(path)
	storeMust(t, err)
	if string(data) != corrupt {
		t.Fatal("corrupt cache was changed")
	}
}

func TestStoreEvictsOldestRoomAndBoundsSlowSubscriber(t *testing.T) {
	t.Parallel()
	s := openSyntheticStore(t, "")
	updates, cancel := s.Subscribe()
	defer cancel()
	for i := range 501 {
		msg := syntheticStoreMessage(i)
		msg.RoomID = fmt.Sprintf("000%03d@s.whatsapp.net", i)
		storeMust(t, s.Put(msg, true))
	}
	rooms := s.Rooms()
	if len(rooms) != 500 || rooms[0].ID != "000500@s.whatsapp.net" || rooms[499].ID != "000001@s.whatsapp.net" {
		t.Fatalf("room cache did not retain the 500 newest rooms: n=%d", len(rooms))
	}
	for i := range 65 {
		select {
		case update, open := <-updates:
			if open != (i < 64) || (open && (update.Message == nil || update.Message.ID != fmt.Sprintf("m-%03d", i))) {
				t.Fatalf("unexpected subscriber state at %d: open=%v, update=%+v", i, open, update)
			}
		default:
			t.Fatalf("slow subscriber neither buffered nor disconnected at %d", i)
		}
	}
}

func TestStoreConcurrentPublishAndUnsubscribe(t *testing.T) {
	t.Parallel()
	s := openSyntheticStore(t, "")
	var wg sync.WaitGroup
	wg.Add(2)
	errs := make(chan error, 1)
	go func() {
		defer wg.Done()
		for i := range 100 {
			if err := s.Put(syntheticStoreMessage(i), true); err != nil {
				errs <- err
				return
			}
		}
	}()
	go func() {
		defer wg.Done()
		for range 100 {
			_, cancel := s.Subscribe()
			cancel()
			cancel()
		}
	}()
	wg.Wait()
	close(errs)
	for err := range errs {
		storeMust(t, err)
	}
	page, earlier, err := s.Page(syntheticStoreMessage(0).RoomID, 100, "")
	storeMust(t, err)
	if len(page) != 100 || earlier {
		t.Fatalf("subscription churn interfered with writes: %d rows, earlier %v", len(page), earlier)
	}
}
