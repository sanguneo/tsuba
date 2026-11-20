package main

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

type adapterHTTP struct {
	token   [sha256.Size]byte
	store   *Store
	sender  Sender
	writes  writeLine
	streams chan struct{}
}

func NewHandler(token string, store *Store, sender Sender) (http.Handler, error) {
	if !utf8.ValidString(token) || utf8.RuneCountInString(token) < 16 ||
		strings.ContainsFunc(token, func(r rune) bool { return unicode.IsSpace(r) || r == '\ufeff' }) {
		return nil, errors.New("adapter token must be at least 16 characters without whitespace")
	}
	declaration, err := newCapabilities()
	if err != nil {
		return nil, err
	}
	h := &adapterHTTP{
		token: sha256.Sum256([]byte(token)), store: store, sender: sender,
		streams: make(chan struct{}, 8),
	}
	type route struct {
		method string
		handle http.HandlerFunc
	}
	unsupported := func(w http.ResponseWriter, _ *http.Request) { writeFailure(w, "NOT_SUPPORTED") }
	routes := map[string]route{
		"/health": {http.MethodGet, func(w http.ResponseWriter, _ *http.Request) {
			writeJSON(w, http.StatusOK, success{OK: true})
		}},
		"/capabilities": {http.MethodGet, func(w http.ResponseWriter, _ *http.Request) {
			writeJSON(w, http.StatusOK, declaration)
		}},
		// Unlike feature routes, the contract specifies 404 for a missing icon.
		"/icon": {http.MethodGet, func(w http.ResponseWriter, _ *http.Request) {
			writeFailure(w, "NOT_FOUND")
		}},
		"/rooms":    {http.MethodGet, h.rooms},
		"/messages": {http.MethodGet, h.messages},
		"/stream":   {http.MethodGet, h.stream},
		"/media":    {http.MethodGet, unsupported},
		"/send":     {http.MethodPost, h.send},
		"/upload":   {http.MethodPost, unsupported},
		"/edit":     {http.MethodPost, unsupported},
		"/delete":   {http.MethodPost, unsupported},
		"/react":    {http.MethodPost, unsupported},
		"/read":     {http.MethodPost, unsupported},
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/health" && !h.authorized(r) {
			writeFailure(w, "UNAUTHORIZED")
			return
		}
		match, found := routes[r.URL.Path]
		switch {
		case !found:
			writeFailure(w, "NOT_FOUND")
		case match.method != r.Method:
			w.Header().Set("Allow", match.method)
			writeFailure(w, "METHOD_NOT_ALLOWED")
		default:
			match.handle(w, r)
		}
	}), nil
}

func (h *adapterHTTP) authorized(r *http.Request) bool {
	values := r.Header.Values("Authorization")
	if len(values) != 1 {
		return false
	}
	token, ok := strings.CutPrefix(values[0], "Bearer ")
	if !ok {
		return false
	}
	digest := sha256.Sum256([]byte(token))
	return subtle.ConstantTimeCompare(digest[:], h.token[:]) == 1
}

// Room IDs never carry a device suffix; bot and direct room users are decimal.
var canonicalRoom = regexp.MustCompile(`^(?:[0-9]+@(?:s\.whatsapp\.net|lid|bot)|[0-9]+(?:-[0-9]+)?@g\.us)$`)

func (h *adapterHTTP) rooms(w http.ResponseWriter, r *http.Request) {
	state := h.sender.State()
	if state == "logged-out" {
		writeFailure(w, "REAUTH_REQUIRED")
		return
	}
	rooms := append([]Room{}, h.store.Rooms()...)
	for i := range rooms {
		room := &rooms[i]
		room.Features = nil
		if strings.HasSuffix(room.ID, "@bot") &&
			(state != "open" || !h.sender.CanSendBot(r.Context(), room.ID) || h.sender.State() != "open") {
			room.Features = map[string]bool{"messages.send": false}
		}
	}
	writeJSON(w, http.StatusOK, struct {
		success
		Rooms    []Room `json:"rooms"`
		Complete bool   `json:"complete"`
	}{success{OK: true}, rooms, false})
}

const maxMessagePage = 100

func (h *adapterHTTP) messages(w http.ResponseWriter, r *http.Request) {
	query, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil {
		writeFailure(w, "INVALID_REQUEST")
		return
	}
	room, before := query.Get("roomId"), query.Get("before")
	limit := 50
	if query.Has("limit") {
		raw := query.Get("limit")
		limit, err = strconv.Atoi(raw)
		if err != nil || strings.ContainsFunc(raw, func(r rune) bool { return r < '0' || r > '9' }) ||
			limit < 1 || limit > maxMessagePage {
			writeFailure(w, "INVALID_REQUEST")
			return
		}
	}
	if !canonicalRoom.MatchString(room) || (query.Has("before") && before == "") {
		writeFailure(w, "INVALID_REQUEST")
		return
	}
	if h.sender.State() == "logged-out" {
		writeFailure(w, "REAUTH_REQUIRED")
		return
	}
	messages, earlier, err := h.store.Page(room, limit, before)
	if err != nil {
		code := safeCode(err)
		// An unseen chat has an empty current window, but an unseen cursor
		// cannot be honored. Match the existing WhatsApp adapter.
		if code != "NOT_FOUND" || before != "" {
			writeFailure(w, code)
			return
		}
	}
	if messages == nil {
		messages = []Message{}
	}
	writeJSON(w, http.StatusOK, struct {
		success
		Messages   []Message `json:"messages"`
		HasEarlier bool      `json:"hasEarlier"`
	}{success{OK: true}, messages, earlier})
}

type success struct {
	OK bool `json:"ok"`
}

type failure struct {
	OK    bool      `json:"ok"`
	Error errorBody `json:"error"`
}

type errorBody struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type failureSpec struct {
	status  int
	message string
}

var httpFailures = map[string]failureSpec{
	"UNAUTHORIZED":       {401, "A valid bearer token is required"},
	"INVALID_REQUEST":    {400, "Invalid request"},
	"NOT_FOUND":          {404, "Not found"},
	"METHOD_NOT_ALLOWED": {405, "Method not allowed"},
	"NOT_SUPPORTED":      {501, "This feature is not supported"},
	"RATE_LIMITED":       {429, "The request limit has been reached"},
	"BUSY":               {503, "The adapter is busy or WhatsApp is not connected"},
	"INTERNAL":           {500, "The outcome is unknown"},
	"FORBIDDEN":          {403, "WhatsApp refused this operation"},
	"REAUTH_REQUIRED":    {503, "WhatsApp is not linked or was logged out"},
}

func safeCode(err error) string {
	code := ""
	if pointer, ok := errors.AsType[*APIError](err); ok && pointer != nil {
		code = pointer.Code
	}
	if _, known := httpFailures[code]; known {
		return code
	}
	return "INTERNAL"
}

func writeFailure(w http.ResponseWriter, code string) {
	spec := httpFailures[code]
	writeJSON(w, spec.status, failure{Error: errorBody{code, spec.message}})
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(body); err != nil {
		return // The response is already committed or the client disconnected.
	}
}
