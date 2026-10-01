# 참고한 저장소와 가져온 것

tsuba 를 시작하기 전에(2026-10-01) 검토한 것들입니다. 외부 저장소의 날짜는 그날 확인한
마지막 커밋이고, Bun 1.4 에서 실제로 돌려 본 것은 아닙니다.

## 로컬 (같은 소유자의 저장소)

| 어디 | 가져온 것 / 가져올 것 |
| --- | --- |
| `saya/tests/fixtures/bridge.ts` | Bun.serve 위의 합성 카카오 서버. 나가는 봉투를 매번 검증기에 통과시키는 `checked`, SSE 프레임 쓰기와 `abort` 정리, 스트림 수 상한(`503 BUSY`), 401/429/503/깨진 응답을 일부러 내는 `failNext`. serve-kit 의 SSE 와 어댑터 테스트용 가짜 메신저의 원형입니다. |
| `saya/tests/harness/barriers.ts` | 그대로 `tests/harness/barriers.ts` 로 가져왔습니다. sleep 없이 신호를 먼저 등록하고 마감 시간만 둡니다. |
| `saya/scripts/contract-generate.ts`·`contract-check.ts` | 계약 → 타입·검증기 생성과 SHA-256 고정. saya 는 tsuba 의 계약을 같은 파이프라인으로 받습니다. |
| `kakaoread/kanao/serve/` 와 그 `AGENTS.md` | 의미를 옮길 대상: 전송 대기열(전송 중 포함 4건, 넘치면 `429`), 간격은 보낸 *시작*부터 재고 실제 전송된 것만 셈, 종료 시 대기 중인 요청에 `503` 으로 답함, 요청 데드라인 30초(`408`), 스트림 8개 상한, 커서는 메시지 *뒤에*, 이어 읽기를 못 하면 거절(조용히 지금부터 시작하지 않음), 한계값 검사는 백엔드를 열기 전에. `test_openapi.py` 처럼 문서와 실제 라우트를 대조하는 테스트. |
| `daou-gw-mcp/src/core/registry.ts` | 정의 하나(`defineOperation`)에서 CLI 와 MCP 표면을 함께 만드는 구조. 나중에 기능 하나를 정의하면 capabilities·라우트·계약 확인이 함께 따라오게 할 때의 본보기입니다. |

`CLIProxyAPI` 는 로컬에 실행 파일만 있어 참고하지 않았습니다.

## 외부

| 프로젝트 | 상태 | 가져올 것 | 가져오지 않을 것 |
| --- | --- | --- | --- |
| [discord.js](https://github.com/discordjs/discord.js) (TS, Apache-2.0) | 활발, 14.27.0 (2026-10-01 확인) | **Discord 어댑터의 기반.** 게이트웨이 재연결·재개, REST 요청 한도, 채널·역할 권한 계산(`permissionsFor`), Bun 공식 안내 있음 | 기본 REST 재시도(결과 모르는 쓰기를 다시 보냄) → `rest.retries: 0` |
| [mautrix-discord](https://github.com/mautrix/discord) (Go, AGPL) | 활발 | 방·메시지·반응 대응 관계의 참고 | 사람 계정 토큰으로 접속하는 퍼펫팅 — tsuba 의 Discord 는 봇 계정만 |
| [mtcute](https://github.com/mtcute/mtcute) (TS, MIT) | 활발, `@mtcute/bun` 0.32.3 (2026-09-25) | **Telegram 어댑터의 기반.** 공식 Bun 패키지(`bun:sqlite`), `getDifference`/`getChannelDifference` 로 업데이트 공백 메우기(`updates.catchUp`), 전화번호·코드·2FA·QR 로그인 | 메시지 기록 DB 는 없음 → tsuba 가 자기 정규화 저장소와 방별 재동기화를 가져야 함 |
| [mautrix-go bridgev2](https://github.com/mautrix/go) (Go, MPL-2.0) | 활발 (2026-09-30) | **기능 어휘와 한계의 모델.** 네트워크 전체 기본값과 방별 실효 기능(`event.RoomFeatures`)의 분리, `max_text_length`·`edit_max_age`·`delete_for_me`·`reaction_count`·파일 종류별 한계, 기능 집합의 해시(revision) | Matrix 이벤트 이름, 브리지 내부 운영 플래그. 코드는 옮기지 않고 설계만 빌림(MPL) |
| [Texts platform-sdk](https://github.com/TextsHQ/platform-sdk) (TS, MIT) | 2024-11 이후 멈춤 | 방·메시지·참여자 정규화 모델, `upsert`/`update`/`delete` 변경 이벤트. 그들의 `Thread` 는 *대화방* 이므로 tsuba 에서는 `Room` 이고, 진짜 스레드는 따로 둠 | 긍정·부정 플래그가 섞인 `Attribute` (없는 것의 뜻이 플래그마다 다름), Electron/React 의존 부분 |
| [matterbridge](https://github.com/42wim/matterbridge) (Go, Apache-2.0) | 2024-08 이후 멈춤 | 메신저별 메시지를 공통 봉투로 옮기는 매핑 예시 | 공유 버퍼를 비우는 `/api/stream`(커서·재생 없음), Bot API 기반 Telegram |
| [GramJS](https://github.com/gram-js/gramjs) | 보관(archived) | — | 새로 시작하는 데 쓰지 않음. 후계자 [teleproto](https://github.com/sanyok12345/teleproto) 는 Bun 검증이 안 됨 |
| [tdl](https://github.com/eilvelia/tdl) + TDLib | 활발 | 대안: TDLib 이 메시지 캐시까지 가짐 | tdl 문서가 Bun 에서의 안정성을 보장하지 않음 → 기본값으로 쓰지 않음 |

## 기능 신고 설계에 반영한 것

- **OpenRouter `GET /api/v1/models`** 의 `supported_parameters`: 지원하는 것을 *긍정으로* 나열하고 구체적 한계를 붙인다. 나열되지 않은 것으로 UI 를 켜지 않는다.
- **MCP `initialize`**: 계약(프로토콜) 버전과 구현(어댑터) 버전을 분리하고, 선택 기능은 선언된 경우에만 쓰며, 실험·확장용 이름공간을 둔다 → tsuba 는 `x-<provider>.` 접두어.
- **mautrix**: 기능 집합에 revision(내용 해시)을 붙여 바뀐 것을 알 수 있게 하고, 방마다 기능이 다를 수 있음을 처음부터 계약에 적는다.
- **OpenAI `GET /v1/models`**: 모델 목록일 뿐 기능 목록이 아니다. 이름으로 기능을 추측하지 말라는 교훈만 가져옴.
