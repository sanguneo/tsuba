# 내 메신저 어댑터 만들기

tsuba 에 없는 메신저(사내 메신저, 작은 커뮤니티 채팅, 직접 만든 알림 채널 등)도 어댑터를
하나 쓰면 saya 에 나란히 그려집니다. 이 문서는 그 어댑터를 처음부터 만들어 saya 에 붙이는
순서입니다. 따라 할 예제는 [`examples/memo`](../examples/memo) 에 있습니다. 계정도 토큰도
필요 없는 메모리 속 가짜 메신저라, 그대로 띄워서 saya 에서 보고 보낼 수 있습니다.

## 먼저 알아 둘 것

- **어댑터는 메신저 계정 하나를 쥔 로컬 프로세스입니다.** 그 메신저와는 어댑터만 이야기하고,
  saya 는 어댑터가 답하는 공통 계약 [`contract/openapi.json`](../contract/openapi.json) 만 압니다.
  saya 에는 메신저별 코드가 없습니다.
- **saya 는 선언한 것만 그립니다.** 어댑터가 `GET /capabilities` 로 "방 목록, 읽기, 보내기가
  된다"고 말하면 그것만 그립니다. 선언하지 않은 기능은 지원하지 않는 것으로 봅니다. 그래서 끝까지
  실제로 되는 것만 선언합니다.
- **공식 경로로만 만듭니다.** 메신저가 공개한 API, 공식 봇·앱 토큰, 그 메신저가 허락한 방식만
  씁니다. 로그인 우회, 프로토콜 재구현, 사용자 계정 자동화를 금지한 메신저에서 사용자 계정을 쓰는
  일은 이 저장소에 넣지 않습니다([`AGENTS.md`](../AGENTS.md) 「Deliberately absent」). 직접
  만들어 혼자 쓰는 어댑터라도 그 메신저 약관의 책임은 만든 사람에게 있습니다.
- **토큰은 비밀번호입니다.** 어댑터가 쥐는 메신저 토큰과 saya 가 어댑터에 보내는 토큰 모두 로그에
  찍지 않고 커밋하지 않습니다. 어댑터는 기본으로 `127.0.0.1` 에만 엽니다.

## 길은 두 가지입니다

| | tsuba 안에서 (추천) | 다른 언어로 |
|---|---|---|
| 언어 | TypeScript / Bun | 무엇이든 |
| 해 주는 것 | 인증, 기능 선언 검사, 라우팅, SSE 이어 읽기, 첨부 헤더, saya 등록 | 없음. 계약을 직접 답합니다 |
| 쓸 것 | `AdapterBackend` 메서드 몇 개 | 계약의 라우트 전부 |

특별한 이유가 없으면 tsuba 안에서 만드세요. 아래 1~6 단계가 그 길이고, 마지막 절이 다른 언어의
길입니다.

## 1. 예제를 복사합니다

```sh
git clone https://github.com/sanguneo/tsuba && cd tsuba
cp -r examples/memo adapters/<id>      # <id>: 소문자로 시작하는 a-z0-9- (예: groupware)
bun install
```

`adapters/<id>/package.json` 의 `name` 을 `@tsuba/<id>` 로 바꿉니다. `icon.svg` 는 64 KiB 이하의
SVG·PNG·WebP 로 바꿉니다. SVG 는 스크립트, 바깥 주소 참조, 애니메이션이 있으면 serve-kit 이
시작할 때 거절합니다.

## 2. 무엇이 되는지 선언합니다 (`src/capabilities.ts`)

```ts
export const CAPABILITIES: Capabilities = {
  provider: { id: "memo", name: "Memo" },        // id 는 saya 의 /adapters/<id>, name 은 화면에 쓰는 이름
  account: { kind: "user" },                      // user | bot | official — 이 어댑터가 누구로 행동하는지
  adapter: { name: "tsuba-memo", version: adapterPackage.version },
  features: {
    "rooms.list": {},
    "messages.read": { paging: "before-id", maxLimit: 100 },
    "messages.stream": { resume: "cursor" },
    "messages.send": { maxLength: 2000, receipt: "stored" },
  },
};
```

