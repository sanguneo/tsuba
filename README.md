# 鍔 tsuba

메신저 어댑터 모음입니다. 어댑터마다 메신저 계정 하나를 쥐고 로컬 프로세스로 돌며,
모두 같은 HTTP + SSE 계약(`contract/openapi.json`)으로 답합니다. 웹 클라이언트
[saya](https://github.com/sanguneo/saya) 가 그 계약을 그립니다.

칼날(어댑터)과 칼집(saya) 사이의 날밑이라 tsuba 입니다. 카카오톡은 여기 없습니다 —
데스크톱 클라이언트가 있는 기계에서 `kanao`/`kamado` 코어가 자기 계약으로 답합니다.

## 상태

계약 0.2.0의 서버와 첫 어댑터를 구현했습니다.

- `packages/serve-kit` — 인증, 기능 신고 검증, 방/메시지 라우팅, SSE 이어 읽기, 직렬 전송
- `contract/openapi.json` — `/health`, `/capabilities`, `/rooms`, `/messages`, `/stream`, `/send`
- `adapters/telegram` — mtcute 기반 사용자 계정 클라이언트. 방 목록, 이전 메시지, 커서 스트림, 텍스트 전송
- `docs/telegram.md` — 실행 방법과 구현된 기능/한계
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

## 개발

```sh
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun run test
```

작업 규칙은 [`AGENTS.md`](AGENTS.md) 에 있습니다.
