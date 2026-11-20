package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime/multipart"
	"net/textproto"
	"strings"
	"sync/atomic"
	"testing"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"
	"google.golang.org/protobuf/proto"
)

type httpMediaSender struct {
	httpTestSender
	uploads   atomic.Int32
	downloads atomic.Int32
}

func (s *httpMediaSender) Upload(_ context.Context, req UploadRequest) (Message, error) {
	s.uploads.Add(1)
	if req.Caption == "unknown" {
		return Message{}, errors.New("synthetic private transport failure")
	}
	raw := buildUploadedMedia(req, whatsmeow.UploadResponse{
		DirectPath: "/synthetic-upload", MediaKey: []byte{1}, FileLength: uint64(len(req.Bytes)),
	}, nil)
	event := syntheticBotEvent("uploaded", raw)
	event.Info.Chat = types.NewJID("000000", types.GroupServer)
	event.Info.IsFromMe = true
	message := mapMessageEvent(event).message
	message.DeliveryStatus = "sent"
	return *message, nil
}

func (s *httpMediaSender) Download(_ context.Context, raw *waE2E.Message) (MediaFile, error) {
	s.downloads.Add(1)
	a, _, _, _, _ := mediaMetadata(raw)
	if a.Name == "missing" {
		return MediaFile{}, &APIError{Code: "NOT_FOUND"}
	}
	return MediaFile{Body: io.NopCloser(strings.NewReader("synthetic file bytes")), MimeType: a.MimeType, Name: a.Name}, nil
}

func TestHTTPMediaReadUsesRetainedProtobufAndInertHeaders(t *testing.T) {
	sender := &httpMediaSender{httpTestSender: httpTestSender{state: "open"}}
	store, handler := httpTestHarness(t, sender)
	raw := &waE2E.Message{DocumentMessage: &waE2E.DocumentMessage{
		Mimetype: new("text/html"), FileName: new("synthetic \"\ubb38\uc11c\"\r\n.html"), MediaKey: []byte{1}, DirectPath: new("/synthetic"),
	}}
	event := syntheticBotEvent("retained", raw)
	event.Info.Chat = types.NewJID("000000", types.GroupServer)
	storeMust(t, store.Apply(event, false))
	server := httpTestServer(t, handler)
	resp := httpWire(t, server, wireRequest{method: "GET", path: "/media?id=" + mediaID(httpTestRoom, "retained"), auth: httpTestBearer})
	body, err := io.ReadAll(resp.Body)
	storeMust(t, err)
	t.Logf("%s headers=%v body=%s", resp.Status, resp.Header, body)
	if resp.StatusCode != 200 || string(body) != "synthetic file bytes" || resp.Header.Get("Content-Type") != "application/octet-stream" ||
		resp.Header.Get("Content-Disposition") != `attachment; filename="synthetic ______.html"; filename*=UTF-8''synthetic%20%22%EB%AC%B8%EC%84%9C%22%0D%0A.html` ||
		resp.Header.Get("Content-Security-Policy") != "default-src 'none'; sandbox" || resp.Header.Get("X-Content-Type-Options") != "nosniff" ||
		resp.Header.Get("Cache-Control") != "private, max-age=86400" {
		t.Fatal("unsafe or incorrect media response")
	}
	for _, row := range []struct {
		path   string
		status int
		code   string
	}{
		{"/media", 400, "INVALID_REQUEST"},
		{"/media?id=message:invalid", 404, "NOT_FOUND"},
		{"/media?id=" + mediaID(httpTestRoom, "unseen"), 404, "NOT_FOUND"},
		{"/media?id=wa-room-v1-missing", 404, "NOT_FOUND"},
	} {
		response := httpWire(t, server, wireRequest{method: "GET", path: row.path, auth: httpTestBearer})
		wireError(t, wireAnswer(t, response, row.status), row.code)
	}
	if sender.downloads.Load() != 1 {
		t.Fatal("unretained ids reached transport")
	}
}

func multipartUpload(t *testing.T, fields [][2]string, file string) (string, string) {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	for _, field := range fields {
		storeMust(t, writer.WriteField(field[0], field[1]))
	}
	if file != "" {
		header := make(textproto.MIMEHeader)
		header.Set("Content-Disposition", `form-data; name="file"; filename="fixture.png"`)
		header.Set("Content-Type", "image/png")
		part, err := writer.CreatePart(header)
		storeMust(t, err)
		_, err = part.Write([]byte(file))
		storeMust(t, err)
	}
	storeMust(t, writer.Close())
	return writer.FormDataContentType(), body.String()
}