- 숫자는 **메신저가 실제로 지키는 한도**를 적고, 어디서 확인했는지 주석으로 남깁니다
  (문서, 또는 직접 보내 본 결과). 바라는 값을 적지 않습니다.
- `receipt` 는 보내기가 무엇을 확인했는지입니다. 메신저가 저장된 메시지를 돌려주면 `stored`,
  받았다고만 하면 `accepted` 입니다. 확인하지 못한 것을 `stored` 라고 하지 않습니다.
- 기능 이름과 매개변수의 전체 목록은 [`docs/contract.md`](contract.md) 「기능 대장」과
  `packages/serve-kit/src/capabilities.ts` 에 있습니다.

## 3. 기능마다 메서드를 씁니다 (`src/backend.ts`)

선언한 기능과 구현한 메서드는 정확히 짝이 맞아야 합니다. 하나라도 어긋나면 serve-kit 이
**시작할 때** 오류를 내고 서버가 뜨지 않습니다.

| 기능 | 메서드 | 지킬 것 |
|---|---|---|
| `rooms.list` | `listRooms()` | 방마다 `id`·`title`·`kind`(direct/group/channel)·`unread`. 어댑터가 일부만 돌려주면 `complete: false` |
| `messages.read` | `readMessages({ roomId, limit, before })` | `before` 가 없으면 최신 `limit` 개, 있으면 그 id 바로 앞의 `limit` 개. **오래된 것부터** 담고, 더 이전이 있으면 `hasEarlier: true` |
| `messages.stream` | `subscribe(listener)` | 새 메시지마다 `listener({ event: "message", message })`. 돌려주는 함수는 구독을 끊습니다 |
| `messages.stream` 의 `resume: "cursor"` | `messagesAfter(roomId, afterId)` | 끊겼다 다시 붙은 클라이언트가 놓친 메시지. `resume: "cursor"` 를 선언할 때만 씁니다 |
| `messages.send` | `send(roomId, text, options)` | 메신저가 돌려준 메시지를 그대로 돌려줍니다 |
| `messages.reply` | (`send` 의 `options.replyTo`) | `messages.send` 옆에만 선언합니다 |
| `messages.edit` · `messages.delete` | `edit` · `deleteMessage` | |
| `reactions.send` | `react(roomId, messageId, emojis)` | 이 계정의 반응을 정확히 `emojis` 로 맞춥니다 |
| `read.mark` | `markRead(roomId, messageId)` | |
| `attachments.read` | `media(id, signal)` | 바이트와 형식만 넘깁니다. 응답 헤더는 serve-kit 이 정합니다 |
| `attachments.send` | `upload(roomId, file, options)` | |

메시지의 `id`·`roomId` 는 **문자열**입니다. 메신저가 숫자 id 를 쓰더라도 문자열로 바꿉니다
(2^53 을 넘는 id 는 숫자로 다루면 조용히 틀립니다). `sentAt` 은 ISO 8601 시각입니다.

**오류는 `AdapterError(code, message)` 로 던집니다.** 메시지는 화면에 나갈 수 있으니 토큰이나
대화 내용을 넣지 않습니다.

| 메신저가 한 말 | 코드 |
|---|---|
| 그런 방·메시지 없음 | `NOT_FOUND` |
| 권한 없음, 이 방에선 못 함 | `FORBIDDEN` |
| 토큰 만료, 다시 로그인 필요 | `REAUTH_REQUIRED` |
| 너무 자주 보냄 | `RATE_LIMITED` |
| 요청이 잘못됨 (너무 긴 글 등) | `INVALID_REQUEST` |
| 무슨 일인지 모름 (시간 초과, 연결 끊김) | 그냥 던집니다. serve-kit 이 `INTERNAL` 로 답합니다 |

