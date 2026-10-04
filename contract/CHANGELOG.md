# Contract changelog

Every version of `contract/openapi.json`, newest first. A client built against
version X works with an adapter answering Y when Y is in the caret range of X:
the same MAJOR and, while MAJOR is 0, the same MINOR. Inside a range changes are
additive only; anything else opens a new range. The rules and every name in use
or reserved are in [`docs/contract.md`](../docs/contract.md).

## 0.2.7 — 2026-10-04

Additive: a 0.2.6 client ignores the new key and offers any file, which an
adapter declaring `types` refuses with `400` having sent nothing; a 0.2.7
client offers any file to a 0.2.6 adapter, which declares none.

### Added

- **`attachments.send` `types`**: the only media types the adapter sends, as
  lowercase `type/subtype` without parameters, so an adapter that sends
  pictures only can say so. A file whose part carries another type is
  `400 INVALID_REQUEST` and nothing is sent; absent means any type. A client
  offers only these when a person picks a file.

## 0.2.6 — 2026-10-04

Additive: `attachments.send` was reserved, so no 0.2.5 adapter declares it and
a 0.2.5 client never sees it; a 0.2.6 client draws no file control for an
adapter that does not declare it.

### Added

- **`POST /upload`** and the definition of **`attachments.send`**: one file
  sent to a room as `multipart/form-data` (`roomId`, `file`, optionally
  `caption` and `replyTo`). The feature declares `maxBytes` (the smaller of the
  messenger's limit and the adapter's own), `caption`, `captionMaxLength` when
  a caption is allowed, and `receipt` as for `messages.send`; it is no longer
  reserved, and the parameters gained `captionMaxLength` and `receipt` on being
  defined. Uploads share the adapter's one write line with `POST /send`, a
  file past `maxBytes` is `400` (refused unread when the length says so), and
  the answer is a `SendAnswer`. A room may narrow `attachments.send` to `false`.

## 0.2.5 — 2026-10-02

Additive: a 0.2.4 client ignores the new route and key, and a 0.2.5 client
draws its own mark for a 0.2.4 adapter, which declares no icon.

### Added

- **`GET /icon`** and **`Capabilities.provider.icon`**: an adapter can carry
  its provider's icon (SVG, PNG or WebP) so a client draws it without knowing
  the provider. `provider.icon` is an opaque version that changes with the
  bytes. The answer is inert like `/media` (sandbox CSP and `nosniff`), and an
  SVG with scripts, event handlers or outside references is refused at start.
  The route is open to the bearer like `/capabilities`; no feature gates it.

## 0.2.4 — 2026-10-01

Additive: a 0.2.3 client ignores the new key, and a 0.2.4 client draws a 0.2.3
adapter's messages one by one, as before.

### Added

- **`Message.groupId`**: messages the messenger shows as one album (a Telegram
  media group) share it, so a client can draw their pictures as one grid. Each
  stays its own message for replies, reactions, edits and deletion. No feature
  gates it: it is a fact about the messages, like `replyTo`.

## 0.2.3 — 2026-10-01

Additive: a 0.2.2 client works with a 0.2.3 adapter (it ignores the new key and
feature), and a 0.2.3 client with a 0.2.2 adapter (which cannot declare it, so
the client draws its own placeholder for every sender).

### Added

- **`avatars.read`** and **`Message.senderAvatar`**: the sender's profile
  picture as an opaque id that `GET /media` answers, like an attachment's. The
  bytes go through the same inert `/media` headers, so a client never fetches a
  messenger's own address. Declared only beside `attachments.read`, whose route
  serves them. A new picture carries a new id, so the private cache stays right.

## 0.2.2 — 2026-10-01

Additive: a 0.2.1 client works with a 0.2.2 adapter (it ignores the new routes,
keys and events), and a 0.2.2 client with a 0.2.1 adapter (which cannot declare
any of the new features, so the client draws none of them).

