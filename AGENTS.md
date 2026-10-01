# AGENTS.md — working on tsuba

tsuba is a set of **messenger adapters**. Each adapter is its own local process
that holds one messenger account (Telegram first; Slack, Discord and others
later) and answers one shared HTTP + SSE contract, `contract/openapi.json`.
`saya` is the web client that draws it. KakaoTalk is not here: it is answered
by the `kanao`/`kamado` cores on the machine that runs the desktop client, with
their own contract.

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
| `packages/serve-kit/` | What every adapter shares: envelope, auth, routing, capabilities |
| `adapters/<provider>/` | One messenger each, built on `serve-kit` (none yet) |
| `docs/` | Plans and the reference review |
| `tests/` | `bun test` suites; `tests/harness/` holds the no-sleep helpers |

## The contract is published here

- `contract/openapi.json` is the one file every client knows. saya copies it and
  pins its SHA-256, exactly as it does the KakaoTalk contract, so editing it is
  a release: bump `info.version`, say why in the changelog, and treat removing
  or renaming anything as breaking.
- **A specification nobody checks is a rumour.** `tests/contract.test.ts` asks
  the running handler whether every documented route is routed and whether the
  capability vocabulary in the document is the one `serve-kit` declares. Keep
  that test failing when they drift; do not loosen it.
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

## Deliberately absent

Login automation that bypasses a messenger's own sign-in, protocol
reimplementation of messengers without an official client API, history
harvesting beyond what the user's own client can see, and any adapter acting as
a user where the messenger only permits bots.
