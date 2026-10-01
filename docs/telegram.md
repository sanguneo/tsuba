# Telegram 어댑터

첫 어댑터입니다. **사용자 본인 계정의 클라이언트**이고, 봇이 아닙니다
(`account.kind: "user"`). 계약 0.2.0의 방 목록, 메시지 읽기, SSE 이어 읽기,
텍스트 전송을 구현했습니다. 합성 데이터와 로컬 HTTP로 검증하며, 실제 계정에서의
새 구현 검증은 운영자가 별도로 합니다.

## 기반: mtcute

[`@mtcute/bun`](https://github.com/mtcute/mtcute/tree/master/packages/bun) (MIT,
0.32.3, 2026-09-25)을 씁니다. 근거는 [`references.md`](references.md) 에 있습니다.
요약하면 공식 Bun 패키지가 있고(`bun:sqlite`), 끊긴 업데이트를
`getDifference`/`getChannelDifference` 로 메우며(`updates.catchUp: true`),
전화번호·코드·2FA·QR 로그인을 지원합니다. GramJS 는 보관됐고, tdl 은 Bun 안정성을
보장하지 않습니다.

**스파이크 결과 (2026-10-01, Bun 1.4.2 / Windows 11, `@mtcute/bun` 0.32.3, SOCKS5 경유).**
`adapters/telegram/src/cli.ts` 로 실제 계정에서 확인했습니다. 출력은 개수와 종류뿐입니다.

- 로그인(전화번호·코드, 사람이 터미널에서 입력) 성공, 세션은 `sessions/telegram.session`.
- `iterDialogs` 로 대화 22개를 읽음: user 12, group 5, supergroup 1, channel 4. mtcute 의
  `chatType` 에는 `gigagroup`·`monoforum`·`community` 도 있으므로 방 종류는 열린 집합으로 다룹니다.
