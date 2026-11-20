package main

// allow: SIZE_OK — Keep the synthetic cache lifecycle and CDN boundary suite in its assigned test file.

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/types"
)

const (
	avatarTestURL  = "https://pps.whatsapp.net/synthetic"
	avatarTestRoom = "synthetic@g.us"
	avatarTestJPEG = "\xff\xd8\xff\xd9"
	avatarTestPNG  = "\x89PNG\r\n\x1a\n"
	avatarTestWebP = "RIFF\x00\x00\x00\x00WEBP"
)

type avatarTestSDK struct {
	offline atomic.Bool
	lookup  func(context.Context, types.JID) (*types.ProfilePictureInfo, error)
}

func (s *avatarTestSDK) IsConnected() bool { return !s.offline.Load() }
func (s *avatarTestSDK) IsLoggedIn() bool  { return !s.offline.Load() }

func (s *avatarTestSDK) GetProfilePictureInfo(ctx context.Context, jid types.JID, params *whatsmeow.GetProfilePictureParams) (*types.ProfilePictureInfo, error) {
	if !params.Preview {
		return nil, whatsmeow.ErrProfilePictureNotSet
	}
	return s.lookup(ctx, jid)
}

type avatarTestTransport func(*http.Request) (*http.Response, error)

func (f avatarTestTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func avatarTestResponse(status int, mimeType, body string, length int64) *http.Response {
	return &http.Response{
		StatusCode: status, Header: http.Header{"Content-Type": {mimeType}},
		Body: io.NopCloser(strings.NewReader(body)), ContentLength: length,
	}
}

func avatarTestFixedLookup(address string) *avatarTestSDK {
	return &avatarTestSDK{lookup: func(context.Context, types.JID) (*types.ProfilePictureInfo, error) {
		return &types.ProfilePictureInfo{URL: address}, nil
	}}
}

func TestRoomAvatarContentIDAndSnapshot(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		var lookups int
		sdk := &avatarTestSDK{lookup: func(context.Context, types.JID) (*types.ProfilePictureInfo, error) {
			lookups++
			return &types.ProfilePictureInfo{URL: fmt.Sprintf("%s/%d", avatarTestURL, lookups)}, nil
		}}
		cache := newRoomAvatarCache(sdk, &http.Client{Transport: avatarTestTransport(func(*http.Request) (*http.Response, error) {
			return avatarTestResponse(200, "image/jpeg; example=value", avatarTestJPEG, 4), nil
		})})
		rooms := []string{avatarTestRoom}
		const want = "wa-room-v1-7c0fed26ef322d27840f65a8f827c4a7144cf85bc04d592ff80204d30d185a08"
		if id := cache.resolveRooms(t.Context(), rooms)[avatarTestRoom]; id != want {
			t.Fatalf("got %q, want the SHA-256 of MIME type followed by bytes", id)
		}
		snapshot, ok := cache.resolveMedia(want)
		if !ok || snapshot.contentType != "image/jpeg" || snapshot.name != "avatar.jpg" || string(snapshot.bytes) != avatarTestJPEG {
			t.Fatalf("wrong snapshot: %+v, present=%v", snapshot, ok)
		}
		snapshot.bytes[0] = 0
		if next, ok := cache.resolveMedia(want); !ok || string(next.bytes) != avatarTestJPEG {
			t.Fatal("caller mutation changed cache bytes")
		}
		<-time.After(5 * time.Minute) // synctest virtual time
		if _, ok := cache.resolveMedia(want); ok {
			t.Fatal("expired media is still available")
		}
		if id := cache.resolveRooms(t.Context(), rooms)[avatarTestRoom]; id != want || lookups != 2 {
			t.Fatalf("refresh after CDN URL rotation = %q, lookup count = %d", id, lookups)
		}
	})
}

func TestRoomAvatarNegativeCacheAndReconnect(t *testing.T) {
	for _, tc := range []struct {
		name    string
		err     error
		offline bool
		initial int
		cached  int
	}{
		{"missing", nil, false, 1, 1},
		{"private", whatsmeow.ErrProfilePictureUnauthorized, false, 1, 1},
		{"offline", nil, true, 0, 1},
		{"disconnect during lookup", whatsmeow.ErrIQDisconnected, false, 1, 2},
	} {
		t.Run(tc.name, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				var calls int
				sdk := &avatarTestSDK{lookup: func(context.Context, types.JID) (*types.ProfilePictureInfo, error) {
					calls++
					return nil, tc.err
				}}
				sdk.offline.Store(tc.offline)
				cache := newRoomAvatarCache(sdk, nil)
				ids := []string{avatarTestRoom}
				if got := cache.resolveRooms(t.Context(), ids); len(got) != 0 || calls != tc.initial {
					t.Fatalf("initial result=%v, calls=%d", got, calls)
				}
				sdk.offline.Store(false)
				if got := cache.resolveRooms(t.Context(), ids); len(got) != 0 || calls != tc.cached {
					t.Fatalf("before TTL result=%v, calls=%d", got, calls)
				}
				<-time.After(5 * time.Minute) // synctest virtual time
				if got := cache.resolveRooms(t.Context(), ids); len(got) != 0 || calls != tc.cached+1 {
					t.Fatalf("after TTL result=%v, calls=%d", got, calls)
				}
			})
		})
	}
}

