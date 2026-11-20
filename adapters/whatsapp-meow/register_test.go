package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestRegistrationPublishesAndRemovesLeaseOverHTTP(t *testing.T) {
	calls := make(chan registration, 3)
	methods := make(chan string, 3)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/register" || r.Header.Get("Authorization") != "Bearer synthetic-register-secret" {
			t.Error("registration authentication or path mismatch")
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		var body registration
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		calls <- body
		methods <- r.Method
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(struct {
			Interval int `json:"interval"`
		}{Interval: 60}); err != nil {
			t.Error(err)
		}
	}))
	defer server.Close()
	t.Setenv("SAYA_REGISTER_URL", server.URL)
	t.Setenv("SAYA_REGISTER_TOKEN", "synthetic-register-secret")
	t.Setenv("SAYA_ADVERTISE_URL", "http://127.0.0.1:12345")
	stop := startRegistration(t.Context(), 8796, "synthetic-adapter-secret")
	select {
	case got := <-calls:
		if got.ID != "whatsapp-meow" || got.Kind != "adapter" ||
			got.URL != "http://127.0.0.1:12345" || got.Token != "synthetic-adapter-secret" {
			t.Fatalf("incorrect adapter lease: %+v", got)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("registration never arrived")
	}
	if method := <-methods; method != http.MethodPost {
		t.Fatalf("first method %s", method)
	}
	stop()
	if method := <-methods; method != http.MethodDelete {
		t.Fatalf("last method %s", method)
	}
	got := <-calls
	if got.ID != "whatsapp-meow" || got.URL != "" || got.Token != "" {
		t.Fatalf("deregistration leaked adapter credentials: %+v", got)
	}
	t.Log("HTTP registration POST accepted, DELETE removed lease; local server closed by cleanup")
}

func TestRegistrationRefusalAndMalformedResponse(t *testing.T) {
	for _, tc := range []struct {
		name string
		code int
		body string
	}{
		{"unauthorized", 401, `{"ok":false}`},
		{"busy", 503, `{"ok":false}`},
		{"malformed", 200, `not-json`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(tc.code)
				if _, err := w.Write([]byte(tc.body)); err != nil {
					t.Error(err)
				}
			}))
			defer server.Close()
			r := registrar{client: server.Client(), endpoint: server.URL, adapter: registration{ID: "synthetic"}}
			interval, err := r.send(t.Context(), http.MethodPost)
			if err == nil || interval != 30*time.Second {
				t.Fatalf("bad registration accepted: interval=%s error=%v", interval, err)
			}
		})
	}
}
