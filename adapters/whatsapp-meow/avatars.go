package main

// allow: SIZE_OK — Keep avatar admission, lookup, and snapshot publication in the assigned cache file.

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"mime"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/types"
)

const (
	roomAvatarPrefix      = "wa-room-v1-"
	roomAvatarTTL         = 5 * time.Minute
	roomAvatarListBudget  = 8 * time.Second
	roomAvatarSDKTimeout  = 3 * time.Second
	roomAvatarHTTPTimeout = 5 * time.Second
	roomAvatarLimit       = 500
	roomAvatarConcurrency = 4
	roomAvatarMaxBytes    = 256 * 1024
)

var (
	roomAvatarHost = regexp.MustCompile(`^(?:[a-z0-9-]+\.)?pps\.whatsapp\.net$|^pps\.whatsapp\.com$`)
	roomAvatarJID  = regexp.MustCompile(`^[0-9A-Za-z._-]+(?::[0-9]+)?@(?:s\.whatsapp\.net|lid|g\.us)$`)
)

type avatarProfileSDK interface {
	IsConnected() bool
	IsLoggedIn() bool
	GetProfilePictureInfo(context.Context, types.JID, *whatsmeow.GetProfilePictureParams) (*types.ProfilePictureInfo, error)
}

type avatarSnapshot struct {
	id          string
	bytes       []byte
	contentType string
	name        string
}

type roomAvatarEntry struct {
	done    chan struct{} // non-nil while pending; closed to publish the result
	picture avatarSnapshot
	expires time.Time
	order   uint64
}

type roomAvatarCache struct {
	sdk   avatarProfileSDK
	http  http.Client
	now   func() time.Time
	slots chan struct{}

	mu      sync.Mutex
	rooms   map[types.JID]*roomAvatarEntry
	written uint64
}

func newRoomAvatarCache(sdk avatarProfileSDK, client *http.Client) *roomAvatarCache {
	httpClient := http.Client{Timeout: roomAvatarHTTPTimeout, Transport: &http.Transport{
		ForceAttemptHTTP2:      true,
		MaxIdleConns:           roomAvatarConcurrency,
		MaxIdleConnsPerHost:    roomAvatarConcurrency,
		IdleConnTimeout:        30 * time.Second,
		MaxResponseHeaderBytes: 32 * 1024,
	}}
	if client != nil {
		httpClient = *client
	}
	httpClient.Jar = nil
	httpClient.CheckRedirect = func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}
	return &roomAvatarCache{
		sdk: sdk, http: httpClient, now: time.Now,
		slots: make(chan struct{}, roomAvatarConcurrency),
		rooms: make(map[types.JID]*roomAvatarEntry),
	}
}

// resolveRooms returns the available IDs without delaying the list for slow rooms.
func (c *roomAvatarCache) resolveRooms(ctx context.Context, roomIDs []string) map[string]string {
	budget, cancel := context.WithTimeout(ctx, roomAvatarListBudget)
	defer cancel()
	var next atomic.Uint64
	var workers sync.WaitGroup
	var mu sync.Mutex
	result := make(map[string]string)
	for range min(len(roomIDs), roomAvatarConcurrency) {
		workers.Go(func() {
			for budget.Err() == nil {
				i := next.Add(1) - 1
				if i >= uint64(len(roomIDs)) {
					return
				}
				room := roomIDs[i]
				if id := c.resolveRoom(budget, room); id != "" {
					mu.Lock()
					result[room] = id
					mu.Unlock()
				}
			}
		})
	}
	workers.Wait()
	return result
}

func (c *roomAvatarCache) resolveRoom(ctx context.Context, room string) string {
	if !roomAvatarJID.MatchString(room) {
		return ""
	}
	parsed, err := types.ParseJID(room)
	jid := parsed.ToNonAD()
	if err != nil || jid.User == "" || jid.IsBot() {
		return ""
	}
	c.mu.Lock()
	entry := c.rooms[jid]
	if entry != nil && entry.done == nil && c.now().Before(entry.expires) {
		id := entry.picture.id
		c.mu.Unlock()
		return id
	}
	var done chan struct{}
	if entry != nil && entry.done != nil {
		done = entry.done
	} else {
		if ctx.Err() != nil || !c.sdk.IsConnected() || !c.sdk.IsLoggedIn() {
			c.mu.Unlock()
			return ""
		}
		if entry == nil && len(c.rooms) == roomAvatarLimit {
			var oldestRoom types.JID
			var oldest *roomAvatarEntry
			for key, candidate := range c.rooms {
				if candidate.done == nil && (oldest == nil || candidate.order < oldest.order) {
					oldestRoom, oldest = key, candidate
				}
			}
			if oldest == nil {
				c.mu.Unlock()
				return ""
			}
			delete(c.rooms, oldestRoom)
		}
		done = make(chan struct{})
		entry = &roomAvatarEntry{done: done}
		c.rooms[jid] = entry
		// One bounded job is shared by all callers, even if its first caller cancels.
		go c.loadRoom(context.WithoutCancel(ctx), jid, entry)
	}
	c.mu.Unlock()
	select {
	case <-done:
		return entry.picture.id
	case <-ctx.Done():
		return ""
	}
}

