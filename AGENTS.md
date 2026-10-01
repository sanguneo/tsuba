# AGENTS.md — working on tsuba

tsuba is a set of **messenger adapters**. Each adapter is its own local process
that holds one messenger account (Telegram first; Slack, Discord and others
later) and answers one shared HTTP + SSE contract, `contract/openapi.json`.
`saya` is the web client that draws it. KakaoTalk is not here: it is answered
by the `kanao`/`kamado` cores on the machine that runs the desktop client, with
their own contract, and saya connects to them directly. Do not build a
translator adapter for them; the owner decided against it on 2026-10-01, and
the reasons and what would reopen it are in `docs/contract.md`.

## Commands

Run from the repository root with Bun 1.4.2:

```sh
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun run test
```

## Layout

| Path | What it is |
| --- | --- |
| `contract/openapi.json` | The adapter contract. Consumers copy it byte for byte |
| `contract/CHANGELOG.md` | Every contract version and why it changed |
| `packages/serve-kit/` | What every adapter shares: envelope, auth, routing, capabilities, `/media` headers |
| `adapters/<provider>/` | One messenger each, built on `serve-kit` (`telegram`) |
| `docs/contract.md` | The contract's rules in one place, and every name in use or reserved |
| `docs/` | Also the per-adapter notes, deployment and the reference review |
| `tests/` | `bun test` suites; `tests/harness/` holds the no-sleep helpers |

## The contract is published here

- `contract/openapi.json` is the one file every client knows. saya copies it and
  pins its SHA-256, exactly as it does the KakaoTalk contract, so editing it is
  a release: bump `info.version` by the caret rule (additive is PATCH while
  MAJOR is 0; removing, renaming or changing a meaning opens a new MINOR), say
  why in `contract/CHANGELOG.md`, and follow the order in `docs/contract.md`.
- The document is machine-read, not only prose: `x-feature` names the one
  feature that gates each operation (and the feature an event needs),
  `x-in` the field a route-less feature rides on, `x-requires` the features
  another is declared only beside, and `x-reserved` marks feature ids with no
  route yet. serve-kit reads them and refuses a declaration that breaks them.
- **A specification nobody checks is a rumour.** `tests/contract.test.ts` asks
  the running handler whether every documented route is routed, whether the
  capability vocabulary in the document is the one `serve-kit` declares, which
  feature gates each route, and whether every error answer is filed under its
  code's status. Keep that test failing when they drift; do not loosen it.
- `.gitattributes` keeps the file's bytes identical on Windows.

## Capabilities

Adapters differ, and `GET /capabilities` is how they say so — the way an AI API
lists its models and what each supports.

- **Absent means unsupported.** A feature key an adapter does not declare is
  not supported, and a client must not draw a control for it. Never declare a
  feature an adapter cannot actually perform end to end.
- **The vocabulary is shared and open.** Feature ids live in
  `serve-kit/src/capabilities.ts` and in the contract together. Clients ignore
  ids they do not know, so adding one is additive; changing what an existing id
  or parameter means is breaking.
- **Declare limits, not hopes.** A parameter such as `maxLength` is the limit
  the messenger enforces, measured or documented, with the source in a comment.
- **Rooms narrow, never add.** Where one room allows less than the network
  (a channel the account cannot post in), the room carries `features` saying
  so; serve-kit rejects a room that names an undeclared feature.
- **Account kind is part of the truth.** `account.kind` says whether the adapter
  acts as the user, a bot, or an official account. Discord is bot-only (user
  automation breaks its terms); WeChat personal accounts have no official API
  and are not built here.

## Rules carried over from the cores and saya

- **No real data, ever** — not in fixtures, tests, logs, screenshots or commits.
- **The token is a password**, and so is every messenger session or API key an
  adapter holds. Never logged, never committed (`sessions/` is ignored), bound to
  loopback by default; compared in constant time.
- **No sleeps and no timing assumptions in tests.** Subscribe to the event, then
  await it with a bounded deadline (`tests/harness/barriers.ts`).
- **Stubs must fail the way production fails**: a fake messenger that cannot
  answer 401, 429, 503 or a malformed payload proves nothing about those paths.
- **Ambiguity is refused with candidates attached**, never resolved by taking
  the first match.
- **`submitted` is not delivered.** Say only what the messenger confirmed; the
  send capability's `receipt` declares how much that is.
- An uncertain send is never retried automatically.
- **Only `INTERNAL` means "unknown".** Map every refusal the messenger states to
  the code that says nothing changed (`FORBIDDEN`, `REAUTH_REQUIRED`,
  `RATE_LIMITED`, `NOT_FOUND`); an unmapped error stays `INTERNAL`.
- **Files are someone else's bytes.** An adapter hands `/media` a stream, a type
  and a name; serve-kit alone decides the headers that keep them inert.

## Deliberately absent

Login automation that bypasses a messenger's own sign-in, protocol
reimplementation of messengers without an official client API, history
harvesting beyond what the user's own client can see, and any adapter acting as
a user where the messenger only permits bots.
