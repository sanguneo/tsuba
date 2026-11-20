package main

import (
	"bufio"
	"context"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type pendingWireSend struct {
	net.Conn
	reader *bufio.Reader
	body   string
}

// The server's 100 Continue proves it started reading this request and
// therefore already reserved a slot. No payload is sent until then.
func openWireSend(t *testing.T, server *httptest.Server, label string) pendingWireSend {
	t.Helper()
	conn, err := net.DialTimeout("tcp", server.Listener.Addr().String(), httpTestTimeout)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	if err := conn.SetDeadline(time.Now().Add(httpTestTimeout)); err != nil {
		t.Fatal(err)
	}
	body := httpSendJSON(httpTestRoom, label)
	expect := "Expect: 100-continue\r\n"
	if label == "fifth" {
		expect = "" // Prove a full line refuses even without the Expect handshake.
	}
	if _, err := fmt.Fprintf(conn, "POST /send?label=%s HTTP/1.1\r\nHost: fixture\r\nAuthorization: %s\r\nContent-Type: application/json\r\nContent-Length: %d\r\n%s\r\n",
		label, httpTestBearer, len(body), expect); err != nil {
		t.Fatal(err)
	}
	return pendingWireSend{conn, bufio.NewReader(conn), body}
}

func (p pendingWireSend) response(t *testing.T) *http.Response {
	t.Helper()
	resp, err := http.ReadResponse(p.reader, &http.Request{Method: "POST"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { resp.Body.Close() })
	return resp
}

func (p pendingWireSend) submit(t *testing.T) {
	t.Helper()
	if resp := p.response(t); resp.StatusCode != 100 {
		t.Fatalf("expected 100 Continue, got %d", resp.StatusCode)
	}
	if _, err := fmt.Fprint(p.Conn, p.body); err != nil {
		t.Fatal(err)
	}
}

func httpAwait[T any](t *testing.T, ch <-chan T) T {
	t.Helper()
	select {
	case value := <-ch:
		return value
	case <-time.After(httpTestTimeout):
		t.Fatal("timed out waiting for fixture barrier")
		var zero T
		return zero
	}
}

func TestHTTPWriteLineSerializesCapsAndCancels(t *testing.T) {
	started := make(chan string, 5)
	proceed := make(chan struct{})
	canceled := make(chan struct{})
	var active, overlap atomic.Int32
	_, handler := httpTestHarness(t, httpTestSender{state: "open", perform: func(ctx context.Context, req SendRequest) (Message, error) {
		if active.Add(1) > 1 {
			overlap.Add(1)
		}
		defer active.Add(-1)
		started <- req.Text
		select {
		case <-ctx.Done():
			return Message{}, ctx.Err()
		case <-proceed:
			return httpFixtureMessage(req.RoomID, req.Text, req.Text), nil
		}
	}})
	server := httpTestServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("label") == "cancel" {
			defer close(canceled)
		}
		handler.ServeHTTP(w, r)
	}))
	first := openWireSend(t, server, "first")
	first.submit(t)
	if got := httpAwait(t, started); got != "first" {
		t.Fatalf("first sender started %q", got)
	}
	later := openWireSend(t, server, "cancel")
	later.submit(t)
	third := openWireSend(t, server, "third")
	third.submit(t)
	fourth := openWireSend(t, server, "fourth")
	fourth.submit(t)

	fifth := openWireSend(t, server, "fifth")
	// Never send the fifth body. A parser or HTTP/1 auto-drain would stall.
	wireError(t, wireAnswer(t, fifth.response(t), 429), "RATE_LIMITED")
	if err := later.Close(); err != nil {
		t.Fatal(err)
	}
	httpAwait(t, canceled)
	replacement := openWireSend(t, server, "replacement")
	replacement.submit(t)
	for _, item := range []struct {
		label   string
		request pendingWireSend
	}{{"first", first}, {"third", third}, {"fourth", fourth}, {"replacement", replacement}} {
		select {
		case proceed <- struct{}{}:
		case <-time.After(httpTestTimeout):
			t.Fatalf("sender for %s did not reach release barrier", item.label)
		}
		body := wireAnswer(t, item.request.response(t), 200)
		if !strings.Contains(string(body), `"id":"`+item.label+`"`) {
			t.Fatalf("wrong send outcome: %s", body)
		}
		if item.label != "replacement" {
			want := map[string]string{"first": "third", "third": "fourth", "fourth": "replacement"}[item.label]
			if got := httpAwait(t, started); got != want {
				t.Fatalf("want next sender %q, got %q", want, got)
			}
		}
	}
	if len(started) != 0 || overlap.Load() != 0 {
		t.Fatalf("duplicate/canceled or overlapping submission: remaining=%d overlap=%d", len(started), overlap.Load())
	}
}
