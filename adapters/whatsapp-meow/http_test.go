package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const (
	httpTestToken    = "synthetic-http-test-token"
	httpTestRoom     = "000000@g.us"
	httpTestBot      = "000001@bot"
	httpTestKnownBot = "000002@bot"
	httpTestTimeout  = 5 * time.Second
)

type httpTestSender struct {
	state   string
	canBot  bool
	perform func(context.Context, SendRequest) (Message, error)
}

func (s httpTestSender) State() string { return s.state }
func (s httpTestSender) CanSendBot(_ context.Context, room string) bool {
	return s.canBot && room == httpTestKnownBot
}

func (s httpTestSender) Send(ctx context.Context, req SendRequest) (Message, error) {
	if s.perform != nil {
		return s.perform(ctx, req)
	}
	return Message{}, errors.New("unexpected invocation of synthetic sender")
}

func httpTestHarness(t *testing.T, sender Sender) (*Store, http.Handler) {
	t.Helper()
	store, err := NewStore("")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := store.Close(); err != nil {
			t.Error(err)
		}
	})
	handler, err := NewHandler(httpTestToken, store, sender)
	if err != nil {
		t.Fatal(err)
	}
	return store, handler
}

func httpTestServer(t *testing.T, handler http.Handler) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	server.Client().Timeout = httpTestTimeout
	return server
}

type wireRequest struct {
	method, path, auth, contentType, body string
}

func httpWire(t *testing.T, server *httptest.Server, request wireRequest) *http.Response {
	t.Helper()
	r, err := http.NewRequest(request.method, server.URL+request.path, strings.NewReader(request.body))
	if err != nil {
		t.Fatal(err)
	}
	r.Header.Set("Authorization", request.auth)
	r.Header.Set("Content-Type", request.contentType)
	resp, err := server.Client().Do(r)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { resp.Body.Close() })
	return resp
}

const httpTestBearer = "Bearer " + httpTestToken

func wireAnswer(t *testing.T, resp *http.Response, status int) []byte {
	t.Helper()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	// Keep large synthetic payloads out of verbose output.
	t.Logf("HTTP/%d.%d %s headers=%v body=%.4096s", resp.ProtoMajor, resp.ProtoMinor,
		resp.Status, resp.Header, body)
	if resp.StatusCode != status || resp.Header.Get("Content-Type") != "application/json; charset=utf-8" ||
		resp.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("unexpected status or envelope headers; want status %d", status)
	}
	return body
}

func wireError(t *testing.T, body []byte, code string) {
	t.Helper()
	var answer struct {
		OK    *bool `json:"ok"`
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(body, &answer); err != nil || answer.OK == nil || *answer.OK ||
		answer.Error.Code != code || answer.Error.Message == "" {
		t.Fatalf("expected error %s, got %s (%v)", code, body, err)
	}
}

func TestHTTPRoutesAuthenticateBeforeMethodAndFeature(t *testing.T) {
	_, handler := httpTestHarness(t, httpTestSender{state: "connecting"})
	server := httpTestServer(t, handler)
	for _, test := range []struct {
		name string
		wireRequest
		status      int
		code, allow string
	}{
		{"health", wireRequest{method: "GET", path: "/health"}, 200, "", ""},
		{"health method", wireRequest{method: "POST", path: "/health"}, 405, "METHOD_NOT_ALLOWED", "GET"},
		{"wrong case", wireRequest{method: "GET", path: "/capabilities", auth: "bearer " + httpTestToken}, 401, "UNAUTHORIZED", ""},
		{"wrong token", wireRequest{method: "GET", path: "/capabilities", auth: "Bearer synthetic-http-test-tokeX"}, 401, "UNAUTHORIZED", ""},
		{"blocked before method", wireRequest{method: "POST", path: "/media"}, 401, "UNAUTHORIZED", ""},
		{"blocked before routing", wireRequest{method: "GET", path: "/absent"}, 401, "UNAUTHORIZED", ""},
		{"unknown", wireRequest{method: "GET", path: "/absent", auth: httpTestBearer}, 404, "NOT_FOUND", ""},
		{"method before feature", wireRequest{method: "GET", path: "/edit", auth: httpTestBearer}, 405, "METHOD_NOT_ALLOWED", "POST"},
		{"icon method", wireRequest{method: "POST", path: "/icon", auth: httpTestBearer}, 405, "METHOD_NOT_ALLOWED", "GET"},
		{"resume refused", wireRequest{method: "GET", path: "/stream?since=", auth: httpTestBearer}, 501, "NOT_SUPPORTED", ""},
		{"bad limit", wireRequest{method: "GET", path: "/messages?roomId=" + httpTestRoom + "&limit=%2B1", auth: httpTestBearer}, 400, "INVALID_REQUEST", ""},
		{"unseen room", wireRequest{method: "GET", path: "/messages?roomId=" + httpTestRoom, auth: httpTestBearer}, 200, "", ""},
		{"unseen cursor", wireRequest{method: "GET", path: "/messages?roomId=" + httpTestRoom + "&before=absent", auth: httpTestBearer}, 404, "NOT_FOUND", ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			resp := httpWire(t, server, test.wireRequest)
			body := wireAnswer(t, resp, test.status)
			if test.code != "" {
				wireError(t, body, test.code)
			} else {
				want := `{"ok":true}`
				if test.name == "unseen room" {
					want = `{"ok":true,"messages":[],"hasEarlier":false}`
				}
				if strings.TrimSpace(string(body)) != want {
					t.Fatalf("unexpected response: %s", body)
				}
			}
			if resp.Header.Get("Allow") != test.allow {
				t.Fatalf("Allow=%q, want %q", resp.Header.Get("Allow"), test.allow)
			}
		})
	}
	for path, method := range map[string]string{
		"/edit": "POST", "/delete": "POST", "/react": "POST", "/read": "POST",
	} {
		t.Run(path, func(t *testing.T) {
			answer := httpWire(t, server, wireRequest{method: method, path: path, auth: httpTestBearer})
			wireError(t, wireAnswer(t, answer, 501), "NOT_SUPPORTED")
		})
	}
}

