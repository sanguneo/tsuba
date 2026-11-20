# WhatsApp (whatsmeow)

`adapters/whatsapp-meow` is an additional Go provider, not a replacement for
the Baileys `whatsapp-user` implementation. It speaks the unchanged tsuba
contract 0.2.9 as `provider.id: whatsapp-meow`, `account.kind: user`.
It uses upstream `go.mau.fi/whatsmeow`
`v0.0.0-20261116172437-19d61352436f`, the version selected by the owner.
This is an unofficial linked-device client with the same account-suspension
risk described in [whatsapp-user.md](whatsapp-user.md).

## Build and check

From the repository root, use Go 1.27.4 or a compatible newer toolchain:

```sh
(
cd adapters/whatsapp-meow
go mod download
go test -race -shuffle=on -count=1 ./...
go vet ./...
go build -o ../../dist/whatsapp-meow .
)
```

The result is a separate single executable. The Bun `tsuba` dispatcher and
`deploy/tsuba@.service` do not invoke it. The SQLite driver is pure Go; no
system SQLite development package is needed. Build on the target architecture
or cross-compile with the target `GOOS` and `GOARCH`.

## Configuration and private session

Unlike the Bun adapters, the Go process does not load `.env` automatically.
Supply its environment from your shell or service manager; do not print it.

| Variable | Default / meaning |
| --- | --- |
| `TSUBA_WHATSAPP_MEOW_HTTP_TOKEN` | `TSUBA_TOKEN`; at least 16 characters, no whitespace |
| `TSUBA_WHATSAPP_MEOW_PORT` | HTTP port, default `8796`; OCI uses `8799` because Caddy occupies `8796` |
| `TSUBA_HOST` | `127.0.0.1` |
| `TSUBA_WHATSAPP_MEOW_SESSION_DIR` | `sessions/whatsapp-meow`, relative to working directory |
| `TSUBA_WHATSAPP_MEOW_PAIR_PHONE_FILE` | Optional private file containing international phone digits, for pair-code login |
| `SAYA_REGISTER_URL` | Optional saya registration base URL |
| `SAYA_REGISTER_TOKEN` | Required with registration URL |
| `SAYA_ADVERTISE_URL` | `http://127.0.0.1:8796`, using the configured port |

Use a **new, dedicated directory**. Never copy `device.db`, Baileys credentials,
or another client's database into it. An ownership marker refuses a populated
foreign directory, and an exclusive lock prevents simultaneous use by two
instances of this adapter. Directory permissions are 0700, files 0600.
The marker, lock, `device.db` (including WAL/SHM), and `history.json` are all
private session data. Keep them under the ignored `sessions/` directory.

## Link once, then serve

Only the account owner should run these commands from the repository root.
Stop this provider's service before `login`; leave other clients' session
directories alone.

```sh
./dist/whatsapp-meow login
```

Login writes the current QR payload to `sessions/whatsapp-meow/qr.txt`.
It never prints the payload. To display the QR locally, use the repository's
existing QR renderer from a second terminal at the repository root. Run
`bun install --frozen-lockfile` from the root first if the workspace
dependencies are not installed. If login uses a custom session directory,
set `TSUBA_WHATSAPP_MEOW_SESSION_DIR` to the same value in both terminals.

```sh
bun -e 'import {createRequire} from "node:module"; const qr = createRequire(`${process.cwd()}/adapters/whatsapp-user/package.json`)("qrcode-terminal"); const dir = process.env.TSUBA_WHATSAPP_MEOW_SESSION_DIR || "sessions/whatsapp-meow"; qr.generate(await Bun.file(`${dir}/qr.txt`).text(), {small:true})'
```

Scan it in **WhatsApp > Linked devices > Link a device**. Re-render when the
login terminal reports a refresh. Do not screenshot, log or send the QR.
The Go binary does not include a QR renderer or add a QR library dependency.

For pairing by phone number, put the digits in a private file without placing
them in argv, set `TSUBA_WHATSAPP_MEOW_PAIR_PHONE_FILE` to its path, and run
`login`. Read `pair-code.txt` locally and enter it in the phone's **Link with
phone number** flow. Never transmit the file or code. Pairing artifacts are
removed when login ends. Remove the operator-created phone file afterwards.

Login has an overall three-minute deadline. After pairing succeeds, it allows
up to one minute on the reconnected session to collect initial history, within
that deadline. A confirmed pairing still counts as success if this window
ends early or the reconnect never arrives. Full history is not guaranteed,
even though a newly linked device requests full sync. After `linked` and a
successful exit, start:

```sh
./dist/whatsapp-meow serve
```

On OCI, set `TSUBA_WHATSAPP_MEOW_PORT=8799` in the service environment.

For a service, use an absolute executable path, a fixed working directory,
the same user and session directory as login, `UMask=0077`, and the above
environment names. SIGINT/SIGTERM shuts down HTTP and removes its saya lease.
No deployment or live account linking is performed by this PR.

## saya switch and rollback