`INTERNAL` 만 "결과를 모른다"는 뜻입니다. saya 는 `INTERNAL` 로 끝난 보내기를 자동으로 다시
보내지 않고, 나머지 코드는 "아무것도 바뀌지 않았다"로 읽습니다. 그래서 메신저가 분명히 거절한
경우는 반드시 알맞은 코드로 바꿔 던집니다.

**방마다 할 수 있는 게 다르면** `Room.features` 로 좁힙니다. 예를 들어 읽기만 되는 공지 채널은
`features: { "messages.send": false }` 입니다. 그러면 saya 는 그 방에 입력창을 그리지 않습니다.
선언에 없는 기능을 방에서 더할 수는 없습니다.

## 4. 띄우는 코드를 씁니다 (`src/cli.ts`)

예제의 `cli.ts` 를 그대로 쓰고 환경 변수 이름만 바꿉니다. 관례는 아래와 같습니다.

| 변수 | 뜻 |
|---|---|
| `TSUBA_<ID>_HTTP_TOKEN` | saya 가 이 어댑터에 보낼 토큰(16자 이상). 없으면 `TSUBA_TOKEN` |
| `TSUBA_<ID>_PORT` | 포트. 다른 어댑터와 겹치지 않게(텔레그램 8790, 디스코드 8792, 슬랙 8793, discord-user 8794) |
| 메신저 토큰 | `TSUBA_<ID>_...` 로 이름을 정하고 `.env.example` 에 빈 값으로 한 줄 적습니다 |

`.env` 는 저장소 루트에서 Bun 이 읽고, git 에는 올라가지 않습니다.

## 5. 확인합니다

```sh
bun test adapters/<id>                       # 예제의 declaration.test.ts 를 따라 쓴 테스트
bunx tsc --noEmit -p adapters/<id>
bun run lint
bun adapters/<id>/src/cli.ts                 # tsuba-<id> listening on 127.0.0.1:<포트>
curl -s -H "Authorization: Bearer $TSUBA_TOKEN" http://127.0.0.1:<포트>/capabilities
```

테스트에는 **실제 대화나 계정 정보를 넣지 않습니다.** 가짜 메신저를 쓴다면 401·429·503·이상한
응답처럼 진짜 메신저가 실패하는 방식으로도 실패할 수 있게 만듭니다. 그래야 오류 경로를 실제로
시험할 수 있습니다.

## 6. saya 에 붙입니다

saya 쪽에는 아무것도 적지 않습니다. 어댑터가 saya 에 스스로 등록합니다. `.env` 에 두 줄만 더합니다.

```sh
SAYA_REGISTER_URL=http://127.0.0.1:8798        # saya 가 다른 기계면 https://<saya 기계>.<tailnet>.ts.net:8798
SAYA_REGISTER_TOKEN=<saya 의 SAYA_REGISTER_TOKEN>
# SAYA_ADVERTISE_URL=https://<이 기계>.<tailnet>.ts.net:<포트>   # saya 와 다른 기계일 때만
```

