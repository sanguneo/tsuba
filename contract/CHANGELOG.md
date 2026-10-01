# Contract changelog

Every version of `contract/openapi.json`, newest first. A client built against
version X works with an adapter answering Y when Y is in the caret range of X:
the same MAJOR and, while MAJOR is 0, the same MINOR. Inside a range changes are
additive only; anything else opens a new range. The rules and every name in use
or reserved are in [`docs/contract.md`](../docs/contract.md).

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