func TestRoomAvatarURLAllowlist(t *testing.T) {
	for _, address := range []string{
		"http://pps.whatsapp.net/p", "https://127.0.0.1/p", "https://pps.whatsapp.net.invalid/p",
		"https://x.y.pps.whatsapp.net/p", "https://x.pps.whatsapp.com/p", "https://@pps.whatsapp.net/p",
		"https://u:p@pps.whatsapp.net/p", "https://pps.whatsapp.net:443/p", "https://pps.whatsapp.net:/p",
		"https://pps.whatsapp.net./p", "https://pps.whatsapp.net/%zz", "not a URL",
	} {
		t.Run(address, func(t *testing.T) {
			var calls atomic.Int32
			cache := newRoomAvatarCache(avatarTestFixedLookup(address), &http.Client{Transport: avatarTestTransport(func(*http.Request) (*http.Response, error) {
				calls.Add(1)
				return avatarTestResponse(200, "image/jpeg", avatarTestJPEG, 4), nil
			})})
			if got := cache.resolveRooms(t.Context(), []string{avatarTestRoom}); len(got) != 0 || calls.Load() != 0 {
				t.Fatalf("denied URL reached HTTP or yielded an avatar: %v, calls=%d", got, calls.Load())
			}
		})
	}
}

func TestRoomAvatarOnlyQueriesEligibleJIDs(t *testing.T) {
	var calls atomic.Int32
	cache := newRoomAvatarCache(&avatarTestSDK{lookup: func(context.Context, types.JID) (*types.ProfilePictureInfo, error) {
		calls.Add(1)
		return &types.ProfilePictureInfo{URL: avatarTestURL}, nil
	}}, &http.Client{Transport: avatarTestTransport(func(*http.Request) (*http.Response, error) {
		return avatarTestResponse(200, "image/jpeg", avatarTestJPEG, 4), nil
	})})
	invalid := []string{
		"synthetic@bot", types.MetaAIJID.String(), types.MetaAIJID.User + ":7@s.whatsapp.net",
		"status@broadcast", "synthetic@newsletter", "not-a-jid", "@lid",
		"synthetic@lid@invalid", "bad user@lid", "synthetic:bad@s.whatsapp.net",
	}
	if got := cache.resolveRooms(t.Context(), invalid); len(got) != 0 || calls.Load() != 0 {
		t.Fatalf("ineligible JIDs yielded %d avatars and %d SDK calls", len(got), calls.Load())
	}
	valid := []string{"synthetic@s.whatsapp.net", "synthetic:7@s.whatsapp.net", "synthetic@lid", avatarTestRoom}
	if got := cache.resolveRooms(t.Context(), valid); len(got) != len(valid) || calls.Load() != 3 {
		t.Fatalf("eligible JIDs yielded %d avatars and %d SDK calls", len(got), calls.Load())
	}
}

func TestRoomAvatarCDNResponseBounds(t *testing.T) {
	const max = 256 * 1024
	for _, tc := range []struct {
		name, host, mimeType, body string
		length                     int64
		status                     int
		accepted                   bool
	}{
		{"boundary streamed", "pps.whatsapp.net", "image/jpeg", avatarTestJPEG + strings.Repeat("x", max-4), -1, 200, true},
		{"png", "sample.pps.whatsapp.net", "image/png", avatarTestPNG, 8, 200, true},
		{"webp", "pps.whatsapp.com", "image/webp", avatarTestWebP, 12, 200, true},
		{"mismatch", "pps.whatsapp.net", "image/png", avatarTestJPEG, 4, 200, false},
		{"malformed magic", "pps.whatsapp.net", "image/webp", avatarTestWebP[:11], 11, 200, false},
		{"untrusted type", "pps.whatsapp.net", "image/svg+xml", avatarTestPNG, 8, 200, false},
		{"oversized known", "pps.whatsapp.net", "image/jpeg", avatarTestJPEG, max + 1, 200, false},
		{"oversized streamed", "pps.whatsapp.net", "image/jpeg", avatarTestJPEG + strings.Repeat("x", max-3), -1, 200, false},
		{"redirect", "pps.whatsapp.net", "image/jpeg", avatarTestJPEG, 4, 302, false},
		{"denied", "pps.whatsapp.net", "image/jpeg", avatarTestJPEG, 4, 403, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var calls atomic.Int32
			client := &http.Client{Transport: avatarTestTransport(func(r *http.Request) (*http.Response, error) {
				calls.Add(1)
				if r.URL.Path == "/redirect-target" {
					return avatarTestResponse(200, "image/jpeg", avatarTestJPEG, 4), nil
				}
				resp := avatarTestResponse(tc.status, tc.mimeType, tc.body, tc.length)
				resp.Header.Set("Location", "/redirect-target")
				return resp, nil
			})}
			cache := newRoomAvatarCache(avatarTestFixedLookup("https://"+tc.host+"/fixture"), client)
			got := cache.resolveRooms(t.Context(), []string{avatarTestRoom})[avatarTestRoom]
			if (got != "") != tc.accepted || calls.Load() != 1 {
				t.Fatalf("id=%q, expected accepted=%t; HTTP calls=%d", got, tc.accepted, calls.Load())
			}
		})
	}
}

