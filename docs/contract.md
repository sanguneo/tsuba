# 어댑터 계약 길잡이

규범은 [`contract/openapi.json`](../contract/openapi.json) 하나입니다. 이 문서는 그
규칙을 한곳에 풀어 쓰고, **지금 쓰는 이름과 앞으로 쓸 이름(예약)** 을 모아 둔
대장입니다. 둘이 어긋나면 계약이 맞고 이 문서를 고칩니다. 버전마다 바뀐 것은
[`contract/CHANGELOG.md`](../contract/CHANGELOG.md) 에 있습니다.

## 버전과 호환

`info.version` 은 `MAJOR.MINOR.PATCH` 이고, 어댑터는 `GET /capabilities` 의
`contract.version` 으로 그 값을 알립니다.

- **caret 규칙**: X 로 만든 클라이언트는 Y 를 답하는 어댑터와 MAJOR 가 같고, MAJOR 가 0 인
  동안에는 MINOR 까지 같을 때 함께 동작합니다.
- **범위 안에서는 추가만 합니다.** 라우트, 키, 기능 id, enum 값, 오류 코드, 이벤트를 더하는
  것은 PATCH(0.x) 또는 MINOR(1.0 이후)입니다.
- **나머지는 깨지는 변화입니다.** 무엇을 지우거나 이름을 바꾸거나 뜻을 바꾸면 새 범위를
  엽니다. 1.0 전에는 MINOR, 1.0 이후에는 MAJOR 를 올립니다.
- 범위 밖의 어댑터를 만난 클라이언트는 그렇다고 말하고, 그 어댑터에서는 아무것도 그리지
  않습니다.

| 클라이언트 | 어댑터 | 함께 동작? |
| --- | --- | --- |
| 0.2.1 | 0.2.0 | 예. 클라이언트가 0.2.1 에서 더해진 것이 없다고 보고 그립니다 |
| 0.2.0 | 0.2.1 | 예. 모르는 키와 코드는 무시하거나 기본 분기로 보냅니다 |
| 0.2.x | 0.3.0 | 아니요 |
| 1.2.0 | 1.5.3 | 예 |

## 모르는 것을 받았을 때

- 모르는 키, 기능 id, 이벤트는 무시합니다.
- 모르는 enum 값은 그 필드가 뜻할 수 있는 가장 작은 것, 즉 목록의 첫 값으로 봅니다
  (`Attachment.kind` 라면 `file`).
- 모르는 오류 코드는 기본 분기로 보냅니다.

## 봉투와 오류 코드

JSON 응답은 모두 봉투입니다: `{"ok": true, …}` 또는
`{"ok": false, "error": {"code", "message"}}`. 코드마다 HTTP 상태가 하나로 정해져
있습니다.

| 코드 | 상태 | 뜻 | 쓰기에서 |
| --- | --- | --- | --- |
| `UNAUTHORIZED` | 401 | 베어러 토큰이 없거나 틀림 | 바뀐 것 없음 |
| `INVALID_REQUEST` | 400 | 요청이 잘못됐거나 신고한 한계를 넘음 | 바뀐 것 없음 |
| `FORBIDDEN` | 403 | 메신저가 이 계정에 여기서 그 일을 허락하지 않음 (글을 못 쓰는 채널, 제한·차단된 그룹) | 바뀐 것 없음 |
| `NOT_FOUND` | 404 | 이 계정에 그런 라우트·방·메시지·첨부가 없음 | 바뀐 것 없음 |
| `METHOD_NOT_ALLOWED` | 405 | 다른 메서드로 답하는 라우트; `Allow` 에 이름 | 바뀐 것 없음 |
| `RATE_LIMITED` | 429 | 어댑터 대기열이 찼거나 메신저가 늦추라고 함 | 바뀐 것 없음 |
| `INTERNAL` | 500 | 어댑터가 실패함; 메시지에 계정 정보 없음 | **결과를 모름** |
| `NOT_SUPPORTED` | 501 | 그 라우트의 기능을 신고하지 않음 | 바뀐 것 없음 |
| `BUSY` | 503 | 스트림을 받을 만큼 받음(8개) | — |
| `REAUTH_REQUIRED` | 503 | 메신저가 어댑터의 세션을 더는 받지 않음(로그아웃·해지·만료). 어댑터가 도는 곳에서 사람이 다시 로그인 | 바뀐 것 없음 |

