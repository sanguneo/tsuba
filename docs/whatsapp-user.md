# WhatsApp-Personal 어댑터

개인 WhatsApp 계정으로 동작하는 어댑터입니다(`account.kind: "user"`,
`provider.id: "whatsapp-user"`, saya 표시 이름 `WhatsApp-Personal`). 비공식
클라이언트 라이브러리 [Baileys](https://github.com/WhiskeySockets/Baileys)
(`@whiskeysockets/baileys` 6.7.24, 버전 고정)로 WhatsApp Web 의 "연결된 기기"가
됩니다.

## 먼저 읽을 것: 위험

> [!WARNING]
> **WhatsApp 은 개인 번호용 공식 API 를 제공하지 않습니다.** 비공식 클라이언트는
> WhatsApp 약관이 금지하며, **계정이 정지·차단될 수 있습니다.** 이 어댑터의 소유자가
> 이 위험을 알고 직접 결정해 넣었습니다(2026-11-16). 주 번호 대신 **보조 번호**로
> 쓰기를 권합니다. 어댑터를 쓰지 않을 때는 아래 「끄는 법」을 따르세요.

AGENTS.md 의 「Deliberately absent」(공식 API 없는 메신저의 프로토콜 재구현 금지)에
대한 예외이며, 이유와 위험은 이 문서에 둡니다. 선례는 `discord-user` 입니다.
위험을 줄이려고 이 어댑터는 다음을 지킵니다.

- 보내기를 자동으로 다시 시도하지 않습니다. 결과를 모르면 `INTERNAL` 로 답합니다.
- 끊긴 연결은 1초에서 시작해 두 배씩, 최대 60초 간격으로 다시 잇습니다.
- 로그아웃(401), 다른 Web 세션의 가로채기(440), WhatsApp 의 거절(403)이면 다시
  잇지 않고 상태만 알립니다. 재로그인을 시도하지 않습니다.
- 접속해도 "온라인" 표시를 올리지 않고(`markOnlineOnConnect: false`), 전체 기록
  동기화를 요청하지 않으며, 링크 미리보기를 만들지 않습니다.
- 대량 동작이 없습니다. 쓰기는 serve-kit 의 쓰기 줄 하나로 한 번에 하나씩 갑니다.

## 로그인

로그인은 사람이 합니다. 자동화나 우회는 없습니다.

```sh
bun adapters/whatsapp-user/src/cli.ts login
```

터미널에 QR 코드가 뜹니다. 폰에서 **WhatsApp > 연결된 기기 > 기기 연결**로
찍으세요. 3분 안에 연결되지 않으면 끝납니다(다시 실행). 연결에 성공하면
`linked` 를 출력합니다. 세션은 `sessions/whatsapp/` 에 저장됩니다(폴더 700,
파일 600, `sessions/` 는 git 에서 제외). 세션은 계정 비밀번호와 같으니 복사·공유하지
마세요.

## 실행

```sh
bun adapters/whatsapp-user/src/cli.ts serve
```

`login` 을 하지 않았으면 `serve` 는 시작하지 않고 안내만 출력합니다.
어댑터 디렉터리의 `bun run login`, `bun run serve` 도 같은 명령입니다.
출력은 `state: open` 같은 상태와 개수뿐입니다. 전화번호, 이름, 메시지 내용,
QR, 세션 내용은 어디에도 출력하지 않습니다(Baileys 의 로그도 끕니다).

| 설정 | 기본값 |
| --- | --- |
| `TSUBA_WHATSAPP_USER_HTTP_TOKEN` | `TSUBA_TOKEN` |
| `TSUBA_WHATSAPP_USER_PORT` | `8795` |
| `TSUBA_HOST` | `127.0.0.1` |

`deploy/tsuba@.service` 에서는 `whatsapp-user` 인스턴스로 실행합니다
(`systemctl enable --now tsuba@whatsapp-user`). 로그인은 서비스를 띄우기 전에,
같은 사용자로, 같은 `sessions/` 에서 한 번 해 둡니다.

## 끄는 법

- 어댑터만 끄기: `systemctl stop tsuba@whatsapp-user`(또는 프로세스에 SIGINT).
- 이 기기의 연결 끊기: 폰의 **연결된 기기**에서 이 기기를 로그아웃합니다.
  어댑터는 `logged-out` 상태가 되며 다시 잇지 않습니다.
- 완전히 지우기: 위 로그아웃 뒤 `sessions/whatsapp/` 를 삭제합니다.

## 선언한 기능과 근거

선언한 것은 아래 다섯 가지뿐입니다. 선언하지 않은 기능은 없는 것이며, 해당
라우트는 `NOT_SUPPORTED` 로 답합니다.

| 기능 | 선언 | 근거 |
| --- | --- | --- |
| `rooms.list` | — | 기록 동기화·새 메시지·연결 시 조회한 참여 그룹을 최근 활동순으로 최대 500개. **`complete` 는 항상 `false`**: WhatsApp 은 전부 보냈다고 알려 주지 않습니다 |
| `messages.read` | `paging: before-id`, `maxLimit: 100` | **어댑터가 시작한 뒤 본 메시지**를 방마다 최근 200개까지 메모리에서 답합니다. 디스크에 저장하지 않으며, 재시작하면 처음부터입니다. WhatsApp 에는 방의 지난 기록을 가져오는 호출이 없습니다. `hasEarlier` 는 메모리 안에서의 뜻입니다 |
| `messages.stream` | `resume: none`, 이벤트 `message.edited`, `message.deleted` | 연결 중 도착한 새 메시지·수정·삭제를 그대로 전합니다. 끊겼다 이으면 놓친 것을 되짚을 커서가 없어 `resume` 은 `none` 입니다 |
| `messages.send` | `maxLength: 2048`, `receipt: accepted` | 글자 수 한도는 개인 계정에 대해 문서화되지 않았고 측정도 못 했습니다. 2048 코드포인트는 최대 4096 UTF-16 단위이며 WhatsApp 공식 Cloud API 의 본문 한도(4096)보다 작아 보수적입니다. `accepted` 는 WhatsApp 서버가 받았다는 뜻일 뿐 전달·읽음이 아닙니다 |
| `messages.reply` | — | 어댑터가 본 메시지만 인용할 수 있습니다. 모르는 메시지에 답하면 아무것도 보내지 않고 `NOT_FOUND` |

표시하는 메시지는 글과 캡션이 있는 미디어(`kind: media`, 첨부 바이트 없음)입니다.
반응, 시스템 메시지, 알 수 없는 종류는 보이지 않습니다. 방은 1:1 대화, 그룹,
LID 주소이며 상태(status), 방송 목록, 채널(뉴스레터)은 제외합니다.

그룹 제목은 연결이 열릴 때 참여 그룹을 조회하고, 이후 그룹 추가·변경 이벤트의
`subject` 로 갱신합니다. 제목 없는 부분 변경이나 늦은 채팅 기록이 최신 subject 를
덮지 않습니다. 조회에 실패해도 기존 방과 연결을 유지하며, 출력에는
`group metadata unavailable` 상태만 남깁니다.

1:1 방은 연락처의 `lid`·`jid` 와 번호 공유 이벤트를 같은 사람의 별칭으로 연결합니다.
이름은 저장한 연락처 이름, 채팅 이름, 연락처 `notify`, 수신 메시지의 최신 `pushName`
순서로 고릅니다. 이름 없는 연락처 부분 변경은 이미 받은 이름을 지우지 않고,
늦게 온 옛 메시지는 최신 pushName 을 덮지 않습니다. 자기 메시지의 pushName 은
상대방 이름으로 쓰지 않으며, 별칭이 연결되어도 방 id 와 메시지 기록은 합치지 않습니다.

## 못 하는 것

첨부 읽기·보내기, 반응, 수정, 삭제, 읽음 표시, 입력 중 표시, 프로필 사진,
정확한 안 읽음 수의 보장(WhatsApp 이 보낸 값을 그대로 쓰며 없으면 0),
지난 기록 불러오기, 재시작 뒤 기록 유지. 확실히 동작을 확인하지 못한 기능은
선언하지 않았습니다.

## 오류

| 상황 | 코드 |
| --- | --- |
| 로그인하지 않았거나 로그아웃됨, 보내기에서 401 | `REAUTH_REQUIRED`(`login` 을 다시 실행) |
| 연결 중·재연결 중·가로채기 상태에서 보내기 | `BUSY` — 아무것도 보내지 않았음 |
| WhatsApp 의 거절(403) | `FORBIDDEN` |
| 속도 제한(429) | `RATE_LIMITED` |
| 그 밖의 보내기 실패 | `INTERNAL` — 결과를 알 수 없으므로 자동 재시도하지 않음 |

## 확인 범위

회귀 테스트는 합성 데이터와 Baileys 소켓을 흉내 낸 가짜로 선언과 구현의 짝, 매핑,
스트림, 보내기, 끊김·로그아웃 처리를 확인합니다. **실제 WhatsApp 계정으로는
로그인도 발송도 검증하지 않았습니다.** 첫 실행은 보조 번호로, 운영자가 직접
확인하세요.
