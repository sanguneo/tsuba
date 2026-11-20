package main

import (
	"context"
	"strings"
)

func (h *adapterHTTP) messageAvatars(ctx context.Context, messages []Message) []Message {
	if h.avatars == nil || h.sender.State() != "open" {
		return messages
	}
	ids := make([]string, 0, len(messages))
	for _, message := range messages {
		if !message.FromMe && message.SenderID != "" && !strings.HasSuffix(message.SenderID, "@g.us") {
			ids = append(ids, message.SenderID)
		}
	}
	photos := h.avatars.resolveRooms(ctx, ids)
	for i := range messages {
		if !messages[i].FromMe {
			messages[i].SenderAvatar = photos[messages[i].SenderID]
		}
	}
	return messages
}