### Added

- **Replies**: `replyTo` on `POST /send`, behind `messages.reply`, which needs
  `messages.send`. Without the feature, `replyTo` is `501 NOT_SUPPORTED` and
  nothing is sent.
- **`POST /edit`** (`messages.edit`, now with a required `maxLength` beside
  `maxAgeSeconds`), **`POST /delete`** (`messages.delete`), **`POST /react`**
  (`reactions.send`, which needs `reactions.read`) and **`POST /read`**
  (`read.mark`). `/react` sets this account's reactions on a message to
  exactly the list it is given, so repeating it changes nothing more.
- **`Message.reactions`** and the **`Reaction`** schema (`emoji`, `count`,
  `mine`), behind `reactions.read`.
- **Stream events** `message.edited`, `message.deleted` and
  `reactions.updated`, sent only when `messages.stream` lists them in its new
  `events` parameter. Resume replays `message` only.
- **`x-in`** on a feature that rides on another operation's field instead of a
  route of its own, **`x-requires`** on a feature declared only beside others,
  and **`x-feature`** on an event that needs a feature, so that serve-kit and
  the tests read these from the document.

### Clarified

- Every write (`/send`, `/edit`, `/delete`, `/react`, `/read`) shares the one
  line `/send` had: one at a time, four admitted, the next `429` untouched.

Still reserved: `typing.send`, `threads.read`, `attachments.send`, and the
events `room.updated` and `typing`.

## 0.2.1 — 2026-10-01

Additive: a 0.2.0 client works with a 0.2.1 adapter, and a 0.2.1 client with a
0.2.0 adapter.

### Added

- **`FORBIDDEN` (403)**: the messenger does not let this account do this here,
  such as a channel it cannot post in or a group that restricted it. Until now
  this surfaced as `INTERNAL`, which on a write wrongly meant "outcome unknown".
- **`REAUTH_REQUIRED` (503)**: the messenger no longer accepts the adapter's
  session, so a person has to sign in again where the adapter runs. Until now
  this was `INTERNAL`, so a client could not tell it apart from a crash.
- **`Room.features`**: a room's own features where they differ from the
  declaration. A value replaces the declared one for that room, and `false`
  removes it. A room narrows the declaration and never adds to it.
  Without this, a client draws a composer in a read-only channel.
- **`Message.attachments` and `GET /media`**, behind `attachments.read`, which
  is no longer reserved. An attachment has an opaque `id`, a `kind` and what the
  messenger says about it. `/media` streams the bytes with headers that keep them
  from running at the client's origin.
- **`x-feature`** on every gated operation and **`x-reserved`** on every feature
  id that has no route yet, so that tests (and clients) read the gating from the
  document instead of from prose.

### Clarified

- Versions: the caret rule above, with additive changes inside a range.
- Writes: every error code but `INTERNAL` means nothing changed.
- Routes: reads are `GET` on a noun and writes are `POST` on a verb, one feature
  per route. A reserved feature cannot be declared, and its parameters may still
  change, until a version defines its route.
- `Message.kind`: a link preview is not media.
- Error answers are shared `components/responses`, and each feature's
  parameters are a named `Feature…` schema. There is no change on the wire.

## 0.2.0 — 2026-10-01

### Added

- `GET /rooms` (`rooms.list`), `GET /messages` (`messages.read`, `before-id`
  paging), `GET /stream` (`messages.stream`, SSE with per-room cursor resume)
  and `POST /send` (`messages.send`, one at a time, four waiting, a fifth `429`).
- `Room`, `Message`, the stream events `ready`, `message`, `cursor`, `ping` and
  `error`, and `SendRequest`/`SendAnswer`.

## 0.1.0 — 2026-10-01

### Added

- The envelope, the bearer token, `GET /health` and `GET /capabilities`, with
  the shared feature vocabulary, `x-<provider>.` extensions, `account.kind` and
  the declaration's `revision`.
