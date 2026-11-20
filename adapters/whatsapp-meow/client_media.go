package main

import (
	"context"
	"errors"
	"strings"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	"google.golang.org/protobuf/proto"
)

func (l *link) replyContext(room string, reply *string) (*waE2E.ContextInfo, error) {
	if reply == nil {
		return nil, nil
	}
	chat, err := types.ParseJID(room)
	if err != nil || !canonicalRoom.MatchString(room) {
		return nil, &APIError{Code: "NOT_FOUND"}
	}
	if chat.IsBot() {
		return nil, &APIError{Code: "NOT_SUPPORTED"}
	}
	// Find snapshots the retained author and raw protobuf under the same lock.
	message, found := l.store.Find(room, *reply)
	if !found || message.raw == nil {
		return nil, &APIError{Code: "NOT_FOUND"}
	}
	participant, err := types.ParseJID(message.SenderID)
	if message.SenderID == "" && message.FromMe && l.client != nil {
		// Legacy locally accepted text sends may not have stored their author.
		if chat.Server == types.HiddenUserServer {
			participant = l.client.Store.GetLID()
		} else {
			participant = l.client.Store.GetJID()
		}
	}
	if err != nil || participant.User == "" {
		return nil, &APIError{Code: "NOT_FOUND"}
	}
	return &waE2E.ContextInfo{
		StanzaID: reply, Participant: proto.String(participant.ToNonAD().String()), QuotedMessage: message.raw,
	}, nil
}

func (l *link) Upload(ctx context.Context, req UploadRequest) (Message, error) {
	if code := sendStateCode(l.State()); code != "" {
		return Message{}, &APIError{Code: code}
	}
	jid, err := types.ParseJID(req.RoomID)
	if err != nil || !canonicalRoom.MatchString(req.RoomID) {
		return Message{}, &APIError{Code: "NOT_FOUND"}
	}
	if jid.IsBot() {
		return Message{}, &APIError{Code: "NOT_SUPPORTED"}
	}
	if len(req.Bytes) == 0 || len(req.Bytes) > maxUploadBytes {
		return Message{}, &APIError{Code: "INVALID_REQUEST"}
	}
	quote, err := l.replyContext(req.RoomID, req.ReplyTo)
	if err != nil {
		return Message{}, err
	}
	kind := uploadMediaType(req.MimeType, len(req.Bytes))
	uploaded, err := l.client.Upload(ctx, req.Bytes, kind)
	if err != nil {
		return Message{}, sendError(err)
	}
	raw := buildUploadedMedia(req, uploaded, quote)
	// Submit once; as in text sends this client's automatic reconnection is off.
	ack, err := l.client.SendMessage(ctx, jid, raw)
	if err != nil {
		return Message{}, sendError(err)
	}
	mapped := mapMessageEvent(&events.Message{
		Info: types.MessageInfo{
			MessageSource: types.MessageSource{
				Chat: jid, Sender: ack.Sender, IsFromMe: true, IsGroup: jid.Server == types.GroupServer,
			},
			ID: ack.ID, Timestamp: ack.Timestamp,
		},
		RawMessage: raw,
	}).message
	if mapped == nil {
		return Message{}, &APIError{Code: "INTERNAL"}
	}
	mapped.DeliveryStatus = "sent"
	return *mapped, nil
}

func uploadMediaType(mimeType string, size int) whatsmeow.MediaType {
	switch mimeType {
	case "image/jpeg", "image/png":
		if size <= 16_000_000 {
			return whatsmeow.MediaImage
		}
	case "video/mp4":
		return whatsmeow.MediaVideo
	}
	return whatsmeow.MediaDocument
}

func buildUploadedMedia(req UploadRequest, uploaded whatsmeow.UploadResponse, quote *waE2E.ContextInfo) *waE2E.Message {
	mimeType, caption := proto.String(req.MimeType), proto.String(req.Caption)
	switch uploadMediaType(req.MimeType, len(req.Bytes)) {
	case whatsmeow.MediaImage:
		return &waE2E.Message{ImageMessage: &waE2E.ImageMessage{
			URL: &uploaded.URL, DirectPath: &uploaded.DirectPath,
			MediaKey: uploaded.MediaKey, FileSHA256: uploaded.FileSHA256,
			FileEncSHA256: uploaded.FileEncSHA256, FileLength: &uploaded.FileLength,
			Mimetype: mimeType, Caption: caption, ContextInfo: quote,
		}}
	case whatsmeow.MediaVideo:
		return &waE2E.Message{VideoMessage: &waE2E.VideoMessage{
			URL: &uploaded.URL, DirectPath: &uploaded.DirectPath,
			MediaKey: uploaded.MediaKey, FileSHA256: uploaded.FileSHA256,
			FileEncSHA256: uploaded.FileEncSHA256, FileLength: &uploaded.FileLength,
			Mimetype: mimeType, Caption: caption, ContextInfo: quote,
			StreamingSidecar: uploaded.StreamingSidecar,
		}}
	default: // Only the image, video, and document variants can be classified above.
		return &waE2E.Message{DocumentMessage: &waE2E.DocumentMessage{
			URL: &uploaded.URL, DirectPath: &uploaded.DirectPath,
			MediaKey: uploaded.MediaKey, FileSHA256: uploaded.FileSHA256,
			FileEncSHA256: uploaded.FileEncSHA256, FileLength: &uploaded.FileLength,
			Mimetype: mimeType, Caption: caption, FileName: proto.String(req.Name), ContextInfo: quote,
		}}
	}
}

func (l *link) Download(ctx context.Context, raw *waE2E.Message) (MediaFile, error) {
	attachment, _, _, media, ok := mediaMetadata(raw)
	// The pinned file API uses a WhatsApp CDN direct path, not a message URL.
	if !ok || !hasMediaLocation(media) || !strings.HasPrefix(media.GetDirectPath(), "/") {
		return MediaFile{}, &APIError{Code: "NOT_FOUND"}
	}
	if code := sendStateCode(l.State()); code != "" {
		return MediaFile{}, &APIError{Code: code}
	}
	if attachment.Size > maxUploadBytes {
		return MediaFile{}, &APIError{Code: "NOT_SUPPORTED"}
	}
	deadline, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	body, err := stageMediaDownload(deadline, media, l.client.DownloadToFile)
	if err != nil {
		switch {
		case errors.Is(err, errMediaSize):
			return MediaFile{}, &APIError{Code: "NOT_SUPPORTED"}
		case errors.Is(err, whatsmeow.ErrNothingDownloadableFound), errors.Is(err, whatsmeow.ErrNoURLPresent),
			errors.Is(err, whatsmeow.ErrMediaDownloadFailedWith403), errors.Is(err, whatsmeow.ErrMediaDownloadFailedWith404),
			errors.Is(err, whatsmeow.ErrMediaDownloadFailedWith410), errors.Is(err, whatsmeow.ErrMediaNotAvailableOnPhone):
			return MediaFile{}, &APIError{Code: "NOT_FOUND"}
		default:
			return MediaFile{}, sendError(err)
		}
	}
	return MediaFile{Body: body, MimeType: attachment.MimeType, Name: attachment.Name}, nil
}
