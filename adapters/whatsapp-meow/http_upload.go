package main

import (
	"io"
	"mime"
	"net/http"
	"strings"
	"unicode/utf8"
)

func (h *adapterHTTP) upload(w http.ResponseWriter, r *http.Request) {
	ready := h.writes.enter()
	if ready == nil {
		if r.ProtoMajor == 1 {
			w.Header().Set("Connection", "close")
		}
		writeFailure(w, "RATE_LIMITED")
		return
	}
	defer h.writes.leave(ready)
	req, valid := parseUpload(w, r)
	if !valid {
		writeFailure(w, "INVALID_REQUEST")
		return
	}
	select {
	case <-r.Context().Done():
		return
	case <-ready:
	}
	if r.Context().Err() != nil {
		return
	}
	if code := sendStateCode(h.sender.State()); code != "" {
		writeFailure(w, code)
		return
	}
	if strings.HasSuffix(req.RoomID, "@bot") {
		writeFailure(w, "NOT_SUPPORTED")
		return
	}
	if req.ReplyTo != nil && h.store.Raw(req.RoomID, *req.ReplyTo) == nil {
		writeFailure(w, "NOT_FOUND")
		return
	}
	transport, ok := h.sender.(mediaSender)
	if !ok {
		writeFailure(w, "NOT_SUPPORTED")
		return
	}
	message, err := transport.Upload(r.Context(), req)
	if err != nil {
		writeFailure(w, safeCode(err))
		return
	}
	if message.ID == "" || message.RoomID != req.RoomID {
		writeFailure(w, "INTERNAL")
		return
	}
	if err := h.store.Put(message, true); err != nil {
		writeFailure(w, "INTERNAL")
		return
	}
	writeJSON(w, http.StatusOK, streamMessage{success{OK: true}, &message})
}

func parseUpload(w http.ResponseWriter, r *http.Request) (UploadRequest, bool) {
	var req UploadRequest
	// Allow multipart framing and two bounded text fields in addition to file.
	const bodyLimit = maxUploadBytes + (64 << 10)
	if r.ContentLength > bodyLimit {
		return req, false
	}
	r.Body = http.MaxBytesReader(w, r.Body, bodyLimit)
	reader, err := r.MultipartReader()
	if err != nil {
		return req, false
	}
	seen := make(map[string]bool, 4)
	for {
		part, err := reader.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			return req, false
		}
		field := part.FormName()
		if seen[field] {
			part.Close()
			return req, false
		}
		seen[field] = true
		limit := int64(16 << 10)
		if field == "file" {
			limit = maxUploadBytes
		}
		data, readErr := io.ReadAll(io.LimitReader(part, limit+1))
		closeErr := part.Close()
		if readErr != nil || closeErr != nil || int64(len(data)) > limit {
			return req, false
		}
		switch field {
		case "roomId", "caption", "replyTo":
			if part.FileName() != "" || !utf8.Valid(data) {
				return req, false
			}
			switch field {
			case "roomId":
				req.RoomID = string(data)
			case "caption":
				req.Caption = string(data)
			case "replyTo":
				value := string(data)
				if value == "" {
					return req, false
				}
				req.ReplyTo = &value
			}
		case "file":
			if part.FileName() == "" || len(data) == 0 {
				return req, false
			}
			req.Bytes, req.Name = data, part.FileName()
			req.MimeType, _, err = mime.ParseMediaType(part.Header.Get("Content-Type"))
			if err != nil {
				req.MimeType = "application/octet-stream"
			}
			req.MimeType = strings.ToLower(req.MimeType)
		default:
			return req, false
		}
	}
	return req, seen["file"] && canonicalRoom.MatchString(req.RoomID) &&
		utf8.RuneCountInString(req.Caption) <= maxCaption
}
