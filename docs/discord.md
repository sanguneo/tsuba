# Discord 어댑터

`serve`는 시작할 때 파란 `adapters/discord/icon.svg`를 한 번 읽어 `/icon`으로 답하고 `provider.icon`에 바이트 버전을 알립니다(0.2.5).

**봇 계정**으로 동작합니다(`account.kind: "bot"`). 사람 계정 토큰으로 클라이언트를 흉내 내는
방식(셀프봇, mautrix-discord 의 퍼펫팅)은 Discord 약관 위반이라 만들지 않습니다. 그래서 이
어댑터는 **봇을 초대한 서버**의 채널만 보고, 봇이 쓴 글은 봇 이름으로 올라갑니다.

## 기반: discord.js

[`discord.js`](https://github.com/discordjs/discord.js) 14.27.0 (Apache-2.0)을 씁니다.
게이트웨이 재연결·재개, REST 요청 한도(버킷), 채널·역할·권한 캐시를 맡기고, Bun 공식 문서에
[discord.js 안내](https://bun.com/guides/ecosystem/discordjs)가 있습니다. 음성(`@discordjs/voice`)은
Bun 에서 문제가 알려져 있지만 쓰지 않습니다. 검토한 대안은 [`references.md`](references.md)에 있습니다.

- `rest.retries: 0` — 결과를 모르는 쓰기를 라이브러리가 다시 보내지 않게 합니다. 429 는 Discord 가
  처리하지 않았다는 뜻이라 discord.js 가 기다렸다가 보내는 것은 중복이 아닙니다.
- 타입 검사는 `skipLibCheck` 없이 통과합니다. `@sapphire/shapeshift` 가 @types/node 26 에서 빠진
  `util.InspectOptionsStylized` 를 이름으로 쓰기 때문에 `src/environment.d.ts` 가 그 하나를 보충합니다.

## 무엇이 방인가

Discord 의 서버(길드)에는 채널이 여럿 있습니다. 그중 **일반 텍스트 채널(`GUILD_TEXT`, 0)** 만
방이 됩니다. 봇에게 채널 보기(`VIEW_CHANNEL`)와 기록 읽기(`READ_MESSAGE_HISTORY`)가 둘 다 있어야
합니다.

| 채널 | 방? | 이유 |
| --- | --- | --- |
| 텍스트 채널 | 예 | 일반 대화방 |
| 공지(announcement) 채널 | 아니요 | 방송용, 팔로우·크로스포스트 |
| 포럼·미디어 채널, 스레드 | 아니요 | 방이 아니라 글타래 (계약의 `threads.read` 는 아직 예약) |
| 음성·스테이지 채널의 채팅 | 아니요 | 통화에 딸린 채팅 |
| 그룹 DM | 아니요 | Discord 가 봇을 그룹 DM 에 넣지 않음 |
| 봇과의 1:1 DM | 아니요 | 봇은 DM 목록을 조회할 수 없음 |

- 제목은 `서버 이름 · #채널 이름` 입니다. 서버가 여럿이면 `#general` 이 여러 개라서입니다.
- `kind` 는 `group` 입니다. 봇에게 보내기 권한이 없으면 그 방은
  `"features": {"messages.send": false}`, 반응 권한이 없으면 `"reactions.send": false` 를 가집니다.
- **안 읽음 수는 늘 0입니다.** Discord 는 봇의 읽음 상태를 두지 않습니다(봇은 ack 할 수 없음).
  그래서 `read.mark` 도 신고하지 않고, saya 의 배지는 Discord 에 붙지 않습니다.
- `lastActivityAt` 은 채널의 마지막 메시지 id(snowflake)에 들어 있는 시각입니다. 요청을 더 하지
  않습니다.
- 목록은 게이트웨이가 채워 둔 채널 캐시에서 만들므로 방 목록 요청이 Discord 로 가지 않습니다. 메시지 캐시는
  끕니다: discord.js 는 다시 읽은 메시지를 캐시에 덧붙일 때 Discord 에서 사라진 반응을 지우지 않아, 방금 뗀
  반응이 남아 보였습니다(2026-10-01 실제 서버에서 확인). 그래서 미리보기(`lastMessage`)는 없습니다.
- 최근 활동순, 최대 500개입니다.

## 구현된 기능 신고

| 기능 | 값 | 구현 |
| --- | --- | --- |
| `rooms.list` | `{}` | 위 "무엇이 방인가" |
| `messages.read` | `paging: before-id`, `maxLimit: 100` | `GET /channels/{id}/messages` (Discord 의 한 번 상한 100) |
| `messages.stream` | `resume: cursor`, `events: [message.edited, message.deleted, reactions.updated]` | 게이트웨이 이벤트, 이어 읽기는 `after` 로 페이지 단위 |
| `messages.send` | `maxLength: 1000`, `receipt: stored` | Discord 의 2000 UTF-16 단위 한도에 astral 문자가 들어가도 넘지 않도록 코드 포인트 기준으로 절반을 신고하는 보수적 상한 |
| `messages.reply` | `{}` | `message_reference`, 원문이 없으면 실패(`failIfNotExists`) |
| `messages.edit` | `maxLength: 1000` | 봇 자신의 메시지만. Discord 는 수정 시간 제한이 없음 |
| `messages.delete` | `forEveryone: true` | 봇 자신의 메시지만. 남의 메시지 삭제는 아직 신고하지 않음 |
| `reactions.read` | `{}` | 유니코드 이모지 반응만(서버 커스텀 이모지는 뺌) |
| `reactions.send` | `maxPerMessage: 20` | 지금 내 반응과 원하는 목록의 차이만큼 빼고 더함. 메시지 전체 반응 종류가 20개를 넘을 요청은 변경 전에 거절. 여러 REST 변경 중 예상 밖 오류가 나면 일부가 적용됐을 수 있으므로 `INTERNAL` (결과 불명) |
| `attachments.read` | `{}` | 메시지를 다시 읽어 서명된 CDN 주소를 새로 받고, `cdn.discordapp.com`·`media.discordapp.net` 에서만 받아 흘려 보냄 |
| `avatars.read` | `{}` | 서버별 프로필 사진 우선, 없으면 사용자 프로필 사진. 기본 사진은 생략. `senderAvatar` 는 해시를 포함한 불투명 id이며 `/media` 가 Discord CDN 의 64px PNG 를 반환하므로 사진이 바뀌면 id 도 바뀜 |

보내는 글은 `@everyone`·`@here`·역할을 부르지 않습니다(`allowedMentions: users`). 쓰기는 serve-kit
의 줄 하나를 함께 씁니다. 권한은 방 목록에서 확인하고, `messages.send` 또는
`reactions.send` 를 할 수 없는 방은 `Room.features` 에 `false` 로 내려 saya 가 버튼을
그리지 않게 합니다.

## 이벤트

- `message.edited`: `messageUpdate`. 어댑터가 켜지기 전 메시지는 일부만 오므로 다시 읽어 보냅니다.
- `message.deleted`: `messageDelete`, `messageDeleteBulk`. 채널을 늘 알려 주므로 모두 방에 놓입니다.
- `reactions.updated`: 반응 추가·제거·이모지 전체 제거 때 메시지를 다시 읽어 Discord 의 개수로
  보냅니다. 반응 전체 제거는 `[]` 입니다.
- 이어 읽기는 새 메시지만 다시 보냅니다(계약 규칙).

## 오류 대응

| Discord | 계약 |
| --- | --- |
| 401 (토큰 무효·재발급됨) | `503 REAUTH_REQUIRED` — 새 토큰을 넣고 다시 시작 |
| 403 (권한 없음, 50001·50013 등), 30010 (반응 종류 20개 초과) | `403 FORBIDDEN` |
| 404 (없는 채널·메시지, 10003·10008) | `404 NOT_FOUND` |
| 429 | `429 RATE_LIMITED` |
| 그 밖의 400 (본문 오류, 없는 이모지 등) | `400 INVALID_REQUEST` |
| 그 외 | `500 INTERNAL` — 쓰기에서는 결과를 모름, 재시도 없음 |

## 준비 (사람이 직접)

1. <https://discord.com/developers/applications> 에서 **New Application** → **Bot**.
2. **Privileged Gateway Intents** 에서 **Message Content Intent** 를 켭니다(없으면 글 내용이 빈 문자열로 옴).
3. **Reset Token** 으로 봇 토큰을 받아 `.env` 의 `TSUBA_DISCORD_TOKEN` 에 넣습니다. 이 토큰은 봇
   계정 전체 권한이라 비밀번호로 다룹니다.
4. **OAuth2 → URL Generator** 에서 scope `bot`, 권한 *View Channels, Send Messages, Read Message
   History, Add Reactions* 를 골라 만든 주소로 봇을 서버에 초대합니다. 봇이 각 방에서 실제로
   받는 역할/권한이 기준입니다. 숨긴 방은 목록에도 없습니다.

```sh
bun adapters/discord/src/cli.ts check   # 서버 수, 방 수, 읽기 전용 방 수만 출력
bun adapters/discord/src/cli.ts serve   # 127.0.0.1:8792
```

- HTTP 토큰은 `TSUBA_DISCORD_HTTP_TOKEN`(없으면 `TSUBA_TOKEN`), 포트 `TSUBA_DISCORD_PORT`(기본
  8792), 주소 `TSUBA_HOST`. Telegram 어댑터(8790)와 같은 저장소·같은 `.env` 에서 나란히 돌 수 있습니다.

## 실제 확인 (2026-10-01)

봇을 새로 만든 개인 서버에 초대해, 개수와 상태만 기록합니다.

- 서버 1, 방 1(텍스트 채널), 쓰기 가능. OCI 에서 `127.0.0.1:8792`, tailnet `https://oci.tailcbc039.ts.net/discord`.
- 보내기(`@everyone`·`<` 를 담은 글이 그대로 왕복, 아무도 부르지 않음), 답장(`replyTo` 가 원문), 수정(`editedAt`),
  반응 달기·떼기, 읽기, 삭제가 모두 200.
- 스트림: `message`·`cursor`, `message.edited`, `reactions.updated`, `message.deleted` 를 받음.
- 처음에는 뗀 반응이 남아 보였습니다. discord.js 메시지 캐시 때문이라 캐시를 껐습니다(`5f68562`, `d7d0886`).
- 남은 선택 사항: 공개 봇 끄기(설치 탭의 설치 링크를 "없음"으로 저장한 뒤 봇 탭에서 끔).

## 하지 않는 것

사람 계정 자동화(셀프봇), 봇이 볼 수 없는 채널의 기록 수집, 대량 발송.