func TestHTTPUploadValidatesAndPersistsAcceptedMedia(t *testing.T) {
	sender := &httpMediaSender{httpTestSender: httpTestSender{state: "open"}}
	store, handler := httpTestHarness(t, sender)
	server := httpTestServer(t, handler)
	for _, row := range []struct {
		name   string
		fields [][2]string
		file   string
		status int
		code   string
	}{
		{"image", [][2]string{{"roomId", httpTestRoom}, {"caption", "synthetic"}}, "synthetic png", 200, ""},
		{"unknown outcome", [][2]string{{"roomId", httpTestRoom}, {"caption", "unknown"}}, "synthetic png", 500, "INTERNAL"},
		{"missing file", [][2]string{{"roomId", httpTestRoom}}, "", 400, "INVALID_REQUEST"},
		{"bad room", [][2]string{{"roomId", "bad"}}, "synthetic png", 400, "INVALID_REQUEST"},
		{"duplicate room", [][2]string{{"roomId", httpTestRoom}, {"roomId", httpTestRoom}}, "synthetic png", 400, "INVALID_REQUEST"},
		{"caption overflow", [][2]string{{"roomId", httpTestRoom}, {"caption", strings.Repeat("a", 1025)}}, "synthetic png", 400, "INVALID_REQUEST"},
		{"file overflow", [][2]string{{"roomId", httpTestRoom}}, strings.Repeat("x", maxUploadBytes+1), 400, "INVALID_REQUEST"},
		{"unseen quote", [][2]string{{"roomId", httpTestRoom}, {"replyTo", "missing"}}, "synthetic png", 404, "NOT_FOUND"},
		{"bot", [][2]string{{"roomId", httpTestBot}}, "synthetic png", 501, "NOT_SUPPORTED"},
	} {
		t.Run(row.name, func(t *testing.T) {
			contentType, body := multipartUpload(t, row.fields, row.file)
			response := httpWire(t, server, wireRequest{"POST", "/upload", httpTestBearer, contentType, body})
			wire := wireAnswer(t, response, row.status)
			if row.code != "" {
				wireError(t, wire, row.code)
				return
			}
			var answer streamMessage
			storeMust(t, json.Unmarshal(wire, &answer))
			if answer.Message == nil || answer.Message.Text != "synthetic" || answer.Message.Kind != "media" ||
				answer.Message.DeliveryStatus != "sent" || len(answer.Message.Attachments) != 1 || answer.Message.Attachments[0].Kind != "image" {
				t.Fatal("upload lost caption, media kind, or accepted receipt")
			}
		})
	}
	if sender.uploads.Load() != 2 {
		t.Fatal("rejected upload submitted or uncertain send retried")
	}
	page, _, err := store.Page(httpTestRoom, 100, "")
	storeMust(t, err)
	if len(page) != 1 || page[0].ID != "uploaded" || store.Raw(httpTestRoom, "uploaded") == nil {
		t.Fatal("accepted upload not retained for later download/reply")
	}
}

func TestReplyKnownMessageGoesThroughHTTPAndSDKContext(t *testing.T) {
	store, err := NewStore("")
	storeMust(t, err)
	defer store.Close()
	raw := &waE2E.Message{Conversation: new("synthetic original")}
	message := httpFixtureMessage(httpTestRoom, "original", "synthetic original")
	message.SenderID = "000001@s.whatsapp.net"
	message.raw = raw
	storeMust(t, store.Put(message, false))
	l := &link{store: store}
	quote, err := l.replyContext(httpTestRoom, new("original"))
	storeMust(t, err)
	if quote.GetStanzaID() != "original" || quote.GetParticipant() != message.SenderID || !proto.Equal(quote.GetQuotedMessage(), raw) {
		t.Fatal("SDK context lost retained author or quoted content")
	}
	sender := httpTestSender{state: "open", perform: func(_ context.Context, req SendRequest) (Message, error) {
		if req.ReplyTo == nil || *req.ReplyTo != "original" {
			return Message{}, errors.New("quote lost")
		}
		out := httpFixtureMessage(req.RoomID, "reply", req.Text)
		out.FromMe = true
		out.ReplyTo = *req.ReplyTo
		return out, nil
	}}
	handler, err := NewHandler(httpTestToken, store, sender)
	storeMust(t, err)
	server := httpTestServer(t, handler)
	resp := httpWire(t, server, wireRequest{"POST", "/send", httpTestBearer, "application/json", `{"roomId":"000000@g.us","text":"synthetic reply","replyTo":"original"}`})
	var answer streamMessage
	storeMust(t, json.Unmarshal(wireAnswer(t, resp, 200), &answer))
	if answer.Message == nil || answer.Message.ReplyTo != "original" {
		t.Fatal("reply identity not returned")
	}
}
