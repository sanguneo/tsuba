# 어댑터 계약 길잡이

규범은 [`contract/openapi.json`](../contract/openapi.json) 하나입니다. 이 문서는 그
규칙을 한곳에 풀어 쓰고, **지금 쓰는 이름과 앞으로 쓸 이름(예약)** 을 모아 둔
대장입니다. 둘이 어긋나면 계약이 맞고 이 문서를 고칩니다. 버전마다 바뀐 것은
[`contract/CHANGELOG.md`](../contract/CHANGELOG.md) 에 있습니다.

## 카카오톡은 이 계약 밖에 있습니다 (2026-10-01 결정)

카카오톡은 `kanao`·`kamado` 코어가 자기 계약(`openapi.json`)으로 답하고, saya 는 그 코어에
직접 붙습니다. kanao 를 이 계약으로 옮겨 주는 번역 어댑터(`tsuba-kakao`)는 만들지 않습니다.
두 계약(카카오 0.19.0, 이 계약 0.2.1)을 대조해 보니, 감싸면 잃는 것이 얻는 것보다 컸습니다.

- **라우트**: 카카오의 `/digest`, `/notice`, `/attachments`(방 모아보기), `/revisions` 와
  `/context` 의 attention·coverage 는 이 계약에 짝이 없습니다. 살리려면 `x-kakao.*` 로
  카카오 계약을 여기에 한 번 더 써야 하고, 그러면 같은 메신저의 계약이 둘이 됩니다.
- **보내기**: 카카오는 데스크톱 입력창에 넣고 Enter 를 누르는 방식이라 `submitted` 가 전달이
  아니고, `dryRun` 확인·지워질 초안 경고·되읽기가 함께 돕니다. 이 계약의 `receipt` 모델로
  옮기면 그 안전장치가 빠집니다.
- **오류**: 카카오의 코드 16개(`AMBIGUOUS_CHAT` 의 후보 목록 포함)가 이 계약의 코드로 뭉개집니다.
- **메시지**: 멘션, 나를 향한 답장, 세이프봇 가림(`covered`), 사진·영상 주소, 보낸 사람 사진에
  짝이 없습니다.
- **운영**: 코어가 도는 기계에 프로세스와 토큰이 하나씩 더 생기고 한 단계를 더 거칩니다.

얻는 것은 클라이언트 안의 코드 경로가 하나 줏는 것뿐이고, 그건 클라이언트 안에서 할 수 있습니다.
다시 열 조건은 둘 중 하나입니다. 코어가 이 계약을 직접 답하기로 하거나, 위의 것들이 공유
어휘에 들어와 손실 없이 옮길 수 있게 됐을 때입니다.

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

**쓰기 줄.** 쓰기(`/send`, `/edit`, `/delete`, `/react`, `/read`)는 어댑터마다 줄 하나를
함께 씁니다. 한 번에 하나씩 돌고, 돌고 있는 것을 포함해 넷까지 받으며, 다섯 번째는 본문을
읽지 않고 곧바로 `429 RATE_LIMITED` 입니다.

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
| `messages.stream` | 정의 | `GET /stream` | `resume` (`none`·`cursor`), `events?` (0.2.2) |
| `messages.send` | 정의 | `POST /send` | `maxLength`(코드 포인트), `receipt` (`accepted`·`stored`) |
| `attachments.read` | 정의 (0.2.1) | `Message.attachments`, `GET /media` | — |
| `avatars.read` | 정의 (0.2.3) | `Message.senderAvatar` (`GET /media` 의 id). `attachments.read` 옆에서만 | — |
| `messages.reply` | 정의 (0.2.2) | `POST /send` 의 `replyTo`. `messages.send` 옆에서만 | — |
| `messages.edit` | 정의 (0.2.2) | `POST /edit` | `maxLength`, `maxAgeSeconds?` |
| `messages.delete` | 정의 (0.2.2) | `POST /delete` | `forEveryone` |
| `reactions.read` | 정의 (0.2.2) | `Message.reactions`, 이벤트 `reactions.updated` | — |
| `reactions.send` | 정의 (0.2.2) | `POST /react`. `reactions.read` 옆에서만 | `maxPerMessage?` |
| `read.mark` | 정의 (0.2.2) | `POST /read` | — |
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
  밝힙니다(`/health`, `/capabilities`, `/icon` 은 기능 제한 없음; 뒤의 둘은 베어러 인증 필요).
- 자기 라우트가 없는 기능은 올라타는 자리를 `x-in` 으로 밝힙니다(`messages.reply` 는
  `SendRequest.replyTo`, `reactions.read` 는 `Message.reactions`). 다른 기능 옆에서만 신고할 수
  있는 기능은 `x-requires` 로, 기능이 있어야 보낼 수 있는 이벤트는 `x-sse-events` 의
  `x-feature` 로 밝힙니다. serve-kit 은 이 표시를 읽어 시작할 때 신고를 검사합니다.
