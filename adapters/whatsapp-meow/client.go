package main

import (
	"context"
	"errors"
	"regexp"
	"sync"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"
	"google.golang.org/protobuf/proto"
)

// link owns one connection. Reads remain available during reconnects, but a
// logged-out device must be linked explicitly by the owner.
type link struct {
	client *whatsmeow.Client
	store  *Store
	mu     sync.RWMutex
	state  string
}

func (l *link) State() string {
	l.mu.RLock()
	defer l.mu.RUnlock()
	return l.state
}

func (l *link) setState(state string) {
	l.mu.Lock()
	l.state = state
	l.mu.Unlock()
}

func (l *link) CanSendBot(ctx context.Context, room string) bool {
	if l.State() != "open" {
		return false
	}
	jid, err := types.ParseJID(room)
	if err != nil || !jid.IsBot() {
		return false
	}
	if jid != types.MuseJID {
		return jid == types.NewMetaAIJID
	}
	// Match the pinned upstream encryptWASAMessage preconditions. No secret or
	// root identifier leaves this method.
	root, err := l.client.Store.ChatSettings.GetWASARootSecretID(ctx, jid)
	if err != nil || root == "" {
		return false
	}
	own := l.client.Store.GetLID().ToNonAD()
	if own.IsEmpty() {
		return false
	}
	secret, _, err := l.client.Store.MsgSecrets.GetMessageSecret(ctx, jid, own, root)
	return err == nil && len(secret) == 32
}

func (l *link) Send(ctx context.Context, request SendRequest) (Message, error) {
	switch l.State() {
	case "open":
	case "logged-out":
		return Message{}, &APIError{Code: "REAUTH_REQUIRED"}
	case "forbidden":
		return Message{}, &APIError{Code: "FORBIDDEN"}
	default:
		return Message{}, &APIError{Code: "BUSY"}
	}
	jid, err := types.ParseJID(request.RoomID)
	if err != nil || jid.Device != 0 {
		return Message{}, &APIError{Code: "NOT_FOUND"}
	}
	if jid.IsBot() && !l.CanSendBot(ctx, request.RoomID) {
		return Message{}, &APIError{Code: "NOT_SUPPORTED"}
	}
	// Automatic reconnection is disabled at construction. Upstream retryFrame
	// cannot resend an uncertain frame because this client never reconnects.
	response, err := l.client.SendMessage(ctx, jid, &waE2E.Message{
		Conversation: proto.String(request.Text),
	})
	if err != nil {
		return Message{}, sendError(err)
	}
	return Message{
		ID: response.ID, RoomID: request.RoomID, Sender: "Me",
		Text: request.Text, Kind: "text", FromMe: true,
		SentAt:         response.Timestamp.UTC().Format(time.RFC3339Nano),
		DeliveryStatus: "sent",
	}, nil
}

func sendError(err error) error {
	// SendMessage exposes server ACK refusals as a wrapped sentinel plus code,
	// not IQError. Parse only that sentinel's documented numeric wire suffix.
	if errors.Is(err, whatsmeow.ErrServerReturnedError) {
		pattern := regexp.MustCompile(regexp.QuoteMeta(whatsmeow.ErrServerReturnedError.Error()) + ` ([0-9]+)$`)
		matches := pattern.FindStringSubmatch(err.Error())
		if len(matches) == 2 {
			switch matches[1] {
			case "400":
				return &APIError{Code: "INVALID_REQUEST"}
			case "401":
				return &APIError{Code: "REAUTH_REQUIRED"}
			case "403":
				return &APIError{Code: "FORBIDDEN"}
			case "404":
				return &APIError{Code: "NOT_FOUND"}
			case "429":
				return &APIError{Code: "RATE_LIMITED"}
			}
		}
	}
	switch {
	case errors.Is(err, whatsmeow.ErrNotLoggedIn):
		return &APIError{Code: "REAUTH_REQUIRED"}
	case errors.Is(err, whatsmeow.ErrIQNotAuthorized):
		return &APIError{Code: "REAUTH_REQUIRED"}
	case errors.Is(err, whatsmeow.ErrIQForbidden), errors.Is(err, whatsmeow.ErrNotInGroup),
		errors.Is(err, whatsmeow.ErrNoPermissionInGroup):
		return &APIError{Code: "FORBIDDEN"}
	case errors.Is(err, whatsmeow.ErrIQNotFound), errors.Is(err, whatsmeow.ErrGroupNotFound),
		errors.Is(err, whatsmeow.ErrRecipientNotOnWhatsApp):
		return &APIError{Code: "NOT_FOUND"}
	case errors.Is(err, whatsmeow.ErrIQRateOverLimit):
		return &APIError{Code: "RATE_LIMITED"}
	default:
		return &APIError{Code: "INTERNAL"}
	}
}