func httpSendJSON(room, text string) string {
	data, err := json.Marshal(SendRequest{RoomID: room, Text: text})
	if err != nil {
		panic(err) // The fixture contains only strings.
	}
	return string(data)
}

func httpFixtureMessage(room, id, text string) Message {
	return Message{RoomID: room, ID: id, Sender: "Synthetic", Text: text, Kind: "text", SentAt: "2026-01-01T00:00:00Z"}
}

func httpPut(t *testing.T, store *Store, message Message, live bool) {
	t.Helper()
	if err := store.Put(message, live); err != nil {
		t.Fatal(err)
	}
}

func TestHTTPSendStrictJSONGatesAndUnknownOutcome(t *testing.T) {
	var attempts atomic.Int32
	_, handler := httpTestHarness(t, httpTestSender{state: "open", canBot: true, perform: func(_ context.Context, req SendRequest) (Message, error) {
		attempts.Add(1)
		if req.Text == "unknown" {
			return Message{}, errors.New("synthetic confidential diagnostic")
		}
		msg := httpFixtureMessage(req.RoomID, "sent", req.Text)
		msg.FromMe = true
		msg.DeliveryStatus = "sent"
		return msg, nil
	}})
	server := httpTestServer(t, handler)
	for _, row := range []struct {
		name, contentType, body string
		status                  int
		code                    string
	}{
		{"wrong content type", "text/plain", httpSendJSON(httpTestRoom, "fixture"), 400, "INVALID_REQUEST"},
		{"incomplete object", "application/json", `{"roomId":`, 400, "INVALID_REQUEST"},
		{"noncanonical device", "application/json", httpSendJSON("000000:1@lid", "fixture"), 400, "INVALID_REQUEST"},
		{"null reply", "application/json", `{"roomId":"` + httpTestRoom + `","text":"fixture","replyTo":null}`, 400, "INVALID_REQUEST"},
		{"nonstring text", "application/json", `{"roomId":"` + httpTestRoom + `","text":123}`, 400, "INVALID_REQUEST"},
		{"duplicate text", "application/json", `{"roomId":"` + httpTestRoom + `","text":"first","text":"second"}`, 400, "INVALID_REQUEST"},
		{"extra field", "application/json", httpSendJSON(httpTestRoom, "fixture")[:len(httpSendJSON(httpTestRoom, "fixture"))-1] + `,"extra":true}`, 400, "INVALID_REQUEST"},
		{"trailing object", "application/json", httpSendJSON(httpTestRoom, "fixture") + `{}`, 400, "INVALID_REQUEST"},
		{"empty text", "application/json", httpSendJSON(httpTestRoom, ""), 400, "INVALID_REQUEST"},
		{"oversized body", "application/json", httpSendJSON(httpTestRoom, "fixture") + strings.Repeat(" ", 33<<10), 400, "INVALID_REQUEST"},
		{"codepoint overflow", "application/json", httpSendJSON(httpTestRoom, strings.Repeat("\U0001F408", 2049)), 400, "INVALID_REQUEST"},
		{"unseen reply refused", "application/json", `{"roomId":"` + httpTestRoom + `","text":"fixture","replyTo":"original"}`, 404, "NOT_FOUND"},
		{"unknown bot refused", "application/json", httpSendJSON(httpTestBot, "fixture"), 501, "NOT_SUPPORTED"},
		{"uncertain write", "application/json", httpSendJSON(httpTestRoom, "unknown"), 500, "INTERNAL"},
		{"limit accepted", "application/json; charset=utf-8", httpSendJSON(httpTestKnownBot, strings.Repeat("\U0001F408", 2048)), 200, ""},
	} {
		t.Run(row.name, func(t *testing.T) {
			resp := httpWire(t, server, wireRequest{"POST", "/send", httpTestBearer, row.contentType, row.body})
			body := wireAnswer(t, resp, row.status)
			if row.code != "" {
				wireError(t, body, row.code)
			}
			if strings.Contains(string(body), "synthetic confidential diagnostic") {
				t.Fatal("backend error leaked")
			}
		})
	}
	if got := attempts.Load(); got != 2 {
		t.Fatalf("expected two attempts without retry or rejected writes, got %d", got)
	}
	answer := httpWire(t, server, wireRequest{method: "GET", path: "/messages?roomId=" + httpTestKnownBot, auth: httpTestBearer})
	var page struct {
		Messages []Message `json:"messages"`
	}
	if err := json.Unmarshal(wireAnswer(t, answer, 200), &page); err != nil || len(page.Messages) != 1 ||
		page.Messages[0].Text != strings.Repeat("\U0001F408", 2048) || page.Messages[0].DeliveryStatus != "sent" {
		t.Fatalf("accepted send was not retained with its original receipt: %v", err)
	}
}
