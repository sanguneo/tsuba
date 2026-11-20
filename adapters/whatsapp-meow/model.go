package main

import "time"

type Message struct {
	ID             string `json:"id"`
	RoomID         string `json:"roomId"`
	SenderID       string `json:"senderId,omitempty"`
	Sender         string `json:"sender"`
	Text           string `json:"text"`
	Kind           string `json:"kind"`
	SentAt         string `json:"sentAt"`
	EditedAt       string `json:"editedAt,omitempty"`
	FromMe         bool   `json:"fromMe"`
	DeliveryStatus string `json:"deliveryStatus,omitempty"`
	ReplyTo        string `json:"replyTo,omitempty"`
}

type Room struct {
	ID             string          `json:"id"`
	Title          string          `json:"title"`
	Kind           string          `json:"kind"`
	Unread         int             `json:"unread"`
	LastActivityAt string          `json:"lastActivityAt,omitempty"`
	LastMessage    *Preview        `json:"lastMessage,omitempty"`
	Features       map[string]bool `json:"features,omitempty"`
}

type Preview struct {
	Text   string `json:"text"`
	FromMe bool   `json:"fromMe"`
}

type Update struct {
	Event      string   `json:"event"`
	Message    *Message `json:"message,omitempty"`
	RoomID     string   `json:"roomId,omitempty"`
	MessageIDs []string `json:"messageIds,omitempty"`
}

type APIError struct {
	Code string
}

func (e *APIError) Error() string {
	switch e.Code {
	case "UNAUTHORIZED":
		return "Authentication required."
	case "INVALID_REQUEST":
		return "Invalid request."
	case "NOT_FOUND":
		return "Not found."
	case "METHOD_NOT_ALLOWED":
		return "Method not allowed."
	case "NOT_SUPPORTED":
		return "Not supported."
	case "RATE_LIMITED":
		return "Rate limited."
	case "BUSY":
		return "Adapter busy."
	case "FORBIDDEN":
		return "Operation forbidden."
	case "REAUTH_REQUIRED":
		return "Sign in again."
	default:
		return "Adapter failed."
	}
}

func formatStoreTime(at time.Time) string {
	return at.UTC().Format(time.RFC3339Nano)
}

func parseStoreTime(value string) time.Time {
	// At the merge boundary an absent timestamp sorts before known timestamps.
	at, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return time.Time{}
	}
	return at
}
