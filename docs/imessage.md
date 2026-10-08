# iMessage 어댑터

macOS 의 Messages.app 을 서드파티 CLI [`imsg`](https://github.com/openclaw/imsg) 로 감싼
어댑터입니다. **이 Mac 의 Messages 계정 그 자체**로 동작하고(`account.kind: "user"`),
iMessage 에는 SDK 도 네트워크 API 도 없어서 `imsg` 가 유일한 접근 경로입니다.
`serve` 는 시작할 때 `adapters/imessage/icon.svg` 를 한 번 읽어 `/icon` 으로 답하고
`provider.icon` 에 바이트 버전을 알립니다(0.2.5).

계약의 방 목록, 메시지 읽기(이전 id 페이징), 실시간 수신(커서 스트림), 텍스트 전송을
구현했습니다. 합성 데이터와 로컬 HTTP 로 검증하며, 실제 계정에서의 검증은 운영자가
별도로 합니다.

## 기반: imsg

- `imsg` 0.13.4 (Homebrew `steipete/tap/imsg`, 이 Mac 에서는 `/opt/homebrew/bin/imsg`,
  MIT). 어댑터는 이 경로를 기본으로 부르고, 다르면 `TSUBA_IMESSAGE_BIN` 으로 바꿉니다
  (Intel Mac 의 Homebrew 는 `/usr/local/bin`).
- `imsg chats --json` 과 `imsg history --json` 은 **JSON 배열이 아니라 한 줄에 하나씩**
  냅니다(NDJSON). 어댑터는 줄 단위로 읽습니다.
- `imsg watch --json` 도 한 줄에 하나씩 흘려보내고, 사람이 읽는 출력은 **stderr** 로
  보냅니다. `--since-rowid <n>` 은 그 행번호 **뒤**부터 시작하고(배타적), 주지 않으면 그
  순간의 최신 행부터 시작합니다. 어댑터는 이것으로 스트림을 만들고, 워처가 죽으면 마지막
  행 뒤부터 다시 붙입니다. `watch` 는 SIP 를 끄지 않아도 되는 basic-tier 명령입니다.
- `imsg send --json` 은 `{"status":"sent"}` 만 답하고 전송된 메시지의 id 는 주지 않습니다.
  그래서 어댑터가 전송 뒤 그 방의 최근 행을 되읽어 답을 채우고, `messages.send.receipt`
  는 `stored` 입니다. `imsg` 자신이 AppleScript 전송을 `chat.db` 의 발신 행과 대조해
  확인한 뒤에야 exit 0 을 냅니다.

## Full Disk Access 가 필요합니다 (가장 흔한 실패)

`imsg` 는 `~/Library/Messages/chat.db` 를 직접 읽습니다. macOS 는 그 경로를 Full Disk
Access 를 받은 프로세스에게만 열어 줍니다. **권한은 어댑터를 실행하는 프로세스에 주는
것이지 셸에 주는 것이 아닙니다.** 터미널에서 띄우면 그 터미널 앱에, launchd 로 띄우면
그 job 이 실행하는 실행 파일에, 편집기·Node·게이트웨이를 거치면 그 부모 프로세스에
권한을 줘야 합니다.

- **시스템 설정 → 개인정보 보호 및 보안 → 전체 디스크 접근 권한** 에서 부여합니다.
- 권한을 바꾼 뒤에는 프로세스를 완전히 종료했다 다시 띄웁니다. macOS 는 실행 시점에만
  권한을 다시 읽습니다.
- Homebrew·터미널·macOS 업데이트 뒤에는 항목이 낡습니다. 껐다 켜세요.

**권한이 없을 때의 모습** — 이게 헷갈리는 지점입니다.

- `imsg` 는 exit 1 과 함께 `authorization denied (code: 23)` 를 냅니다(때로는
  `unable to open database file (code: 14)` 와 "Cannot access Messages database" 안내).
- 어댑터는 이를 `503 REAUTH_REQUIRED` 로 답합니다. 세션이 아니라 **어댑터가 도는 곳에서
  사람이 접근 권한을 되돌려 줘야 하는** 상태이고, 아무것도 바뀌지 않았기 때문입니다.
- **`/health` 는 그래도 `{"ok":true}` 로 답하고 `/rooms` 만 실패합니다.** `/health` 는
  인증 없이 프로세스가 살아 있는지만 말하고 계정을 읽지 않기 때문입니다. 그래서
  `/health` 가 초록이라고 iMessage 가 붙어 있다는 뜻이 아닙니다.

`imsg send` 는 AppleScript 로 Messages.app 을 몰기 때문에 **자동화(Automation)** 권한도
따로 필요합니다. 없으면 `not authorized to send Apple events` 이고, 어댑터는 같은
`503 REAUTH_REQUIRED` 로 답합니다.

## 실행과 비밀

```sh
bun adapters/imessage/src/cli.ts check     # 방 개수만 출력
TSUBA_TOKEN=... bun adapters/imessage/src/cli.ts serve
```

- **자격 증명이 없습니다.** 이 Mac 의 Messages 계정을 그대로 쓰므로 API 키도 세션
  파일도 없습니다. `.env.example` 에 이 어댑터 항목이 선택적인 두 줄뿐인 이유입니다.
- HTTP 토큰은 `TSUBA_IMESSAGE_HTTP_TOKEN`, 없으면 `TSUBA_TOKEN`(16자 이상)입니다.
  기본 바인딩은 `127.0.0.1` 입니다(serve-kit). 포트와 주소는 `TSUBA_IMESSAGE_PORT`
  (기본 8795), `TSUBA_HOST` 로 지정합니다.
- `TSUBA_IMESSAGE_BIN` 은 `imsg` 실행 파일의 경로입니다(기본
  `/opt/homebrew/bin/imsg`).
- `check` 는 방 개수만 출력합니다. 제목·핸들·본문은 찍지 않습니다(실제 계정).

## 구현된 기능 신고

| 기능 | 값 | 구현 |
| --- | --- | --- |
| `rooms.list` | `{}` | `imsg chats --limit 251 --json`. 최신 활동 순으로 정렬. 250개까지 답하고 251번째 행으로 초과 여부를 확인 |
| `messages.read` | `paging: before-id`, `maxLimit: 100` | `imsg history --chat-id <rowid> --limit n --json`. 오래된 순서로 반환. 어댑터의 읽기 상한은 100개 |
| `messages.stream` | `resume: cursor` | `imsg watch --json`. 새 메시지마다 `message` 이벤트. 이어 읽기는 `since=<roomId>:<messageId>` 로 그 행 뒤를 채움. `message` 는 모든 스트림이 보내는 기본 이벤트라 `events` 를 비워 둠 |
| `messages.send` | `maxLength: 20000`, `receipt: stored` | `imsg send --chat-id <rowid> --text <본문> --json`. `sent` 를 확인한 뒤 저장된 행을 되읽어 답함 |

수정, 삭제, 반응, 읽음 처리, 첨부, 아바타, 파일 보내기는 신고하지 않습니다.
쓰기는 serve-kit 의 줄 하나를 함께 쓰며, 한 번에 하나씩 실행 중 요청을 포함해 최대 4개만
받아들이고 5번째는 즉시 429 입니다.

## 실시간 수신 (스트림)

`imsg watch` 는 **이 Mac 의 `chat.db` 를 지켜보며** Messages 가 새로 쓰는 행을 그대로
흘려보냅니다. 계정에 도착한 것을 네트워크에서 받아오는 것이 아니라 **이 Mac 의 Messages
가 받은 것**을 로컬 데이터베이스에서 읽습니다.

- 새 메시지마다 `message` 이벤트를 보냅니다. 수정·삭제·반응은 `imsg` 가 안정적으로
  알려주지 않아 신고하지 않습니다(`--reactions` 를 쓰지 않습니다).
- **이어 읽기**: 클라이언트가 `since=<roomId>:<messageId>` 로 마지막 커서를 되돌려 주면,
  어댑터는 그 id **뒤**의 행을 `imsg history` 로 채워 보낸 뒤 실시간으로 넘어갑니다.
  `imsg history` 에는 id 로 앞으로 페이징하는 옵션이 없어, 최신 행부터 `--end` 로 뒤로
  걸어가며 커서보다 새것을 모읍니다. 커서로 쓸 수 없는 id 는 지금부터 시작하지 않고
  거절합니다.
- **워처가 죽으면** 스트림을 끝내지 않고 마지막으로 넘긴 행 뒤(`--since-rowid`)부터 다시
  붙입니다(1초에서 30초까지 지수 백오프). `imsg` 가 없거나 권한이 없어 스폰이 실패해도 같은
  방식으로 다시 시도합니다.
- 읽을 수 없는 줄(깨진 JSON 등)은 **버립니다.** 스트림에는 그것을 알릴 오류 채널이 없고,
  한 줄 때문에 실시간 수신을 끊는 편이 더 나쁘기 때문입니다.
- 스트림은 serve-kit 이 어댑터마다 8개까지 받습니다. 넘으면 `503 BUSY` 입니다.

## 이전 메시지 페이징

`imsg history` 는 id 로 페이지를 주지 않습니다. 최신부터 `--limit` 개를 주고,
`--end <ISO8601>` 로 그 시각까지를 줍니다. 그래서 `before=<messageId>` 는 이렇게 답합니다.

- 요청한 개수보다 **하나 더** 읽고, 그 하나로 더 오래된 것이 있는지 판단해
  `hasEarlier` 를 채웁니다.
- `before` 가 있으면 최신 행부터 `--end` 로 뒤로 걸어가며 그 id 보다 오래된 행을
  모으고, 모자라면 계속 걸어갑니다. 클라이언트가 이어서 페이지를 넘기는 보통의 경우
  한 번 더 읽는 정도입니다.
- `--end` 는 관측상 경계 시각의 행을 포함하므로 같은 행이 다시 옵니다. id 로 중복을
  제거합니다.

## 오류 대응

| imsg | 계약 |
| --- | --- |
| `authorization denied (code: 23)`, `unable to open database file`, "Cannot access Messages database" | `503 REAUTH_REQUIRED` — 어댑터가 도는 곳에서 Full Disk Access 를 |
| `not authorized to send Apple events` | `503 REAUTH_REQUIRED` — 어댑터가 도는 곳에서 Automation 권한을 |
| `Invalid chat target: Unknown chat id <n>` | `404 NOT_FOUND` |
| `may_have_completed`, `still_in_flight` | `500 INTERNAL` — 결과를 모름. 자동 재시도하지 않음 |
| 그 외 오류 | `500 INTERNAL`, 계정 정보가 없는 일반 메시지 |
| 선언하지 않은 기능의 경로 | 인증 후 `501 NOT_SUPPORTED` |

`imsg` 는 거절을 대개 **stdout** 에 문장으로 쓰고 exit 1 을 냅니다(위의 SQLite 계열은
stderr). 어댑터는 두 스트림을 함께 보고 위 표대로 옮깁니다.

## 한계

- **없는 방은 404 가 아닙니다.** `imsg history --chat-id <없는 id>` 는 오류 없이 빈
  결과를 냅니다. 방이 없어서인지 메시지가 없어서인지 어댑터가 구분할 수 없어 빈
  페이지로 답합니다. 반대로 `imsg send` 는 없는 방을 `Unknown chat id` 로 거절하므로
  404 가 됩니다. 행 번호가 아닌 id 는 `imsg` 를 부르기 전에 404 입니다.
- **전송 답의 id 는 되읽어 채웁니다.** `imsg send --json` 이 id 를 주지 않아 어댑터가
  그 방의 최근 10개에서 보낸 행을 찾습니다. 찾지 못하면 전송은 확인됐지만 답을 만들 수
  없어 `500 INTERNAL` 입니다.
- **첨부가 있는 메시지도 `kind: "text"` 로 옵니다.** 본문이 빈 문자열일 수 있습니다.
  스트림(`imsg watch`)도 같은 매퍼를 쓰므로 마찬가지입니다.
- `messages.send.maxLength` 는 Apple 이 문서로 정한 값이 아닙니다. 20,000 코드 포인트를
  보수적 상한으로 신고하며, 출처와 근거는 `src/capabilities.ts` 주석에 있습니다.
- **`imsg` 의 나머지 명령을 쓰지 않습니다.** `react`·`read`·`typing`·`send-rich` 는 SIP 를
  끄거나 Messages.app 에 코드를 주입해야 해서, 이 어댑터가 넘지 않는 선입니다.

## 하지 않는 것

로그인 자동화, 공식 API 를 벗어난 프로토콜 조작, SIP 를 끄거나 Messages.app 에 코드를
주입하는 접근, 대량 발송.
