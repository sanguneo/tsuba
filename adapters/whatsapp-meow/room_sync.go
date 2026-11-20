package main

import (
	"context"
	"errors"
	"maps"
	"slices"
	"strings"
	"time"

	"go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/types"
)

const roomSyncTimeout = 10 * time.Second

type joinedGroupsSource interface {
	GetJoinedGroups(context.Context) ([]*types.GroupInfo, error)
}

// hydrateRooms seeds metadata for rooms retained by an older cache, then adds
// positive membership observations. Neither source is a stream of live events.
func (s *Store) hydrateRooms(ctx context.Context, device *store.Device, source joinedGroupsSource) error {
	ctx, cancel := context.WithTimeout(ctx, roomSyncTimeout)
	defer cancel()
	localErr := s.hydrateLocalRooms(ctx, device)
	if ctx.Err() != nil {
		return errors.Join(localErr, ctx.Err())
	}
	groups, err := source.GetJoinedGroups(ctx)
	if err != nil {
		return errors.Join(localErr, err)
	}
	return errors.Join(localErr, s.hydrateJoinedGroups(ctx, groups))
}

func (s *Store) hydrateLocalRooms(ctx context.Context, device *store.Device) error {
	s.mu.RLock()
	ids := slices.Collect(maps.Keys(s.rooms))
	s.mu.RUnlock()
	if len(ids) == 0 {
		return nil
	}
	var contacts map[types.JID]types.ContactInfo
	var readErr error
	if device.Contacts != nil {
		contacts, readErr = device.Contacts.GetAllContacts(ctx)
	}
	for _, id := range ids {
		if ctx.Err() != nil {
			break
		}
		jid, err := types.ParseJID(id)
		if err != nil || !canonicalRoom.MatchString(id) {
			continue
		}
		var settings types.LocalChatSettings
		if device.ChatSettings != nil {
			settings, err = device.ChatSettings.GetChatSettings(ctx, jid)
			if err != nil {
				settings = types.LocalChatSettings{}
				if readErr == nil {
					readErr = err
				}
			}
		}
		seed := localRoomSeed{contact: contacts[jid], settings: settings}
		if len(contacts) != 0 && !hasContactLabel(seed.contact) && device.LIDs != nil && !jid.IsBot() {
			alias, aliasErr := reciprocalRoomAlias(ctx, device, jid)
			if aliasErr != nil && readErr == nil {
				readErr = aliasErr
			}
			if hasContactLabel(contacts[alias]) {
				seed.contact, seed.alias = contacts[alias], alias.String()
			}
		}
		s.seedLocalRoom(ctx, id, seed)
	}
	return readErr
}

func hasContactLabel(contact types.ContactInfo) bool {
	return strings.TrimSpace(contact.FullName) != "" || strings.TrimSpace(contact.FirstName) != "" ||
		strings.TrimSpace(contact.PushName) != "" || strings.TrimSpace(contact.BusinessName) != ""
}

func reciprocalRoomAlias(ctx context.Context, device *store.Device, jid types.JID) (types.JID, error) {
	alias, err := device.GetAltJID(ctx, jid)
	if err != nil || !personalAlias(jid, alias) || !canonicalRoom.MatchString(alias.String()) || alias.IsBot() {
		return types.EmptyJID, err
	}
	back, err := device.GetAltJID(ctx, alias)
	if err != nil || back != jid {
		return types.EmptyJID, err
	}
	return alias, nil
}

type localRoomSeed struct {
	contact  types.ContactInfo
	settings types.LocalChatSettings
	alias    string
}

func (s *Store) seedLocalRoom(ctx context.Context, id string, seed localRoomSeed) {
	s.mu.Lock()
	defer s.mu.Unlock()
	entry, exists := s.rooms[id]
	if !exists || s.closed || ctx.Err() != nil {
		return
	}
	if seed.settings.Found && entry.Meta.ArchiveAt.IsZero() {
		entry.Meta.Archived = seed.settings.Archived
	}
	contact := seed.contact
	seedLabel := seedRoomLabel
	if seed.alias != "" {
		other := s.rooms[seed.alias].Meta
		if entry.Meta.AliasConflict || other.AliasConflict ||
			(entry.Meta.Alias != "" && entry.Meta.Alias != seed.alias) ||
			(other.Alias != "" && other.Alias != id) {
			contact = types.ContactInfo{}
		}
		seedLabel = seedMissingRoomLabel
		if !other.Contact.At.IsZero() {
			contact.FullName, contact.FirstName = "", ""
		}
		if !other.Push.At.IsZero() {
			contact.PushName = ""
		}
		if !other.Verified.At.IsZero() {
			contact.BusinessName = ""
		}
	}
	name := strings.TrimSpace(contact.FullName)
	if name == "" {
		name = strings.TrimSpace(contact.FirstName)
	}
	seedLabel(&entry.Meta.Contact, name)
	seedLabel(&entry.Meta.Push, strings.TrimSpace(contact.PushName))
	seedLabel(&entry.Meta.Verified, strings.TrimSpace(contact.BusinessName))
	// Reconstructed on each connection; avoid rewriting history once per room.
	// The ordinary Store commit path will include these fields in its next save.
	s.rooms[id] = entry
}

func seedMissingRoomLabel(label *roomLabel, name string) {
	if label.Name == "" {
		seedRoomLabel(label, name)
	}
}

func seedRoomLabel(label *roomLabel, name string) {
	if name != "" && label.At.IsZero() {
		label.Name = name
	}
}

func (s *Store) hydrateJoinedGroups(ctx context.Context, groups []*types.GroupInfo) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, group := range groups {
		if err := ctx.Err(); err != nil {
			return err
		}
		if s.closed || group == nil || group.JID.Server != types.GroupServer || !canonicalRoom.MatchString(group.JID.String()) {
			continue
		}
		id := group.JID.String()
		entry, exists := s.rooms[id]
		if !exists {
			if len(s.rooms) >= storeRoomLimit {
				continue // A group without cached activity must not displace retained history.
			}
			entry.Room = defaultRoom(group.JID)
		}
		if entry.Meta.MemberAt.IsZero() {
			entry.Meta.Observed, entry.Meta.Left = true, false
		}
		seedRoomLabel(&entry.Meta.Subject, strings.TrimSpace(group.Name))
		s.rooms[id] = entry
	}
	return ctx.Err()
}
