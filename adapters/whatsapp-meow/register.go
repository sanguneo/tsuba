package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

type registration struct {
	Kind  string `json:"kind"`
	ID    string `json:"id"`
	URL   string `json:"url,omitempty"`
	Token string `json:"token,omitempty"`
}

type registrar struct {
	client   *http.Client
	endpoint string
	bearer   string
	adapter  registration
}

func startRegistration(parent context.Context, port int, token string) func() {
	endpoint := os.Getenv("SAYA_REGISTER_URL")
	bearer := os.Getenv("SAYA_REGISTER_TOKEN")
	if endpoint == "" || bearer == "" {
		return func() {}
	}
	advertise := os.Getenv("SAYA_ADVERTISE_URL")
	if advertise == "" {
		advertise = "http://127.0.0.1:" + strconv.Itoa(port)
	}
	r := registrar{
		client: &http.Client{Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		}},
		endpoint: strings.TrimRight(endpoint, "/") + "/register", bearer: bearer,
		adapter: registration{Kind: "adapter", ID: "whatsapp-meow", URL: advertise, Token: token},
	}
	ctx, cancel := context.WithCancel(parent)
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			interval, err := r.send(ctx, http.MethodPost)
			if err != nil && ctx.Err() == nil {
				fmt.Fprintln(os.Stderr, "whatsapp-meow saya registration unavailable")
			}
			timer := time.NewTimer(interval)
			select {
			case <-ctx.Done():
				timer.Stop()
				return
			case <-timer.C:
			}
		}
	}()
	return func() {
		cancel()
		<-done
		ctx, cancel := context.WithTimeout(context.WithoutCancel(parent), 3*time.Second)
		defer cancel()
		if _, err := r.send(ctx, http.MethodDelete); err != nil {
			fmt.Fprintln(os.Stderr, "whatsapp-meow saya deregistration unavailable; lease will expire")
		}
	}
}

func (r registrar) send(ctx context.Context, method string) (time.Duration, error) {
	const fallback = 30 * time.Second
	payload := r.adapter
	if method == http.MethodDelete {
		payload.URL, payload.Token = "", ""
	}
	data, err := json.Marshal(payload)
	if err != nil {
		return fallback, err
	}
	request, err := http.NewRequestWithContext(ctx, method, r.endpoint, bytes.NewReader(data))
	if err != nil {
		return fallback, errors.New("invalid registration endpoint")
	}
	request.Header.Set("Authorization", "Bearer "+r.bearer)
	request.Header.Set("Content-Type", "application/json")
	response, err := r.client.Do(request)
	if err != nil {
		return fallback, errors.New("registration request failed")
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fallback, errors.New("registration refused")
	}
	if method == http.MethodDelete {
		return fallback, nil
	}
	var answer struct {
		Interval float64 `json:"interval"`
	}
	if err = json.NewDecoder(io.LimitReader(response.Body, 65536)).Decode(&answer); err != nil {
		return fallback, errors.New("malformed registration response")
	}
	if answer.Interval > 0 && answer.Interval <= 86400 {
		return time.Duration(answer.Interval * float64(time.Second)), nil
	}
	return fallback, nil
}
