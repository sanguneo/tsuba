# 鍔 tsuba

메신저 어댑터 모음입니다. 어댑터마다 메신저 계정 하나를 쥐고 로컬 프로세스로 돌며,
모두 같은 HTTP + SSE 계약(`contract/openapi.json`)으로 답합니다. 웹 클라이언트
[saya](https://github.com/sanguneo/saya) 가 그 계약을 그립니다.

칼날(어댑터)과 칼집(saya) 사이의 날밑이라 tsuba 입니다. 카카오톡은 여기 없습니다 —
데스크톱 클라이언트가 있는 기계에서 `kanao`/`kamado` 코어가 자기 계약으로 답합니다.

## 상태

시작 단계입니다. 지금 있는 것:

- `packages/serve-kit` — 봉투, 베어러 인증, 라우팅, `GET /health`, `GET /capabilities`
- `contract/openapi.json` — 위 두 라우트와 기능 신고(capabilities) 어휘의 초안
- `docs/telegram.md` — 첫 어댑터(Telegram, 사용자 계정 클라이언트) 계획
- `docs/references.md` — 구현 전에 검토한 참고 저장소와 가져올 것

방 목록, 메시지 읽기, SSE 스트림, 전송은 아직 계약에 없습니다. 실제로 답하는 코드와
함께 들어옵니다.

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