- `onNewMessage` 로 들어오는 메시지 하나를 받음.
- 길이 한계(저장한 메시지, 보낸 것은 즉시 삭제): `a`×4096 수락, ×4097 `MESSAGE_TOO_LONG`;
  이모지(U+1F600)×4096 — UTF-16 으로 8192 단위 — 수락되고 4096 코드 포인트 그대로 저장,
  ×4097 `MESSAGE_TOO_LONG`. **한계는 코드 포인트입니다.** Bot API 에서의 같은 결론
  ([측정 글](https://charliemorrison.dev/blog/telegram-4096-character-limit/))이 사용자 경로에서도 성립합니다.
  서식(entity)의 offset/length 는 별개로 UTF-16 단위입니다
  ([문서](https://core.telegram.org/api/entities)).
- 이 PC 의 직접 연결로는 Telegram 이 막혀 있어 프록시가 필요했습니다(아래 "실행과 비밀").

## 실행과 비밀

```sh
bun adapters/telegram/src/cli.ts login     # 사람이 터미널에서 직접: 전화번호, 코드, 2FA
TSUBA_PORT=8790 bun adapters/telegram/src/cli.ts serve
```

- `api_id`/`api_hash` 는 사용자가 my.telegram.org 에서 직접 발급해
  `TSUBA_TELEGRAM_API_ID`/`TSUBA_TELEGRAM_API_HASH` 로 줍니다. 저장소에 넣지 않습니다.
- 세션은 `sessions/telegram.session` 이고 `.gitignore` 에 들어 있습니다. **이 파일은
  계정 전체에 접근할 수 있으므로** 토큰보다 더 강한 비밀번호로 다룹니다.
- 로그인은 사람이 하는 것입니다. 코드를 자동으로 받아 넣는 로그인 자동화는 만들지
  않습니다.
- HTTP 토큰은 `TSUBA_TOKEN`(16자 이상), 기본 바인딩은 `127.0.0.1` 입니다(serve-kit).
  포트와 주소는 `TSUBA_PORT`(기본 8790), `TSUBA_HOST`로 지정합니다.
- Telegram 이 막힌 네트워크에서는 `TSUBA_TELEGRAM_PROXY` 로 프록시를 지정합니다
  (`socks5://`, `http://`, `tg://proxy` MTProxy 링크; mtcute `proxyTransportFromUrl`).
  2026-10-01 개발 PC 에서 확인: 직접 연결로는 Telegram DC 와 `*.telegram.org` 가 모두
  시간 초과였고(일반 TCP·난독화 TCP·WebSocket 모두), `ssh -D` SOCKS5 를 거치면 인증 키
  교환과 `help.getNearestDc` 가 성공했습니다. 템플릿은 `.env.example` 입니다.

## 구현된 기능 신고

| 기능 | 값 | 구현 |
| --- | --- | --- |
| `rooms.list` | `{}` | `iterDialogs`, 보관함 포함. 501번째 대화로 초과 여부를 확인하고 최대 500개 반환 |
| `messages.read` | `paging: before-id`, `maxLimit: 100` | `getHistory`의 offset으로 이전 페이지, 오래된 순서로 반환. 어댑터의 읽기 상한은 100개 |
| `messages.stream` | `resume: cursor` | 아래 "이어 읽기" |
| `messages.send` | `maxLength: 4096`, `receipt: stored` | `sendText`가 반환한 저장 메시지. 사용자 경로에서 측정한 4096 코드 포인트 |

나머지 기능은 신고하지 않습니다. 방별 권한 차이는 Telegram의 오류로 답하며,
계약 0.2.0에는 방별 기능 필드가 없습니다. 텍스트 전송은 한 번에 하나씩,
실행 중 요청을 포함해 최대 4개만 받아들이며 5번째는 즉시 429입니다.
불확실한 전송을 자동 재시도하지 않도록 mtcute의 RPC 재시도 미들웨어도 끕니다.

## 이어 읽기 (SSE 커서)

Telegram 은 서버에 대화 기록이 있으므로, 카카오 코어처럼 로컬 DB 를 읽을 필요가
없습니다.

- 커서는 방별 마지막 메시지 id 입니다(`{roomId: messageId}`). 메시지들 **뒤에**
  `cursor` 이벤트로 보냅니다(kanao 와 같은 규칙).
- 재접속하면 커서에 이름이 있는 방마다 그 id 이후를 서버에서 페이지 단위로 읽어 보낸
  뒤 실시간으로 넘어갑니다.
- 이력 조회 전에 업데이트를 구독해 조회 중 들어온 메시지를 버퍼링하고, 이력과
  겹치는 메시지를 제거한 뒤 실시간으로 넘어갑니다. 실행 중 catch-up은 mtcute가 처리합니다.
- 이어 읽을 수 없는 커서(삭제되었거나 접근할 수 없는 기준 메시지 포함)는 `error`로
  거절하고 스트림을 닫습니다. 지금부터 시작하는 것으로 바꿔치지 않습니다.
- 최대 8개 연결, 조용할 때 25초마다 `ping`. 연결 종료나 서버 종료 시 구독을 해제합니다.

## 오류 대응

| Telegram | 계약 |
| --- | --- |
| `FLOOD_WAIT_X` / 슬로우 모드 | `429 RATE_LIMITED`, 자동 재시도 없음 |
| 없는 peer / 잘못된 peer·channel id / 접근 불가 채널 | `404 NOT_FOUND` |
| 그 외 오류 (세션 오류 포함) | `500 INTERNAL`, 계정 정보가 없는 일반 메시지 |
| 선언하지 않은 기능의 경로 | 인증 후 `501 NOT_SUPPORTED` |

방과 메시지는 이름이 아닌 문자열 id로 지정합니다. `/stream`의 반복 `since`는
`<roomId>:<messageId>`이며 마지막 콜론에서 나눕니다. 모든 JSON 봉투와 SSE
페이로드는 테스트에서 고정된 계약 스키마로 검증합니다.

## 하지 않는 것

로그인 자동화, 공식 API 를 벗어난 프로토콜 조작, 사용자가 자기 클라이언트로 볼 수
없는 기록의 수집, 대량 발송.