func (c *roomAvatarCache) loadRoom(ctx context.Context, jid types.JID, entry *roomAvatarEntry) {
	budget, cancel := context.WithTimeout(ctx, roomAvatarListBudget)
	defer cancel()
	var picture avatarSnapshot
	var cacheable bool
	select {
	case c.slots <- struct{}{}:
		picture, cacheable = c.lookupRoom(budget, jid)
		<-c.slots
	case <-budget.Done():
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	if cacheable {
		c.written++
		entry.picture, entry.expires, entry.order = picture, c.now().Add(roomAvatarTTL), c.written
	} else {
		delete(c.rooms, jid)
	}
	// Publish the immutable picture. Refresh and eviction replace or remove
	// this map entry rather than writing to the picture a waiter may still read.
	close(entry.done)
	entry.done = nil
}

func (c *roomAvatarCache) lookupRoom(ctx context.Context, jid types.JID) (avatarSnapshot, bool) {
	if ctx.Err() != nil || !c.sdk.IsConnected() || !c.sdk.IsLoggedIn() {
		return avatarSnapshot{}, false
	}
	lookup, cancel := context.WithTimeout(ctx, roomAvatarSDKTimeout)
	info, err := c.sdk.GetProfilePictureInfo(lookup, jid, &whatsmeow.GetProfilePictureParams{Preview: true})
	timedOut := lookup.Err() != nil
	cancel()
	var disconnected *whatsmeow.DisconnectedError
	if timedOut || errors.Is(err, whatsmeow.ErrNotConnected) || errors.Is(err, whatsmeow.ErrNotLoggedIn) ||
		errors.As(err, &disconnected) || !c.sdk.IsConnected() || !c.sdk.IsLoggedIn() {
		return avatarSnapshot{}, false
	}
	if err != nil || info == nil || info.URL == "" {
		return avatarSnapshot{}, true
	}
	picture := c.downloadRoomAvatar(ctx, info.URL)
	return picture, picture.id != "" || (ctx.Err() == nil && c.sdk.IsConnected() && c.sdk.IsLoggedIn())
}

func (c *roomAvatarCache) downloadRoomAvatar(ctx context.Context, address string) avatarSnapshot {
	target, err := url.Parse(address)
	if err != nil || target.Scheme != "https" || target.User != nil || !roomAvatarHost.MatchString(strings.ToLower(target.Host)) {
		return avatarSnapshot{}
	}
	budget, cancel := context.WithTimeout(ctx, roomAvatarHTTPTimeout)
	defer cancel()
	resp, err := c.http.Do((&http.Request{Method: http.MethodGet, URL: target, Header: make(http.Header)}).WithContext(budget))
	if err != nil {
		return avatarSnapshot{}
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 || resp.ContentLength > roomAvatarMaxBytes {
		return avatarSnapshot{}
	}
	contentType, _, err := mime.ParseMediaType(resp.Header.Get("Content-Type"))
	if err != nil {
		return avatarSnapshot{}
	}
	var extension string
	switch contentType {
	case "image/jpeg":
		extension = ".jpg"
	case "image/png":
		extension = ".png"
	case "image/webp":
		extension = ".webp"
	default:
		return avatarSnapshot{}
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, roomAvatarMaxBytes+1))
	if err != nil || len(body) > roomAvatarMaxBytes {
		return avatarSnapshot{}
	}
	matches := http.DetectContentType(body) == contentType
	if contentType == "image/webp" {
		// The reference checks the WebP container without requiring a VP8 chunk.
		matches = len(body) >= 12 && string(body[:4]) == "RIFF" && string(body[8:12]) == "WEBP"
	}
	if !matches {
		return avatarSnapshot{}
	}
	hash := sha256.New()
	hash.Write([]byte(contentType))
	hash.Write(body)
	return avatarSnapshot{roomAvatarPrefix + hex.EncodeToString(hash.Sum(nil)), body, contentType, "avatar" + extension}
}

// resolveMedia serves immutable snapshots only; IDs never trigger network I/O.
func (c *roomAvatarCache) resolveMedia(id string) (avatarSnapshot, bool) {
	c.mu.Lock()
	var picture avatarSnapshot
	now := c.now()
	for _, entry := range c.rooms {
		if entry.picture.id != "" && entry.picture.id == id && now.Before(entry.expires) {
			picture = entry.picture
			break
		}
	}
	c.mu.Unlock()
	picture.bytes = bytes.Clone(picture.bytes)
	return picture, picture.id != ""
}