어댑터를 다시 띄우면 saya 의 목록과 **설정 > 연결**에 새 메신저가 나타납니다. 멈추면 목록에서
빠집니다(정상 종료는 바로, 아니면 90초 뒤). 주소는 loopback 이나 tailnet 이어야 saya 가
받아들입니다. 등록 규칙은 saya [`docs/register.md`](https://github.com/sanguneo/saya/blob/main/docs/register.md)
에 있습니다.

saya 가 연결 화면에서 **버전 다름**이라고 하면, 어댑터가 답하는 계약 버전과 saya 가 아는 계약
버전이 맞지 않는 것입니다. tsuba 와 saya 를 둘 다 최신으로 맞추세요.

### 단일 실행 파일에 넣기 (선택)

`tsuba <adapter> serve` 한 바이너리로 돌리려면 `bin/tsuba.ts` 의 `ADAPTERS` 에 한 줄을 더하고,
`package.json` 의 `typecheck` 에 `tsc --noEmit -p adapters/<id>` 를 더합니다.
`tests/single-binary.test.ts` 의 usage 문자열도 같이 바뀝니다.

### tsuba 에 보내기 (선택)

다른 사람도 쓸 만한 메신저라면 PR 을 보내 주세요. 어댑터마다 `docs/<id>.md` 에 무엇을 실제
계정으로 확인했는지, 한도를 어디서 확인했는지 적습니다(기존 `docs/telegram.md`, `docs/slack.md`
처럼). 공통 계약에 없는 것이 꼭 필요하면 계약을 고치지 말고 `x-<id>.` 확장 이름을 쓰거나
이슈로 먼저 이야기합니다([`docs/contract.md`](contract.md) 「확장 이름공간」, 「계약에 무엇을
더하는 순서」).

## 다른 언어로 만들기

serve-kit 을 쓰지 않아도 됩니다. HTTP 서버가 [`contract/openapi.json`](../contract/openapi.json) 에
답하고 saya 에 등록하면 saya 는 똑같이 그립니다.

- **꼭 있어야 하는 것**: `GET /health`(인증 없음), `GET /capabilities`, 그리고 선언한 기능의
  라우트(`x-feature` 가 라우트마다 어느 기능에 딸렸는지 적어 둡니다). `GET /icon` 은 선택입니다.
- **인증**: 모든 라우트(`/health` 제외)는 `Authorization: Bearer <토큰>` 을 상수 시간으로 비교하고,
  틀리면 `401 UNAUTHORIZED`.
- **응답은 모두 봉투**입니다. 성공은 `{"ok": true, ...}`, 실패는
  `{"ok": false, "error": {"code", "message"}}` 이고 코드마다 HTTP 상태가 정해져 있습니다.
- **스트림**은 `GET /stream` 의 Server-Sent Events 입니다. 이벤트 이름, 커서 형식(`since=<방>:<id>`
  반복), 핑 간격은 계약의 `/stream` 설명을 따릅니다.
- **첨부 응답**에는 `Content-Security-Policy: default-src 'none'; sandbox` 와
  `X-Content-Type-Options: nosniff` 를 붙입니다(saya 프록시도 붙이지만 어댑터가 먼저 지킵니다).
- **등록**: 시작할 때 `POST <SAYA_REGISTER_URL>/register` 에
  `{"kind": "adapter", "id", "url", "token"}`, 그 뒤 답으로 받은 `interval` 마다 다시 보내고,
  끝날 때 `DELETE /register`. 자세한 것은 saya `docs/register.md`.

계약대로 답하는지는 serve-kit 으로 만든 예제와 같은 요청을 보내 비교해 보면 가장 빨리 알 수
있습니다(`examples/memo` 를 띄우고 같은 `curl` 을 두 서버에 보내 봅니다).

## 자주 막히는 곳

| 증상 | 이유 |
|---|---|
| 시작하자마자 `X must be declared iff Y is implemented` | 선언과 메서드가 짝이 안 맞습니다(3절 표) |
| `Cursor resume must be declared iff messagesAfter is implemented` | `resume: "cursor"` 와 `messagesAfter` 는 함께 있거나 함께 없어야 합니다 |
| `messages.reply is declared only beside messages.send` | 어떤 기능은 다른 기능 옆에만 선언할 수 있습니다 |
| `A room cannot add the undeclared feature ...` | `Room.features` 는 좁히기만 합니다 |
| saya 목록에 안 보임 | `SAYA_REGISTER_*` 가 비었거나, 등록 토큰이 다르거나, 주소가 loopback·tailnet 밖입니다. 어댑터 로그에 등록 실패가 토큰 없이 한 줄 남습니다 |
| saya 연결 화면에 "버전 다름" | 계약 버전이 caret 범위 밖입니다(6절) |
