package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
)

// Match the Baileys adapter's conservative ceiling: 2048 code points fit
// within 4096 UTF-16 units (the WhatsApp Cloud API text body limit).
const maxSendText = 2048

const contractVersion = "0.2.9"

type namedVersion struct {
	Name    string `json:"name"`
	Version string `json:"version"`
}

type providerIdentity struct {
	Icon string `json:"icon"`
	ID   string `json:"id"`
	Name string `json:"name"`
}

type accountIdentity struct {
	Kind string `json:"kind"`
}

type readCapability struct {
	MaxLimit int    `json:"maxLimit"`
	Paging   string `json:"paging"`
}

type streamCapability struct {
	Events []string `json:"events"`
	Resume string   `json:"resume"`
}

type sendCapability struct {
	MaxLength int    `json:"maxLength"`
	Receipt   string `json:"receipt"`
}

type adapterFeatures struct {
	AttachmentsRead struct{}         `json:"attachments.read"`
	AttachmentsSend uploadCapability `json:"attachments.send"`
	Avatars         struct{}         `json:"avatars.read"`
	Read            readCapability   `json:"messages.read"`
	Reply           struct{}         `json:"messages.reply"`
	Send            sendCapability   `json:"messages.send"`
	Stream          streamCapability `json:"messages.stream"`
	Rooms           struct{}         `json:"rooms.list"`
}

type uploadCapability struct {
	Caption          bool   `json:"caption"`
	CaptionMaxLength int    `json:"captionMaxLength"`
	MaxBytes         int    `json:"maxBytes"`
	Receipt          string `json:"receipt"`
}

// Keep declaration fields in JSON key order, as in serve-kit's canonical hash.
type capabilityDeclaration struct {
	Account  accountIdentity  `json:"account"`
	Adapter  namedVersion     `json:"adapter"`
	Features adapterFeatures  `json:"features"`
	Provider providerIdentity `json:"provider"`
}

type capabilitiesAnswer struct {
	success
	capabilityDeclaration
	Contract struct {
		Version string `json:"version"`
	} `json:"contract"`
	Revision string `json:"revision"`
}

func newCapabilities() (capabilitiesAnswer, error) {
	decl := capabilityDeclaration{
		Account:  accountIdentity{Kind: "user"},
		Adapter:  namedVersion{Name: "tsuba-whatsapp-meow", Version: "0.1.0"},
		Provider: providerIdentity{ID: "whatsapp-meow", Icon: iconVersion(), Name: "WhatsApp"},
		Features: adapterFeatures{
			AttachmentsSend: uploadCapability{Caption: true, CaptionMaxLength: maxCaption, MaxBytes: maxUploadBytes, Receipt: "accepted"},
			Read:            readCapability{MaxLimit: maxMessagePage, Paging: "before-id"},
			Send:            sendCapability{MaxLength: maxSendText, Receipt: "accepted"},
			Stream:          streamCapability{Events: []string{"message.edited", "message.deleted"}, Resume: "none"},
		},
	}
	canonical, err := json.Marshal(decl)
	if err != nil {
		return capabilitiesAnswer{}, fmt.Errorf("encode capability declaration: %w", err)
	}
	hash := sha256.Sum256(canonical)
	answer := capabilitiesAnswer{success: success{OK: true}, capabilityDeclaration: decl, Revision: hex.EncodeToString(hash[:8])}
	answer.Contract.Version = contractVersion
	return answer, nil
}
