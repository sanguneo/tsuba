package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func openHTTPStream(t *testing.T, server *httptest.Server, path string) (*http.Response, *bufio.Reader) {
	t.Helper()
	resp := httpWire(t, server, wireRequest{method: "GET", path: path, auth: httpTestBearer})
	t.Logf("HTTP/%d.%d %s headers=%v", resp.ProtoMajor, resp.ProtoMinor, resp.Status, resp.Header)
	if resp.StatusCode != 200 || resp.Header.Get("Content-Type") != "text/event-stream" ||
		resp.Header.Get("Cache-Control") != "no-store" || resp.Header.Get("X-Accel-Buffering") != "no" {
		t.Fatal("unexpected stream headers")
	}
	return resp, bufio.NewReader(resp.Body)
}

func readHTTPEvent(t *testing.T, stream *bufio.Reader) (string, string, error) {
	t.Helper()
	event, err := stream.ReadString('\n')
	if err != nil {
		return "", "", err
	}
	data, err := stream.ReadString('\n')
	if err != nil {
		return "", "", err
	}
	separator, err := stream.ReadString('\n')
	if err != nil {
		return "", "", err
	}
	if separator != "\n" || !strings.HasPrefix(event, "event: ") || !strings.HasPrefix(data, "data: ") {
		t.Fatalf("invalid SSE frame %q %q %q", event, data, separator)
	}
	return strings.TrimSuffix(strings.TrimPrefix(event, "event: "), "\n"),
		strings.TrimSuffix(strings.TrimPrefix(data, "data: "), "\n"), nil
}

func wantHTTPEvent(t *testing.T, stream *bufio.Reader, want string) []byte {
	t.Helper()
	name, payload, err := readHTTPEvent(t, stream)
	t.Logf("event=%q data=%s", name, payload)
	if err != nil || name != want || !json.Valid([]byte(payload)) {
		t.Fatalf("want %q JSON frame, got %q: %v", want, name, err)
	}
	return []byte(payload)
}

func wantReady(t *testing.T, stream *bufio.Reader) {
	t.Helper()
	var ready struct {
		OK      bool                       `json:"ok"`
		Resumed *bool                      `json:"resumed"`
		Cursor  map[string]json.RawMessage `json:"cursor"`
	}
	if err := json.Unmarshal(wantHTTPEvent(t, stream, "ready"), &ready); err != nil ||
		!ready.OK || ready.Resumed == nil || *ready.Resumed || ready.Cursor == nil || len(ready.Cursor) != 0 {
		t.Fatalf("invalid nonresuming ready: %+v (%v)", ready, err)
	}
}

func TestHTTPStreamEmitsSameIDEditAndKeepsOriginalCursor(t *testing.T) {
	store, handler := httpTestHarness(t, httpTestSender{state: "open"})
	server := httpTestServer(t, handler)
	_, stream := openHTTPStream(t, server, "/stream")
	wantReady(t, stream)

	msg := httpFixtureMessage(httpTestRoom, "initial", "synthetic original")
	msg.SenderID = "fixture-author"
	httpPut(t, store, msg, true)
	var initial streamMessage
	if err := json.Unmarshal(wantHTTPEvent(t, stream, "message"), &initial); err != nil ||
		!initial.OK || initial.Message == nil || *initial.Message != msg {
		t.Fatalf("invalid initial event: %+v (%v)", initial, err)
	}
	var cursor streamCursor
	if err := json.Unmarshal(wantHTTPEvent(t, stream, "cursor"), &cursor); err != nil ||
		!cursor.OK || len(cursor.Cursor) != 1 || cursor.Cursor[httpTestRoom] != "initial" {
		t.Fatalf("invalid delivered cursor: %+v (%v)", cursor, err)
	}
	msg.EditedAt, msg.Text = "2026-01-01T00:00:01Z", "synthetic edit"
	httpPut(t, store, msg, true)
	var edited streamMessage
	if err := json.Unmarshal(wantHTTPEvent(t, stream, "message.edited"), &edited); err != nil ||
		!edited.OK || edited.Message == nil || *edited.Message != msg {
		t.Fatalf("edit did not keep the original identity: %+v (%v)", edited, err)
	}
	httpPut(t, store, httpFixtureMessage(httpTestRoom, "next", "synthetic next"), true)
	wantHTTPEvent(t, stream, "message") // No extra cursor due to the edit.
}

func TestHTTPStreamCapsAndReleasesDisconnectedSlot(t *testing.T) {
	_, handler := httpTestHarness(t, httpTestSender{state: "open"})
	stopped := make(chan struct{})
	server := httpTestServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Has("close") {
			defer close(stopped)
		}
		handler.ServeHTTP(w, r)
	}))
	first, stream := openHTTPStream(t, server, "/stream?close")
	wantReady(t, stream)
	for range 7 {
		_, stream := openHTTPStream(t, server, "/stream")
		wantReady(t, stream)
	}
	full := httpWire(t, server, wireRequest{method: "GET", path: "/stream", auth: httpTestBearer})
	wireError(t, wireAnswer(t, full, 503), "BUSY")
	if err := first.Body.Close(); err != nil {
		t.Fatal(err)
	}
	httpAwait(t, stopped)
	_, available := openHTTPStream(t, server, "/stream")
	wantReady(t, available)
}

// Wrap only the network write to deterministically hold a consumer behind
// the publisher, independent of the OS TCP socket buffer size.
type gatedSSEWriter struct {
	http.ResponseWriter
	entered chan struct{}
	release <-chan struct{}
	request *http.Request
}

func (w gatedSSEWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func (w gatedSSEWriter) Write(data []byte) (int, error) {
	if strings.Contains(string(data), `"id":"barrier"`) {
		close(w.entered)
		select {
		case <-w.release:
		case <-w.request.Context().Done():
			return 0, w.request.Context().Err()
		}
	}
	return w.ResponseWriter.Write(data)
}

func TestHTTPStreamEndsWithErrorOnSubscriberOverflow(t *testing.T) {
	store, handler := httpTestHarness(t, httpTestSender{state: "open"})
	entered, release := make(chan struct{}), make(chan struct{})
	server := httpTestServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		handler.ServeHTTP(gatedSSEWriter{w, entered, release, r}, r)
	}))
	_, stream := openHTTPStream(t, server, "/stream")
	wantReady(t, stream)
	httpPut(t, store, httpFixtureMessage(httpTestRoom, "barrier", "synthetic"), true)
	httpAwait(t, entered)
	for i := range 128 {
		httpPut(t, store, httpFixtureMessage(httpTestRoom, fmt.Sprintf("fixture-%03d", i), "synthetic"), true)
	}
	close(release)
	for range 258 {
		event, payload, err := readHTTPEvent(t, stream)
		if err != nil {
			t.Fatalf("stream ended before reporting overflow: %v", err)
		}
		if event == "error" {
			t.Logf("event=%q data=%s", event, payload)
			wireError(t, []byte(payload), "BUSY")
			if _, _, err := readHTTPEvent(t, stream); !errors.Is(err, io.EOF) {
				t.Fatalf("terminal error did not end stream: %v", err)
			}
			return
		}
	}
	t.Fatal("no terminal overflow error")
}
