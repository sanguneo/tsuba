# Discord-Personal 어댑터

개인 Discord 계정으로 동작하는 별도 어댑터입니다(`account.kind: "user"`).
봇 어댑터의 `provider.id: "discord"`와 달리 `discord-user`이며, saya에는
`Discord-Personal`로 표시됩니다. 계정 연결 정보는 tsuba에만 둡니다.

## 실행

직접 준비한 계정 토큰을 저장소 루트의 `.env`에 `TSUBA_DISCORD_USER_TOKEN`으로
설정합니다. 토큰은 계정 비밀번호처럼 다루며 출력하거나 공유하지 않습니다.
로그인 자동화나 토큰 추출 기능은 없습니다.

```sh
bun adapters/discord-user/src/cli.ts check
bun adapters/discord-user/src/cli.ts serve
```

`check`는 REST로 방 목록을 확인하고 방 수만 출력합니다. 방 이름, 사람 이름,
메시지 내용은 출력하지 않으며 Gateway 연결도 열지 않습니다. `serve`는
HTTP 서버를 시작하고 스트림 구독 시 Gateway에 연결합니다.
어댑터 디렉터리의 `bun run serve`도 같은 명령입니다.

| 설정 | 기본값 |
| --- | --- |
| `TSUBA_DISCORD_USER_TOKEN` | 필수, 개인 계정 토큰 |
| `TSUBA_DISCORD_USER_HTTP_TOKEN` | `TSUBA_TOKEN` |
| `TSUBA_DISCORD_USER_PORT` | `8794` |
| `TSUBA_HOST` | `127.0.0.1` |

`deploy/tsuba@.service`에서는 `discord-user` 인스턴스로 실행합니다.

## 방과 메시지

- 일반 서버 텍스트 채널(0), 1:1 DM(1), 그룹 DM(3)을 방으로 표시합니다.
  공지, 포럼, 스레드, 음성·스테이지 채널은 포함하지 않습니다.
- 서버 채널 제목은 `서버 이름 · #채널 이름`입니다. 최근 활동순으로 정렬하며
  최대 500개를 반환합니다. 일부 서버 조회가 실패하거나 상한을 넘으면
  `complete: false`입니다.
- REST 목록만으로 계정의 정확한 안 읽음 수를 알 수 없어 `unread`는 0입니다.
  개인 계정의 읽음 표시는 `/ack`로 요청하며 실패는 호출자에게 전달합니다.
- 메시지는 한 번에 최대 100개를 읽습니다. 이전 페이지 존재 여부는 가장 오래된
  메시지 이전을 추가 조회해 확인합니다. 이어 읽기는 커서 메시지 존재 여부를
  먼저 확인하고 모든 페이지를 읽습니다.
- 미리보기는 마지막 메시지의 최대 200 코드포인트입니다.

## 쓰기와 첨부

- 보내기·수정의 한도는 1000 코드포인트입니다. Discord의 2000 UTF-16 단위
  한도를 astral 문자만 담은 글도 넘지 않도록 신고하는 보수적 상한입니다.
- 보내기는 저장된 메시지를 반환합니다(`receipt: stored`). 답장 원문이 없으면
  전송을 거절합니다. 글의 `@everyone`, `@here`, 역할 멘션은 호출하지 않습니다.
- 수정은 계정 자신의 메시지에 적용되며, 삭제된 메시지는 모두에게서 사라집니다.
- 유니코드 이모지 반응만 표시합니다. 반응 요청은 계정의 최종 집합이며,
  제거 후 추가합니다. 메시지 전체 반응 종류 상한은 20개입니다.
  일부 변경 뒤 실패하면 `INTERNAL`로 결과 불명을 알리고 재시도하지 않습니다.
- 첨부는 메시지를 다시 읽어 만료 가능한 서명 주소를 갱신한 뒤,
  HTTPS의 `cdn.discordapp.com` 또는 `media.discordapp.net`에서만 받습니다.
  리다이렉트는 따르지 않으며 내려받기 헤더는 serve-kit이 결정합니다.

## 오류와 확인 범위

401은 `REAUTH_REQUIRED`(토큰 교체 후 재시작), 403은 `FORBIDDEN`, 404는
`NOT_FOUND`, 429는 `RATE_LIMITED`, 400은 `INVALID_REQUEST`입니다.
그 밖의 실패는 `INTERNAL`이며 쓰기 결과를 알 수 없으므로 자동 재시도하지 않습니다.

회귀 테스트는 합성 데이터와 주입한 HTTP 응답으로 계약·실패 경로를 확인합니다.
이번 수정에서는 실제 개인 Discord 계정으로 검증하지 않았습니다.