func TestRoomAvatarEvictsOldestSnapshot(t *testing.T) {
	cache := newRoomAvatarCache(&avatarTestSDK{lookup: func(_ context.Context, jid types.JID) (*types.ProfilePictureInfo, error) {
		return &types.ProfilePictureInfo{URL: avatarTestURL + "/" + jid.User}, nil
	}}, &http.Client{Transport: avatarTestTransport(func(r *http.Request) (*http.Response, error) {
		return avatarTestResponse(200, "image/jpeg", avatarTestJPEG+r.URL.Path, -1), nil
	})})
	first := cache.resolveRooms(t.Context(), []string{avatarTestRoom})[avatarTestRoom]
	var rooms []string
	for i := range 500 {
		rooms = append(rooms, fmt.Sprintf("synthetic-%d@g.us", i))
	}
	if _, ok := cache.resolveMedia(first); !ok {
		t.Fatal("fixture did not store the first snapshot")
	}
	ids := cache.resolveRooms(t.Context(), rooms)
	if _, ok := cache.resolveMedia(first); ok || len(ids) != 500 {
		t.Fatalf("oldest retained=%t, new avatar count=%d", ok, len(ids))
	}
}

func TestRoomAvatarParallelListsBoundAndCoalesce(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		started, downloads := make(chan struct{}, 506), make(chan struct{}, 506)
		release := make(chan struct{})
		cache := newRoomAvatarCache(&avatarTestSDK{lookup: func(context.Context, types.JID) (*types.ProfilePictureInfo, error) {
			started <- struct{}{}
			return &types.ProfilePictureInfo{URL: avatarTestURL}, nil
		}}, &http.Client{Transport: avatarTestTransport(func(*http.Request) (*http.Response, error) {
			downloads <- struct{}{}
			<-release
			return avatarTestResponse(200, "image/jpeg", avatarTestJPEG, 4), nil
		})})
		var wg sync.WaitGroup
		var decorated atomic.Int32
		list := func(room string) {
			wg.Go(func() { decorated.Add(int32(len(cache.resolveRooms(t.Context(), []string{room})))) })
		}
		list(avatarTestRoom)
		synctest.Wait()
		list(avatarTestRoom)
		for i := range 504 {
			list(fmt.Sprintf("synthetic-%d@g.us", i))
		}
		synctest.Wait()
		inFlight := len(started)
		close(release)
		wg.Wait()
		if inFlight != 4 || len(started) != 500 || len(downloads) != 500 {
			t.Fatalf("active=%d, lookups=%d, downloads=%d", inFlight, len(started), len(downloads))
		}
		if got := decorated.Load(); got != 501 {
			t.Fatalf("unexpected number of decorated lists: %d", got)
		}
	})
}

func TestRoomAvatarListBudgetAndLookupTimeout(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		lookupTime := make(chan time.Duration, 1)
		release := make(chan struct{})
		defer func() { close(release); synctest.Wait() }()
		cache := newRoomAvatarCache(&avatarTestSDK{lookup: func(ctx context.Context, jid types.JID) (*types.ProfilePictureInfo, error) {
			if jid.User == "slow-sdk" {
				start := time.Now()
				<-ctx.Done()
				lookupTime <- time.Since(start)
				return nil, ctx.Err()
			}
			return &types.ProfilePictureInfo{URL: avatarTestURL}, nil
		}}, &http.Client{Transport: avatarTestTransport(func(r *http.Request) (*http.Response, error) {
			select {
			case <-r.Context().Done():
			case <-release:
			}
			return nil, r.Context().Err()
		})})
		start := time.Now()
		rooms := []string{"slow-sdk@g.us", "slow-http-a@g.us", "slow-http-b@g.us", "slow-http-c@g.us", "slow-http-d@g.us", "slow-http-e@g.us"}
		if got := cache.resolveRooms(t.Context(), rooms); len(got) != 0 || time.Since(start) != 8*time.Second {
			t.Fatalf("bounded list returned %v in %v", got, time.Since(start))
		}
		if got := <-lookupTime; got != 3*time.Second {
			t.Fatalf("SDK timeout = %v", got)
		}
	})
}
