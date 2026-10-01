# Contract changelog

Every version of `contract/openapi.json`, newest first. A client built against
version X works with an adapter answering Y when Y is in the caret range of X:
the same MAJOR and, while MAJOR is 0, the same MINOR. Inside a range changes are
additive only; anything else opens a new range. The rules and every name in use
or reserved are in [`docs/contract.md`](../docs/contract.md).

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
