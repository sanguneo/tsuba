# Telegram 어댑터 계획

첫 어댑터입니다. **사용자 본인 계정의 클라이언트**이고, 봇이 아닙니다
(`account.kind: "user"`). 아직 코드는 없습니다. 이 문서의 "확인 필요" 표시는 구현
전에 실제로 재거나 문서에서 확인해야 하는 값입니다.

## 기반: mtcute

[`@mtcute/bun`](https://github.com/mtcute/mtcute/tree/master/packages/bun) (MIT,
0.32.3, 2026-09-25)을 씁니다. 근거는 [`references.md`](references.md) 에 있습니다.
요약하면 공식 Bun 패키지가 있고(`bun:sqlite`), 끊긴 업데이트를
`getDifference`/`getChannelDifference` 로 메우며(`updates.catchUp: true`),
전화번호·코드·2FA·QR 로그인을 지원합니다. GramJS 는 보관됐고, tdl 은 Bun 안정성을
보장하지 않습니다.

**첫 작업은 스파이크입니다.** Bun 1.4.2 / Windows 에서 로그인 → 대화 목록 → 업데이트
수신이 실제로 되는지 확인하고, 안 되면 이 선택을 다시 합니다.

## 실행과 비밀

```sh
bun adapters/telegram/src/cli.ts login     # 사람이 터미널에서 직접: 전화번호, 코드, 2FA
bun adapters/telegram/src/cli.ts serve --port 8790
```

- `api_id`/`api_hash` 는 사용자가 my.telegram.org 에서 직접 발급해
  `TSUBA_TELEGRAM_API_ID`/`TSUBA_TELEGRAM_API_HASH` 로 줍니다. 저장소에 넣지 않습니다.
- 세션은 `sessions/telegram.sqlite` 이고 `.gitignore` 에 들어 있습니다. **이 파일은
  계정 전체에 접근할 수 있으므로** 토큰보다 더 강한 비밀번호로 다룹니다.
- 로그인은 사람이 하는 것입니다. 코드를 자동으로 받아 넣는 로그인 자동화는 만들지
  않습니다.
- HTTP 토큰은 `TSUBA_TOKEN`(16자 이상), 기본 바인딩은 `127.0.0.1` 입니다(serve-kit).

## 기능 신고 초안

| 기능 | 값 | 근거 / 확인 필요 |
| --- | --- | --- |
| `rooms.list` | `{}` | 대화 목록 |
| `messages.read` | `paging: before-id`, `maxLimit: 100` | `messages.getHistory` 의 `offset_id`. 한 번에 100개 상한은 **확인 필요** |
| `messages.stream` | `resume: cursor` | 아래 "이어 읽기" |
| `messages.send` | `maxLength: 4096`, `receipt: stored` | 전송 결과로 저장된 메시지 id 가 옴. 4096 이 UTF-16 단위인지 코드 포인트인지 **확인 필요** — 계약은 코드 포인트로 적었으므로 다르면 계약을 고칩니다 |
| `messages.reply` | `{}` | |
| `messages.edit` | `maxAgeSeconds` 생략? | 사용자 메시지의 편집 시간 제한 **확인 필요** |
| `messages.delete` | `forEveryone: true` | 개인 대화는 양쪽 삭제 가능. 그룹은 권한에 따라 다름 → 방별 기능 필요 |
| `reactions.read` / `reactions.send` | `maxPerMessage` | 프리미엄 여부로 달라짐 → 시작할 때 계정 상태로 계산. 수치 **확인 필요** |
| `read.mark` | `{}` | `readHistory` |
| `typing.send` | `{}` | `setTyping` |
| `threads.read` | `{}` | 포럼 토픽과 채널 댓글. 방과 스레드를 섞지 않음 |
| `attachments.read` / `attachments.send` | `maxBytes`, `caption: true` | 프리미엄 여부로 상한이 다름. 수치 **확인 필요** |

신고 값은 시작할 때 한 번 계산하고, 계정 상태(프리미엄 등)가 바뀌면 다시 계산합니다.
그러면 `revision` 이 바뀝니다.

## 방마다 다른 기능

Telegram 은 방마다 할 수 있는 일이 다릅니다. 관리자가 아닌 채널은 읽기 전용이고,
슬로우 모드가 있으며, 그룹마다 권한도 다릅니다. 그래서 계약 0.2.0 에서 `Room` 을
들일 때, 방이 전체 기능과 다를 때만 자기 실효 기능(`features`)을 함께 싣게 합니다
(mautrix 의 네트워크 기본값 + 방별 `RoomFeatures` 구조).

## 이어 읽기 (SSE 커서)

Telegram 은 서버에 대화 기록이 있으므로, 카카오 코어처럼 로컬 DB 를 읽을 필요가
없습니다.

- 커서는 방별 마지막 메시지 id 입니다(`{roomId: messageId}`). 메시지들 **뒤에**
  `cursor` 이벤트로 보냅니다(kanao 와 같은 규칙).
- 재접속하면 커서에 이름이 있는 방마다 그 id 이후를 서버에서 페이지 단위로 읽어 보낸
  뒤 실시간으로 넘어갑니다.
- 실행 중 생긴 공백은 mtcute 의 catch-up 이 메웁니다. 너무 긴 공백
  (`differenceTooLong`)은 그 방을 다시 동기화하라는 이벤트로 알립니다. 조용히 건너뛰지
  않습니다.
- 이어 읽을 수 없는 커서는 거절합니다. 지금부터 시작하는 것으로 바꿔치지 않습니다.

## 오류 대응

| Telegram | 계약 |
| --- | --- |
| `FLOOD_WAIT_X` | `429 RATE_LIMITED`. 자동 재시도는 읽기만 하고, 전송은 하지 않음 |
| 세션 만료·해지 (`AUTH_KEY_UNREGISTERED` 등) | `503`, 다시 `login` 하라는 코드(계약에 추가) |
| 없는 방·메시지 | `404` |
| 같은 이름의 방 여러 개 | `409`, 후보 목록을 붙여서 거절 |

## 만드는 순서

saya 와 같은 이유로 이 순서입니다. 앞 단계 없이는 뒤 단계를 확인할 수 없고, 전송이
마지막인 이유는 틀리면 남의 대화방에 글이 나가기 때문입니다.

1. **스파이크** — Bun + mtcute 로그인, 대화 목록, 업데이트 수신.
2. **계약 0.2.0** — `Room`, `GET /rooms`, 방별 기능. 가짜 Telegram 포트(401·429·503·깨진
   응답을 낼 수 있는 것)로 테스트.
3. **메시지 읽기** — `before-id` 페이징.
4. **스트림** — SSE, 방별 커서, 재동기화 이벤트.
5. **전송** — 답장 포함, `receipt: stored`.

## 하지 않는 것

로그인 자동화, 공식 API 를 벗어난 프로토콜 조작, 사용자가 자기 클라이언트로 볼 수
없는 기록의 수집, 대량 발송.
