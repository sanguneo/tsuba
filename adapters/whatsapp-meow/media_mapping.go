package main

import (
	"encoding/base64"
	"strings"
	"unicode/utf8"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waE2E"
)

func mediaID(room, id string) string {
	return "message:" + base64.RawURLEncoding.EncodeToString([]byte(room+"\x00"+id))
}

func mediaLocation(id string) (string, string, bool) {
	encoded, ok := strings.CutPrefix(id, "message:")
	if !ok {
		return "", "", false
	}
	decoded, err := base64.RawURLEncoding.Strict().DecodeString(encoded)
	if err != nil || !utf8.Valid(decoded) {
		return "", "", false
	}
	room, message, ok := strings.Cut(string(decoded), "\x00")
	return room, message, ok && canonicalRoom.MatchString(room) && message != "" &&
		!strings.ContainsRune(message, '\x00') && mediaID(room, message) == id
}

// Only media exposed by the Baileys provider is represented. A payload without
// download credentials may still have a caption, but has no attachment control.
func mediaMetadata(raw *waE2E.Message) (Attachment, string, string, whatsmeow.DownloadableMessage, bool) {
	var a Attachment
	var caption, reply string
	var downloadable whatsmeow.DownloadableMessage
	switch {
	case raw == nil:
		return a, "", "", nil, false
	case raw.GetImageMessage() != nil:
		m := raw.GetImageMessage()
		if m.GetViewOnce() {
			return a, "", "", nil, false
		}
		a = Attachment{Kind: "image", MimeType: m.GetMimetype(), Size: m.GetFileLength(), Width: m.GetWidth(), Height: m.GetHeight()}
		caption, reply, downloadable = m.GetCaption(), m.GetContextInfo().GetStanzaID(), m
	case raw.GetVideoMessage() != nil:
		m := raw.GetVideoMessage()
		if m.GetViewOnce() {
			return a, "", "", nil, false
		}
		kind := "video"
		if m.GetGifPlayback() {
			kind = "animation"
		}
		a = Attachment{Kind: kind, MimeType: m.GetMimetype(), Size: m.GetFileLength(), Width: m.GetWidth(), Height: m.GetHeight(), DurationSeconds: m.GetSeconds()}
		caption, reply, downloadable = m.GetCaption(), m.GetContextInfo().GetStanzaID(), m
	case raw.GetAudioMessage() != nil:
		m := raw.GetAudioMessage()
		if m.GetViewOnce() {
			return a, "", "", nil, false
		}
		kind := "audio"
		if m.GetPTT() {
			kind = "voice"
		}
		a = Attachment{Kind: kind, MimeType: m.GetMimetype(), Size: m.GetFileLength(), DurationSeconds: m.GetSeconds()}
		reply, downloadable = m.GetContextInfo().GetStanzaID(), m
	case raw.GetDocumentMessage() != nil:
		m := raw.GetDocumentMessage()
		a = Attachment{Kind: "file", MimeType: m.GetMimetype(), Name: m.GetFileName(), Size: m.GetFileLength()}
		caption, reply, downloadable = m.GetCaption(), m.GetContextInfo().GetStanzaID(), m
	case raw.GetStickerMessage() != nil:
		m := raw.GetStickerMessage()
		a = Attachment{Kind: "sticker", MimeType: m.GetMimetype(), Size: m.GetFileLength(), Width: m.GetWidth(), Height: m.GetHeight()}
		reply, downloadable = m.GetContextInfo().GetStanzaID(), m
	default:
		return a, "", "", nil, false
	}
	a.MimeType = strings.ToLower(strings.TrimSpace(strings.Split(a.MimeType, ";")[0]))
	return a, caption, reply, downloadable, true
}

func hasMediaLocation(m whatsmeow.DownloadableMessage) bool {
	if m == nil || len(m.GetMediaKey()) == 0 {
		return false
	}
	if m.GetDirectPath() != "" {
		return true
	}
	url, ok := m.(interface{ GetURL() string })
	return ok && url.GetURL() != ""
}