**쓰기 규칙.** `INTERNAL` 이 아닌 오류는 아무것도 바꾸지 않았다는 뜻입니다.
`INTERNAL`, 시간 초과, 끊긴 연결은 결과를 모른다는 뜻입니다. 어댑터는 그런 쓰기를 다시
시도하지 않고, 클라이언트도 스스로 되풀이하지 않고 그렇다고 말합니다.

## 기능 대장

`GET /capabilities` 의 `features` 에 있는 것만 지원합니다(**없으면 지원하지 않음**).
매개변수는 메신저가 실제로 강제하는 한계입니다. **예약** 은 이름만 정해 둔 것입니다.
그런 기능은 어떤 어댑터도 신고할 수 없고(serve-kit 이 시작할 때 거절), 라우트가 정해질
때까지 매개변수가 바뀔 수 있습니다. 계약에서는 `x-reserved: true` 로 표시합니다.

| 기능 id | 상태 | 라우트·자리 | 매개변수 |
| --- | --- | --- | --- |
| `rooms.list` | 정의 | `GET /rooms` | — |
| `messages.read` | 정의 | `GET /messages` | `paging` (`none`·`before-id`), `maxLimit` |
| `messages.stream` | 정의 | `GET /stream` | `resume` (`none`·`cursor`) |
| `messages.send` | 정의 | `POST /send` | `maxLength`(코드 포인트), `receipt` (`accepted`·`stored`) |
| `attachments.read` | 정의 (0.2.1) | `Message.attachments`, `GET /media` | — |
| `messages.reply` | 예약 | `POST /send` 의 `replyTo` | — |
| `messages.edit` | 예약 | `POST /edit` | `maxAgeSeconds?` |
| `messages.delete` | 예약 | `POST /delete` | `forEveryone` |
| `reactions.read` | 예약 | `Message.reactions` | — |
| `reactions.send` | 예약 | `POST /react` | `maxPerMessage?` |
| `read.mark` | 예약 | `POST /read` | — |
| `typing.send` | 예약 | `POST /typing` | — |
| `threads.read` | 예약 | `GET /thread` | — |
| `attachments.send` | 예약 | `POST /upload` | `maxBytes`, `caption` |

## 방별 기능 (`Room.features`)

신고는 메신저 전체에 대한 것입니다. 방마다 다르면 그 방이 `features` 를 가집니다.

- 키가 있으면 그 방에서는 신고된 값 대신 이 값을 씁니다. `false` 는 그 방에서 지원하지
  않는다는 뜻입니다.
- 키가 없으면 신고된 값을 그대로 씁니다.
- **좁히기만 합니다.** 신고하지 않은 기능은 방에도 나올 수 없습니다(serve-kit 이 `/rooms`
  답에서 확인).

예: Telegram 에서 이 계정이 글을 올릴 수 없는 채널은
`"features": {"messages.send": false}` 를 가지고, 클라이언트는 그 방에 입력창을 그리지
않습니다.

## 라우트 규칙

- 읽기는 명사에 `GET`(`/rooms`, `/messages`, `/media`, 예약 `/thread`), 쓰기는 동사에
  `POST`(`/send`, 예약 `/edit`·`/delete`·`/react`·`/read`·`/typing`·`/upload`)입니다.
- 라우트 하나를 기능 하나가 엽니다. 계약의 각 operation 이 `x-feature` 로 그 기능을
  밝힙니다(`/health`, `/capabilities` 는 열려 있음).
- 문서에 있는 라우트는 모든 어댑터가 라우팅합니다. 기능을 신고하지 않았으면 인증 뒤
  `501 NOT_SUPPORTED` 로 답합니다.
- 쓰기 본문은 JSON 이고 방은 `roomId`, 메시지는 `messageId` 로 가리킵니다. id 는 모두
  불투명한 문자열입니다.

## 스트림 이벤트

