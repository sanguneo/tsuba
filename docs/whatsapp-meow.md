# WhatsApp (whatsmeow)

`adapters/whatsapp-meow` is an additional Go provider, not a replacement for
the Baileys `whatsapp-user` implementation. It speaks the unchanged tsuba
contract 0.2.9 as `provider.id: whatsapp-meow`, `account.kind: user`.
It uses upstream `go.mau.fi/whatsmeow`
`v0.0.0-20261116172437-19d61352436f`, the version selected by the owner.
This is an unofficial linked-device client with the same account-suspension
risk described in [whatsapp-user.md](whatsapp-user.md).

## Build and check

Use Go 1.27.4 or a compatible newer toolchain:

```sh
cd adapters/whatsapp-meow
go mod download
go test -race -shuffle=on -count=1 ./...
go vet ./...
go build -o ../../dist/whatsapp-meow .
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
| `TSUBA_WHATSAPP_MEOW_PORT` | `8796` |
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

Only the account owner should run these commands. Stop this provider's service
before `login`; leave other clients' session directories alone.

```sh
./dist/whatsapp-meow login
```

Login writes the current QR payload to `sessions/whatsapp-meow/qr.txt`.
It never prints the payload. To display the QR locally, use the repository's
existing QR renderer from a second terminal at the repository root:

```sh
bun -e 'import qr from "qrcode-terminal"; qr.generate(await Bun.file("sessions/whatsapp-meow/qr.txt").text(), {small:true})'
```

Scan it in **WhatsApp > Linked devices > Link a device**. Re-render when the
login terminal reports a refresh. Do not screenshot, log or send the QR.
The Go binary does not include a QR renderer or add a QR library dependency.

For pairing by phone number, put the digits in a private file without placing
them in argv, set `TSUBA_WHATSAPP_MEOW_PAIR_PHONE_FILE` to its path, and run
`login`. Read `pair-code.txt` locally and enter it in the phone's **Link with
phone number** flow. Never transmit the file or code. Pairing artifacts are
removed when login ends. Remove the operator-created phone file afterwards.

Login has a three-minute deadline and retains the connection for up to one
minute after connection to collect initial history. This does not guarantee
complete history, even though a newly linked device requests full sync.
When it reports `linked`, start:

```sh
./dist/whatsapp-meow serve
```

For a service, use an absolute executable path, a fixed working directory,
the same user and session directory as login, `UMask=0077`, and the above
environment names. SIGINT/SIGTERM shuts down HTTP and removes its saya lease.
No deployment or live account linking is performed by this PR.

## saya switch and rollback

Set `SAYA_REGISTER_URL` and `SAYA_REGISTER_TOKEN` as for existing adapters;
use `SAYA_ADVERTISE_URL` when saya reaches this machine over the tailnet.
The provider registers as **whatsapp-meow**, so saya can list it alongside
**whatsapp-user** without a client change. Select the new provider in saya.
To use only the new one, the operator can stop the Baileys service after
confirming the new provider works. Do not reuse either one's session files.

To roll back, stop the Go provider and select/restart the existing
`whatsapp-user` service with its original working directory and credentials.
Normal shutdown deregisters immediately; otherwise saya's lease expires.
Do not merge, deploy, relink, or stop another provider merely because this
lane reports its PR ready.

## Supported behavior and gaps

The initial capability declaration includes room listing, cached text history
(`before-id`, maximum 100), live SSE (`resume: none`), and text send
(`accepted`, maximum 2048 Unicode code points). The text ceiling is the same
conservative adapter ceiling as Baileys; it is not a measured personal-account
WhatsApp maximum. Rooms are partial (`complete: false`), at most 500; memory
retains 200 messages per room and restart history retains the latest 50.

The adapter consumes only messages WhatsApp pushes to its own linked device.
It parses ordinary text and Muse rich sections, applies edits to the original
message ID, and skips textless bot metadata. Bot rooms remain visible even if
a payload cannot be displayed. Muse sends require the SDK's synchronized
active WASA root secret and own LID; unavailable bots are read-only.
Unknown bot identities are not send targets. Confirmed outbound receipts
advance from sent to delivered to read without going backwards.

Attachments, uploads, avatars, quoted replies, outgoing edits/deletes,
reactions, mark-read, typing and older server history are not declared.
Their routes answer authenticated `501 NOT_SUPPORTED`. Names and unread
counts are limited to received history/events; phone/LID aliases are not
merged. Streams cannot resume missed changes: reread `/messages` after
reconnecting.

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