Set `SAYA_REGISTER_URL` and `SAYA_REGISTER_TOKEN` as for existing adapters;
use `SAYA_ADVERTISE_URL` when saya reaches this machine over the tailnet.
The provider displays as **WhatsApp** with the same icon as the Baileys
adapter. It keeps the **whatsapp-meow** ID, so saya can list it alongside
**whatsapp-user** without a client change. Select the new provider in saya.
To use only the new one, the operator can stop the Baileys service after
confirming the new provider works. Do not reuse either one's session files.

To roll back, stop the Go provider and select/restart the existing
`whatsapp-user` service with its original working directory and credentials.
Normal shutdown deregisters immediately; otherwise saya's lease expires.
Do not merge, deploy, relink, or stop another provider merely because this
lane reports its PR ready.

## Supported behavior and gaps

The room list is partial (`complete: false`), capped at 500, and excludes
archived rooms, groups the account has left, and address-book-only rows without
messages or conversation activity. Active rooms remain visible when their
messages are not readable yet, including current and legacy Meta AI addresses.
Observed participating groups and recognized bot rooms can stay
visible without a displayable message. There is no arbitrary age cutoff. Names
come from synchronized contacts, sender push names, group titles, and bot
metadata. On connection, retained rooms also recover contact/archive metadata
and reciprocal PN/LID labels from the existing local device store; one bounded
joined-group request fills known group subjects without inferring departure
from a missing row. Relinking is not needed for this metadata refresh.
Room and sender photos use the same opaque avatar ID scheme as
Baileys and are served through `/media`. Fetches and caching are bounded;
unavailable photos are omitted. Profile lookup and download jobs share four
slots, with at most 500 cached or pending identities. Positive and negative
results expire after five minutes; disconnected results are not cached.
Lists have an eight-second budget, SDK lookups three seconds, and downloads
five seconds with a 256 KiB JPEG/PNG/WebP limit. Download URLs must use an
allowlisted WhatsApp HTTPS photo host, without redirects or explicit ports.
Snapshots and their IDs are memory-only and are resolved again after restart.
Observed chat deletions purge the covered message window and its raw payloads.
At most 500 deletion cutoffs persist across restarts, preventing older history
or group snapshots from resurrecting deleted content. Genuinely newer incoming
activity can reopen a chat. Deletions already consumed before this adapter
started recording them are not recoverable from the SDK's local chat settings
alone.

Cached history supports `before-id` with a maximum page size of 100. Memory
retains 200 messages per room and restart history retains the latest 50.
Text sends return `accepted` on WhatsApp server acknowledgment, not delivery,
and are limited to 2048 Unicode code points. Quoted replies are available for
messages whose original WhatsApp payload the adapter still retains. Live SSE
includes `message.edited` and `message.deleted` with `resume: none`; reread
`/messages` after reconnecting to recover the current cached state.
Bot full revisions replace the original message even when consecutive live
revisions share an edit timestamp. IDs and the original sent time stay fixed;
strictly older or foreign edits are rejected. Receiver-relative rich bot edit
keys are accepted only when they identify this device's own account. Bot sender
labels use the known chat/contact/verified/push-name metadata on reads and live
events, so a newly synchronized label also applies to cached messages.

Received images, videos (including video notes), audio (including voice notes), documents, and
stickers appear as attachments downloadable through `/media`. View-once
media is not exposed. Uploads accept up to 64,000,000 bytes per file and
1,024 Unicode code points per caption. JPEG and PNG up to 16,000,000 bytes
are sent inline, as are MP4 files up to the upload ceiling; other uploads
are sent as documents.
Attachment sends also return `accepted` on server acknowledgment.
Downloads use the pinned SDK's direct-path API and a private staging file
that is removed when its response closes. They have a 30-second deadline
and a 64,000,000-byte plaintext ceiling. URL-only payloads without a direct
path, expired media without a usable download, and larger downloads remain
unsupported; unlike Baileys this provider does not request phone reuploads.
Bot chats support text only, without quoted replies or uploads.

The adapter consumes only messages WhatsApp pushes to its own linked device.
It parses ordinary text and Muse rich sections and skips textless bot metadata.
Recognized bot rooms can remain visible even if a payload cannot be displayed.
Muse sends require the SDK's synchronized
active WASA root secret and own LID; unavailable bots are read-only.
Unknown bot identities are not send targets. Confirmed outbound receipts
advance from sent to delivered to read without going backwards.

Outgoing edits/deletes, reactions, mark-read, typing, and older server
history are not supported. Receiving a deletion event does not let the
adapter delete messages. Names and unread counts are limited to received
history and events.

Automatic network reconnection is deliberately disabled. The pinned upstream
`SendMessage` can resend its frame after a disconnect if it reconnects; keeping
this client disconnected prevents that uncertain-send retry. An operator must
restart after an ordinary network disconnect. No HTTP send is retried.
`INTERNAL`, a timeout or a dropped response means the outcome is unknown;
check the phone before deciding what to do.

Tests use synthetic protobuf events, isolated SQLite/session directories, and
real local HTTP/SSE servers. **No live login, account send, Muse decryption,
saya deployment or phone delivery has been verified by this lane.** Those
checks require the owner's separate approval and action. A green local suite
is not evidence of successful live-account decryption.