`GET /stream` 이 지금 보내는 이벤트는 `ready`(한 번), `message`(새 메시지),
`cursor`(그 메시지들 **뒤에**, 방별 마지막 id), `ping`(조용할 때),
`error`(끝나기 전에 한 번)입니다.
클라이언트는 이 버전이 나열하지 않은 이벤트를 건너뜁니다. 새 이벤트의 이름은
`<대상>.<과거분사>` 꼴로 짓습니다. 다음 이름은 예약해 두었습니다.

| 이벤트 | 페이로드(계획) | 함께 올 기능 |
| --- | --- | --- |
| `message.edited` | `{ok, message}` — 수정된 메시지 전체 | 받는 쪽 수정 반영 |
| `message.deleted` | `{ok, roomId, messageIds}` | 받는 쪽 삭제 반영 |
| `reactions.updated` | `{ok, roomId, messageId, reactions}` | `reactions.read` |
| `room.updated` | `{ok, room}` — 제목·안 읽음 수·마지막 메시지 | 목록 실시간 갱신 |
| `typing` | `{ok, roomId, senderId}` | 입력 중 표시 |

이벤트가 정의되면 `messages.stream` 의 매개변수로 보내는 이벤트를 밝힙니다. 그 전에는
보내지 않습니다.

## 첨부와 `/media`

`attachments.read` 를 신고한 어댑터의 메시지는 `attachments` 를 가집니다. 각 첨부의 모양은
`{id, kind, name?, mimeType?, size?, width?, height?, durationSeconds?}` 입니다.

- `kind`: `file`(받을 것), `image`, `video`, `audio`, `voice`, `sticker`, `animation`.
- `id` 는 불투명하고 `GET /media?id=` 가 그 바이트를 답합니다. 같은 id 는 답하는 동안 늘 같은
  바이트를 답합니다. 메시지의 파일이 바뀌면 id 도 바뀝니다. 그래서 응답은
  `cache-control: private, max-age=86400` 입니다.
- 바이트는 남이 보낸 것이라, 클라이언트의 출처에서 열려도 아무것도 실행되지 않게 답합니다.
  - 늘 `content-security-policy: default-src 'none'; sandbox` 와 `x-content-type-options: nosniff` 를 붙입니다.
  - 브라우저가 실행 없이 그리거나 재생하는 형식만 제 타입과 `inline` 으로 답합니다. JPEG·PNG·GIF·WebP·AVIF 이미지, MP4·WebM·Ogg 동영상, MPEG·Ogg·MP4·AAC·WebM·WAV·FLAC 오디오입니다.
  - 그 밖의 형식(HTML, SVG 포함)은 `application/octet-stream` 과 `attachment` 로 답합니다.
  - 파일 이름은 `filename*`(UTF-8, 퍼센트 인코딩)와 출력 가능한 ASCII `filename` 에 담습니다.
- `name` 과 `mimeType` 은 보낸 사람이 정한 것입니다. 화면에는 글자로만 쓰고 경로로 쓰지
  않습니다.

## 확장 이름공간

공유 어휘에 없는 제공자 고유의 것은 `x-<provider>.` 아래에 둡니다. 기능 id(`x-telegram.topics`),
이벤트, 객체의 키 모두 같습니다. 모르는 클라이언트는 무시합니다. 여러 어댑터가 같은 것을 원하게
되면 공유 어휘로 옮기고, 그것은 추가로 다룹니다.

## 계약에 무엇을 더하는 순서

1. 이름이 아직 없으면 기능 대장에 예약으로 넣습니다(`x-reserved`).
2. 라우트·페이로드·이벤트를 계약에 정의하고, operation 에 `x-feature` 를 달고, 기능의 `x-reserved` 를 지웁니다.
3. serve-kit 의 신고 ↔ 백엔드 메서드 짝과 라우트를 더합니다. `tests/contract.test.ts` 가 계약과 어긋나면 실패합니다.
4. `info.version` 을 올리고(범위 안의 추가는 PATCH), `contract/CHANGELOG.md` 에 이유를 씁니다.
5. 어댑터에 구현하고 신고합니다. 신고는 끝까지 할 수 있을 때만 합니다.
6. saya 에 계약을 바이트 그대로 복사하고 SHA-256 을 고정한 뒤 `contract:generate` 를 돌립니다.