- 문서에 있는 라우트는 모든 어댑터가 라우팅합니다. 기능을 신고하지 않았으면 인증 뒤
  `501 NOT_SUPPORTED` 로 답합니다.
- 쓰기 본문은 JSON 이고 방은 `roomId`, 메시지는 `messageId` 로 가리킵니다. id 는 모두
  불투명한 문자열입니다.

## 스트림 이벤트

모든 스트림이 보내는 이벤트는 `ready`(한 번), `message`(새 메시지),
`cursor`(그 메시지들 **뒤에**, 방별 마지막 id), `ping`(조용할 때),
`error`(끝나기 전에 한 번)입니다. 그 밖의 이벤트는 `messages.stream` 의 `events` 에
나열한 것만 보냅니다(0.2.2).

| 이벤트 | 상태 | 페이로드 | 뜻 |
| --- | --- | --- | --- |
| `message.edited` | 정의 (0.2.2) | `{ok, message}` | 메시지가 바뀜(수정, 또는 반응 같은 다른 변화). 지금 모습 전체 |
| `message.deleted` | 정의 (0.2.2) | `{ok, roomId, messageIds}` | 방에서 사라진 메시지. 어느 방인지 아는 삭제만 보냄 |
| `reactions.updated` | 정의 (0.2.2) | `{ok, roomId, messageId, reactions}` | 그 메시지의 지금 반응. `reactions.read` 옆에서만 |
| `room.updated` | 예약 | `{ok, room}` — 제목·안 읽음 수·마지막 메시지 | 목록 실시간 갱신 |
| `typing` | 예약 | `{ok, roomId, senderId}` | 입력 중 표시 |

- 이어 읽기는 `message` 만 다시 보냅니다. 끊긴 동안의 수정·삭제·반응은 다시 오지 않으니,
  정확해야 하는 클라이언트는 `/messages` 를 다시 읽습니다.
- `message.deleted` 가 오지 않았다고 메시지가 남아 있다는 증거는 아닙니다.
- 클라이언트는 이 버전이 나열하지 않은 이벤트를 건너뜁니다. 새 이벤트의 이름은
  `<대상>.<과거분사>` 꼴로 짓습니다.

## 쓰기 본문 (0.2.2)

| 라우트 | 본문 | 답 |
| --- | --- | --- |
| `POST /send` | `{roomId, text, replyTo?}` | `{ok, message}` |
| `POST /edit` | `{roomId, messageId, text}` | `{ok, message}` — 지금 저장된 모습 |
| `POST /delete` | `{roomId, messageId}` | `{ok}` |
| `POST /react` | `{roomId, messageId, emojis}` — 이 계정의 반응을 **통째로** 이 목록으로, `[]` 는 없앰 | `{ok, reactions}` |
| `POST /read` | `{roomId, messageId}` — 그 메시지까지 읽음 | `{ok}` |

반응을 더하거나 빼는 대신 목록을 통째로 정하므로, 같은 요청을 두 번 보내도 결과가
같습니다. `Reaction` 은 `{emoji, count, mine}` 이고, 유니코드 이모지로 부를 수 있는 것만
싣습니다(메신저 고유의 커스텀·유료 반응은 빠질 수 있음). 읽음 처리는 메신저가 다른
참여자에게 알릴 수 있습니다.

## 첨부와 `/media`

`attachments.read` 를 신고한 어댑터의 메시지는 `attachments` 를 가집니다. 각 첨부의 모양은
`{id, kind, name?, mimeType?, size?, width?, height?, durationSeconds?}` 입니다.

- `kind`: `file`(받을 것), `image`, `video`, `audio`, `voice`, `sticker`, `animation`.
- 앨범처럼 메신저가 한 덩어리로 보여 주는 메시지들은 같은 `groupId` 를 가집니다(0.2.4). 한 사람이 연달아 보낸 것이라
  클라이언트는 그 사진들을 한 그리드로 그릴 수 있고, 답장·반응·수정·삭제는 여전히 메시지마다 합니다.
- `avatars.read` 를 함께 신고하면 메시지의 `senderAvatar` 도 같은 `/media` 의 id 입니다(0.2.3).
  보낸 사람이 사진을 바꾸면 id 도 바뀝니다. 없으면 클라이언트가 자기 자리표시를 그립니다.
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

`GET /icon` 은 제공자 SVG·PNG·WebP를 CSP·nosniff·private 캐시 헤더로 답하며, `provider.icon` 은 바이트가 바뀌면 바뀌는 버전이고 없으면 `404 NOT_FOUND` 입니다(0.2.5).

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
