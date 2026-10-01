# Slack 어댑터

`serve`는 시작할 때 `adapters/slack/icon.svg`를 한 번 읽어 `/icon`으로 답하고 `provider.icon`에 바이트 버전을 알립니다(0.2.5).

**내 계정**으로 동작합니다(`account.kind: "user"`). Slack 이 공식으로 내주는 **사용자 토큰**
(`xoxp-`)으로 내 권한 그대로 읽고 쓰며, 실시간 이벤트는 **Socket Mode** 의 앱 수준 토큰
(`xapp-`)으로 받습니다. 브라우저 쿠키 토큰(`xoxc-` + `d` 쿠키)처럼 공식 앱을 흉내 내는 방식은 쓰지
않습니다.

## 기반: 라이브러리 없이

Web API 는 HTTPS 폼 요청이고 Socket Mode 는 WebSocket 하나라서 Bun 내장 `fetch`·`WebSocket` 으로
직접 부릅니다(`src/api.ts`, `src/socket.ts`). 의존성은 반응 이모지 이름표뿐입니다:
[`emoji-datasource`](https://github.com/iamcal/emoji-data) 16.0.0 (MIT) — Slack 이 쓰는 바로 그 표입니다.

- 토큰은 늘 `Authorization` 헤더에만 싣고, 본문·주소·로그에 넣지 않습니다.
- 쓰기는 한 번만 보냅니다. 429 와 Slack 이 밝힌 거절은 바뀐 것이 없다는 코드로, 그 밖은 `INTERNAL`
  (결과를 모름)입니다.
- 2025년 Slack 의 기록 읽기 제한(분당 1회·15개)은 **마켓플레이스 밖으로 상용 배포하는 앱**에만
  적용됩니다. 자기 워크스페이스에만 설치하는 이 앱은 `conversations.history` Tier 3(분당 50+)입니다.

## 무엇이 방인가

내가 들어가 있는 대화 전부입니다(`users.conversations`, 보관된 것은 뺌).

| Slack | 방 | 제목 | `kind` |
| --- | --- | --- | --- |
| 공개 채널, 비공개 채널 | 예 | `#이름` | `group` |
| DM | 예 | 상대의 표시 이름 | `direct` |
| 그룹 DM | 예 | 나를 뺀 사람들의 핸들 | `group` |
| 스레드 | 아니요 | — | 스레드는 방이 아닙니다(계약의 `threads.read` 는 아직 예약) |

- **안 읽음 수와 최근 활동**: DM 은 Slack 의 값(`conversations.info` 의 `unread_count_display`, `latest`)입니다.
  채널·비공개 채널·그룹 DM 에는 Slack 이 그 값을 주지 않아서(2026-10-01 실제 워크스페이스에서 확인:
  `last_read` 만 옴), 최신 메시지 하나(`conversations.history limit=1`)와 `last_read` 이후의 남이 쓴 메시지
  수(스레드 안 답글 제외, 최대 100)로 셉니다. 방마다 호출이 최대 셋이라 3초에 한 방씩(기록 읽기 분당 40
  이하) 채워 나갑니다. 채워지기 전의 방은 안 읽음 0, 활동 시각 없음으로 보입니다. 새 이벤트가 온 방은 먼저
  다시 채웁니다.
- 탈퇴한 사람과의 DM 은 `"features": {"messages.send": false}` 입니다. 그 밖의 제한(공지 전용 채널
  등)은 보낼 때 Slack 이 거절하고 `403 FORBIDDEN` 으로 답합니다.
- 최대 500개.

## 메시지

- id 는 Slack 의 `ts`(`1700000000.123456`) 그대로입니다. 커서 `since=<방>:<ts>` 도 그대로 씁니다.
- 본문은 mrkdwn 을 글자로 바꿉니다: `<@U…>` → `@이름`, `<#C…|이름>` → `#이름`, `<!here>` →
  `@here`, 링크는 주소(라벨이 다르면 `라벨 (주소)`), `&lt;`·`&gt;`·`&amp;` 를 되돌립니다.
  보내는 글은 거꾸로 세 글자를 이스케이프해서 saya 에서 쓴 `<!channel>` 같은 글이 멘션이 되지 않습니다.
- 입장·퇴장·주제 변경 같은 하위 형식은 `service`, 파일이 있으면 `media` 입니다.
- 스레드 안의 답글은 채널 기록에 없으므로 보이지 않습니다. 채널에도 보내진 답글(`thread_broadcast`)은
  보이고 `replyTo` 가 스레드의 첫 메시지입니다.

## 구현된 기능 신고

| 기능 | 값 | 구현 |
| --- | --- | --- |
| `rooms.list` | `{}` | 위 "무엇이 방인가" |
| `messages.read` | `paging: before-id`, `maxLimit: 100` | `conversations.history`, `latest` 로 이전 페이지, `has_more` |
| `messages.stream` | `resume: cursor`, 이벤트 3종 | Socket Mode 의 사용자 이벤트, 이어 읽기는 `oldest` 로 |
| `messages.send` | `maxLength: 4000`, `receipt: stored` | `chat.postMessage`. 4000 은 Slack 권고, 40,000 을 넘으면 Slack 이 잘라 냄 |
| `messages.reply` | `{}` | 답할 메시지의 스레드(`thread_ts`)에, `reply_broadcast` 로 채널에도 |
| `messages.edit` | `maxLength: 4000` | `chat.update`. 워크스페이스가 수정 시간을 제한하면 `403` |
| `messages.delete` | `forEveryone: true` | `chat.delete` |
| `reactions.read` | `{}` | 유니코드 이모지만(워크스페이스 커스텀 이모지는 뺌), 피부색 포함 |
| `reactions.send` | `{}` | 내 반응과 원하는 목록의 차이만큼 `reactions.remove`·`add` |
| `read.mark` | `{}` | `conversations.mark`. Slack 의 내 읽음 위치가 바뀜 |
| `attachments.read` | `{}` | 메시지를 다시 읽어 `url_private_download` 를 받고, `files.slack.com` 에만 토큰을 실어 받음 |
| `avatars.read` | `{}` | `users.info` 의 `profile.image_72` 를 URL 해시가 붙은 `senderAvatar` id 로 제공. `/media` 에서 사용자를 다시 확인하고 HTTPS 허용 호스트에만 토큰 없이 요청. 리다이렉트는 허용 호스트 안에서만 최대 3번 따라감(Gravatar 가 사진 없는 사람을 Slack 기본 사진으로 보냄. 그 경유지 `i0`~`i2.wp.com` 은 Gravatar 다음 단계일 때만) |

프로필 사진 호스트는 `avatars.slack-edge.com`, `secure.gravatar.com`, `a.slack-edge.com` 만 허용합니다.
근거: Slack [user object](https://docs.slack.dev/reference/objects/user-object/),
[`users.list` 예시](https://docs.slack.dev/reference/methods/users.list/), 공식 Python SDK 의
[`rtm.start.json` 프로필 예시](https://github.com/slackapi/python-slack-sdk/blob/main/tests/slack_sdk_fixture/rtm.start.json).
사용자 정보는 10분 캐시하지만 사진 요청은 새로 확인합니다. URL 이 바뀐 옛 id 는 `404 NOT_FOUND` 입니다.
사진이 없거나 허용 URL 이 아니면 필드를 생략합니다. 앱이 봇 사용자(`user`)로 올린 글은 그 사용자의 사진을 쓰고,
`bot_id` 만 있는 글은 추가 조회 없이 사진을 생략합니다.

## 이벤트

| Slack | 계약 |
| --- | --- |
| `message` (하위 형식 없음, `bot_message`, `file_share`, `thread_broadcast`, `me_message`) | `message` |
| `message` / `message_changed` | `message.edited` |
| `message` / `message_deleted` | `message.deleted` |
| `reaction_added`, `reaction_removed` | 메시지를 다시 읽어 `reactions.updated` |

Socket Mode 의 봉투는 받는 즉시 응답(ack)합니다(3초 안에 하지 않으면 Slack 이 다시 보냄).
`disconnect` 안내, 끊김, 여는 실패는 지수 대기 후 다시 엽니다.

## 오류 대응

| Slack `error` | 계약 |
| --- | --- |
| `invalid_auth`, `not_authed`, `token_revoked`, `token_expired`, `account_inactive` | `503 REAUTH_REQUIRED` — 앱을 다시 설치해 새 토큰 |
| HTTP 429, `ratelimited` | `429 RATE_LIMITED` |
| `missing_scope`, `restricted_action*`, `not_in_channel`, `is_archived`, `cant_update_message`, `cant_delete_message`, `edit_window_closed`, `too_many_reactions`, `access_denied` 등 | `403 FORBIDDEN` |
| `channel_not_found`, `message_not_found`, `file_not_found` 등 | `404 NOT_FOUND` |
| `invalid_name`, `msg_too_long`, `no_text`, `invalid_cursor` 등 | `400 INVALID_REQUEST` |
| 그 외, 연결 실패, JSON 이 아닌 답 | `500 INTERNAL` — 쓰기에서는 결과를 모름 |

## 준비 (사람이 직접)

이미 쓰는 앱(예: 다른 봇)에 섞지 말고 **새 앱**을 만듭니다. 권한이 섞이지 않고, 지우기도 쉽습니다.

1. <https://api.slack.com/apps> → **Create New App** → **From a manifest** → 워크스페이스 선택 →
   [`adapters/slack/manifest.json`](../adapters/slack/manifest.json) 내용을 붙여 넣고 만듭니다.
   사용자 범위, 사용자 이벤트, Socket Mode 가 한 번에 설정됩니다.
2. **Basic Information → App-Level Tokens → Generate Token**: 범위 `connections:write` →
   `xapp-…` 를 `TSUBA_SLACK_APP_TOKEN` 에.
3. **Install App → Install to Workspace** → 승인 → **User OAuth Token** `xoxp-…` 를
   `TSUBA_SLACK_USER_TOKEN` 에. 두 토큰 모두 내 계정 전체 권한이라 비밀번호로 다룹니다.

```sh
bun adapters/slack/src/cli.ts check   # 방 수, DM 수, 그룹 수, 쓰기 불가 수만 출력
bun adapters/slack/src/cli.ts serve   # 127.0.0.1:8793
```

- HTTP 토큰 `TSUBA_SLACK_HTTP_TOKEN`(없으면 `TSUBA_TOKEN`), 포트 `TSUBA_SLACK_PORT`(기본 8793).
- 회사망 PC 에서는 Slack 이 막혀 있어, Slack 에 닿는 기계에서 띄웁니다(`docs/deployment.md`).

## 실제 확인 (2026-10-01)

회사 워크스페이스의 새 앱 `tsuba`(사용자 토큰 + Socket Mode)로, 개수와 상태만 기록합니다.

- 방 83개(DM 34, 채널·그룹 DM 49), 쓰기 불가 0. 채움 한 바퀴 뒤 최근 활동이 있는 방 45, 안 읽음이 있는 방 4.
- 쓰기는 **내 자신과의 DM** 에서만, 남에게 알림이 가지 않게 했습니다. 보내기(`<`·`&` 왕복 그대로),
  수정(`editedAt`), 반응 달기·떼기, 읽음 처리, 답장(`replyTo` 가 원문, 방 목록에 보임), 삭제가 모두 200.
- 스트림: 같은 방에 대해 `message`, `message.edited`, `reactions.updated`, `message.deleted` 를 받음.
- 첨부: 기존 이미지 하나를 `/media` 로 받아 `image/png`, sandbox CSP, 바이트 수가 신고한 크기와 같음.
- 처음 실행에서 채널의 안 읽음·활동이 비어 있던 것(`conversations.info` 가 DM 에만 값을 줌)과 한 번도 읽지
  않은 방의 `last_read` 가 0 이라 거절되던 것을 고쳤습니다(`f086086`, `d34e153`).

## 하지 않는 것

브라우저 세션 토큰(`xoxc-`)이나 쿠키를 쓰는 접속, 내가 볼 수 없는 대화의 수집, 대량 발송.
