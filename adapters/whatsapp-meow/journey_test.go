package main

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"

	"go.mau.fi/whatsmeow/proto/waAICommon"
	"go.mau.fi/whatsmeow/proto/waCommon"
	"go.mau.fi/whatsmeow/proto/waE2E"
)

// This crosses the actual SDK-event -> persistence -> HTTP/SSE boundary.
// No WhatsApp connection or replacement parsing implementation is involved.
func TestHTTPBotRichJourney(t *testing.T) {
	store, handler := httpTestHarness(t, httpTestSender{state: "open"})
	server := httpTestServer(t, handler)
	response, stream := openHTTPStream(t, server, "/stream")
	wantReady(t, stream)
	original := syntheticBotEvent("rich-root", syntheticRich(`{"sections":[{"view_model":{"primitive":{"text":"synthetic first"}}}]}`))
	storeMust(t, store.Apply(original, true))
	var message streamMessage
	if err := json.Unmarshal(wantHTTPEvent(t, stream, "message"), &message); err != nil ||
		message.Message == nil || message.Message.ID != "rich-root" || message.Message.Text != "synthetic first" {
		t.Fatalf("initial rich text was not displayed: %+v (%v)", message, err)
	}
	wantHTTPEvent(t, stream, "cursor")
	edit := syntheticBotEvent("edit-envelope", &waE2E.Message{ProtocolMessage: &waE2E.ProtocolMessage{
		Type: waE2E.ProtocolMessage_MESSAGE_EDIT.Enum(),
		Key: &waCommon.MessageKey{
			ID: new("rich-root"), RemoteJID: new(syntheticBotRoom), FromMe: new(false),
		},
		EditedMessage: syntheticRich(`{"sections":[{"view_model":{"primitive":{"text":"synthetic final"}}}]}`),
	}})
	edit.Info.Timestamp = edit.Info.Timestamp.Add(time.Second)
	storeMust(t, store.Apply(edit, true))
	if err := json.Unmarshal(wantHTTPEvent(t, stream, "message.edited"), &message); err != nil ||
		message.Message == nil || message.Message.ID != "rich-root" || message.Message.Text != "synthetic final" {
		t.Fatalf("rich edit lost its identity: %+v (%v)", message, err)
	}
	metadata := syntheticBotEvent("metadata", &waE2E.Message{ProtocolMessage: &waE2E.ProtocolMessage{
		AiMetadataOperation: &waAICommon.AIMetadataOperation{},
	}})
	storeMust(t, store.Apply(metadata, true))
	page := httpWire(t, server, wireRequest{method: "GET", path: "/messages?roomId=" + syntheticBotRoom, auth: httpTestBearer})
	var answer struct {
		OK       bool      `json:"ok"`
		Messages []Message `json:"messages"`
	}
	if err := json.Unmarshal(wireAnswer(t, page, 200), &answer); err != nil ||
		!answer.OK || len(answer.Messages) != 1 || answer.Messages[0].Text != "synthetic final" ||
		answer.Messages[0].ID != "rich-root" || answer.Messages[0].SentAt != "2025-01-02T03:04:05Z" {
		t.Fatalf("HTTP history contains phantom metadata or stale content: %+v (%v)", answer, err)
	}
	if err := response.Body.Close(); err != nil {
		t.Fatal(err)
	}
	t.Log("PASS SDK rich response -> SSE message -> same-ID edit -> GET /messages; synthetic metadata absent")
}

func TestHTTPEveryContractOperationIsRoutedAndFeatureGated(t *testing.T) {
	data, err := os.ReadFile("../../contract/openapi.json")
	storeMust(t, err)
	var spec struct {
		Paths map[string]map[string]struct {
			Feature string `json:"x-feature"`
		} `json:"paths"`
	}
	storeMust(t, json.Unmarshal(data, &spec))
	_, handler := httpTestHarness(t, httpTestSender{state: "connecting"})
	server := httpTestServer(t, handler)
	capabilities, err := newCapabilities()
	storeMust(t, err)
	featuresData, err := json.Marshal(capabilities.Features)
	storeMust(t, err)
	var features map[string]json.RawMessage
	storeMust(t, json.Unmarshal(featuresData, &features))
	for path, methods := range spec.Paths {
		for method, operation := range methods {
			t.Run(method+path, func(t *testing.T) {
				response := httpWire(t, server, wireRequest{
					method: strings.ToUpper(method), path: path, auth: httpTestBearer,
				})
				defer response.Body.Close()
				switch {
				case path == "/icon":
					wireError(t, wireAnswer(t, response, 404), "NOT_FOUND")
				case operation.Feature != "" && features[operation.Feature] == nil:
					wireError(t, wireAnswer(t, response, 501), "NOT_SUPPORTED")
				default:
					if response.StatusCode == 404 || response.StatusCode == 405 || response.StatusCode == 501 {
						t.Fatalf("documented route was not implemented: %s %s => %d", method, path, response.StatusCode)
					}
					if path == "/stream" && response.Header.Get("Content-Type") != "text/event-stream" {
						t.Fatal("declared stream did not open")
					}
				}
			})
		}
	}
}
