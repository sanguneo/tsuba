![つば (tsuba)](assets/tsuba-og.png)

# つば (tsuba)

> *Many messengers, one guard.*
> ひとつに、つなぐ。

메신저 어댑터 모음입니다. 어댑터마다 메신저 계정 하나를 쥐고 로컬 프로세스로 돌며,
모두 같은 HTTP + SSE 계약(`contract/openapi.json`)으로 답합니다. 웹 클라이언트
[saya](https://github.com/sanguneo/saya) 가 그 계약을 그립니다.

칼날(어댑터)과 칼집(saya) 사이의 날밑이라 tsuba 입니다. 카카오톡은 여기 없습니다 —
데스크톱 클라이언트가 있는 기계에서 `kanao`/`kamado` 코어가 자기 계약으로 답합니다.

> [!IMPORTANT]
> **업그레이드 안내 (2026-10-06): saya 연결 방식이 바뀌었습니다.** saya 쪽에 어댑터 주소·토큰을 적지 않고, 어댑터가 `.env` 의 `SAYA_REGISTER_URL`·`SAYA_REGISTER_TOKEN` 으로 saya 에 스스로 등록합니다(아래 「saya에 붙이기」).
> 기존 배포는 [업그레이드 가이드](https://github.com/sanguneo/saya/blob/main/docs/upgrade-registration.md)를 따라 옮기세요. 에이전트에게 그 문서를 주고 "이대로 옮겨 줘"라고
> 하면 됩니다.

## 상태

계약 0.2.5의 서버와 첫 어댑터를 구현했습니다.

- `contract/openapi.json` — `/health`, `/capabilities`, `/icon`, `/rooms`, `/messages`, `/media`, `/stream`, `/send`, `/edit`, `/delete`, `/react`, `/read`
- `contract/CHANGELOG.md` — 계약 버전마다 바뀐 것과 이유
- `docs/contract.md` — 계약 규칙(버전 호환, 오류 코드, 방별 기능, 라우트·이벤트 이름, 첨부)과 예약된 이름 대장
- `packages/serve-kit` — 인증, 기능 신고 검증, 방/메시지 라우팅, SSE 이어 읽기와 변경 이벤트, 쓰기 줄 하나, 첨부 응답 헤더
- `adapters/telegram` — mtcute 기반 사용자 계정 클라이언트. 방 목록(방별 쓰기 가능 여부 포함), 이전 메시지, 첨부, 커서 스트림(수정·삭제·반응 포함), 텍스트 전송과 답장, 수정, 삭제, 반응, 읽음 처리
- `adapters/discord` — discord.js 기반 **봇 계정**. 봇을 초대한 서버의 일반 텍스트 채널, 이전 메시지, 첨부, 커서 스트림(수정·삭제·반응 포함), 전송과 답장, 수정, 삭제, 반응
- `adapters/slack` — 공식 사용자 토큰과 Socket Mode 로 **내 계정**. 채널·비공개 채널·DM·그룹 DM, 이전 메시지, 첨부, 커서 스트림(수정·삭제·반응 포함), 전송과 답장(스레드+채널), 수정, 삭제, 반응, 읽음 처리
- `docs/telegram.md`, `docs/discord.md`, `docs/slack.md` — 실행 방법과 구현된 기능/한계
- `docs/references.md` — 구현 전에 검토한 참고 저장소와 가져올 것

검증은 합성 데이터와 실제 로컬 Bun HTTP 서버로 합니다. 새 구현의 실제 Telegram
계정 검증은 운영자가 별도로 수행합니다.

## 기능 신고

메신저마다 할 수 있는 일이 다릅니다. 어댑터는 `GET /capabilities` 로 지원하는 기능과
그 한계를 밝히고, 클라이언트는 밝혀진 것만 그립니다. **밝히지 않은 기능은 없는
것입니다.**

```sh
curl -H "Authorization: Bearer $TSUBA_TOKEN" http://127.0.0.1:8790/capabilities
```

## saya에 붙이기

**2026-10-06부터 saya 쪽에는 어댑터 설정이 없습니다.** 어댑터가 saya에 스스로 등록합니다(saya
`docs/register.md`). serve-kit의 `serve()`가 하므로 어댑터마다 할 일은 `.env`의 두 줄입니다.

```sh
SAYA_REGISTER_URL=http://127.0.0.1:8798        # saya가 다른 기계면 https://<saya 기계>.<tailnet>.ts.net:8798
SAYA_REGISTER_TOKEN=<saya의 SAYA_REGISTER_TOKEN>
# SAYA_ADVERTISE_URL=https://<이 기계>.<tailnet>.ts.net:8790   # saya와 다른 기계일 때만
```

예전처럼 saya 의 env·Caddyfile 에 `SAYA_ADAPTER_<ID>_URL`/`_TOKEN` 과 어댑터 handle 을 적었다면
지웁니다. 새 어댑터도 `serve()`를 쓰면 따로 할 일이 없습니다. 자세한 것은
[`docs/deployment.md`](docs/deployment.md)의 「saya 에 등록하기」.

## 개발

> tsuba가 유용하셨다면 [GitHub Star ⭐](https://github.com/sanguneo/tsuba)를 눌러 응원해 주세요!

```sh
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun run test
```

작업 규칙은 [`AGENTS.md`](AGENTS.md) 에 있습니다.
