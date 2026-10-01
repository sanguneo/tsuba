# 배포

어댑터는 메신저 계정 하나를 쥐는 로컬 프로세스이고, **항상 `127.0.0.1` 에만** 엽니다.
밖에서 닿는 길은 SSH 포워딩이나 TLS 를 끝내는 리버스 프록시뿐입니다.

## 어디서 돌리나

| 곳 | 언제 | 메모 |
| --- | --- | --- |
| VPS | 기본. 늘 켜져 있어 업데이트 공백이 없음 | 프록시 불필요 |
| PC | 개발, 또는 VPS 없이 쓸 때 | Telegram 이 막힌 네트워크면 `TSUBA_TELEGRAM_PROXY` |

Slack 어댑터도 VPS 에서 돕니다(2026-10-01). 회사망 PC 에서는 Slack 이 막혀 있지만 VPS 에서는 회사
워크스페이스가 IP 를 막지 않아 같은 토큰으로 됩니다. 앱 생성·설치는 Slack 에 로그인된 사내 기계
`sknah@192.168.0.8` 의 브라우저에서 했고, 그 기계의 예약 작업 `tsuba-slack` 은 꺼 두었습니다(한 앱의
Socket Mode 연결이 둘이면 Slack 이 이벤트를 나눠 보내므로 한 곳에서만 띄웁니다).

```sh
sh ~/tsuba-slack-start.sh                                  # 127.0.0.1:8793, 로그는 ~/tsuba/slack-serve.log
sudo tailscale serve --bg --https=8793 http://127.0.0.1:8793  # tailnet 전용
```

Discord 어댑터(봇)는 같은 저장소·같은 `.env` 에서 `127.0.0.1:8792` 로 따로 돕니다
(`bun adapters/discord/src/cli.ts serve`). 봇 토큰은 세션 파일과 달리 여러 곳에서 동시에
쓰면 게이트웨이 연결이 서로를 끊으므로 한 곳에서만 띄웁니다. tailnet 으로 내보낼 때는
`sudo tailscale serve --bg --https=8792 http://127.0.0.1:8792` 입니다.

**한 세션 파일을 두 곳에서 동시에 쓰지 않습니다.** 기계마다 따로 `login` 해서 각자의
세션(= Telegram 의 "기기" 하나)을 가집니다. 세션 파일은 계정 전체 권한이므로 복사해
옮기지 않고, 쓰지 않는 쪽은 Telegram 설정의 기기 목록에서 종료합니다.

## VPS (ubuntu@158.180.64.185, aarch64, Ubuntu 24.04)

VPS 의 기본 Bun(`~/.bun/bin/bun`; `~/.local/bin/bun` 은 그 링크)을 씁니다. 2026-10-01 에
1.3.14 에서 1.4.2 로 올렸습니다. 같은 Bun 을 쓰는 다른 프로젝트도 다음 재시작부터 1.4.2 입니다.

```sh
~/.bun/bin/bun upgrade
git clone git@github.com:sanguneo/tsuba.git ~/tsuba && cd ~/tsuba
~/.bun/bin/bun install --frozen-lockfile
~/.bun/bin/bun run typecheck && ~/.bun/bin/bun test
```

`~/tsuba/.env` (권한 600): `TSUBA_TELEGRAM_API_ID`, `TSUBA_TELEGRAM_API_HASH`,
`TSUBA_TOKEN`(`openssl rand -hex 32`). 프록시 줄은 두지 않습니다.

```sh
~/.bun/bin/bun adapters/telegram/src/cli.ts login   # 사람이 직접 입력
~/.bun/bin/bun adapters/telegram/src/cli.ts serve   # 127.0.0.1:8790
```

CLI 는 `umask 077` 로 돌기 때문에 `sessions/` 는 700, 세션 파일은 600 으로 만들어집니다.

서비스로 돌릴 때는 `deploy/tsuba-telegram.service` 를 씁니다(아직 등록하지 않음).

```sh
sudo cp deploy/tsuba-telegram.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now tsuba-telegram
```

## 닿는 길

| 클라이언트 | 주소 |
| --- | --- |
| VPS 에서 도는 saya (리버스 프록시) | `http://127.0.0.1:8790` |
| PC 에서 도는 saya | `http://127.0.0.1:18790` — PC 의 `proxylauncher.ps1` 이 `ssh -L 127.0.0.1:18790:127.0.0.1:8790` 을 유지 |
| tailnet 의 아무 기기 | `https://oci.tailcbc039.ts.net:8790` — VPS 의 `tailscale serve` (tailnet 전용, Funnel 아님) |
| PC 에서 직접 띄운 tsuba | `http://127.0.0.1:8790` |

Tailscale 경로는 어댑터를 loopback 에 둔 채 tailscaled 가 tailnet 에서만 HTTPS 로 받아
넘깁니다. 설정은 재부팅에도 남습니다.

```sh
sudo tailscale serve --bg --https=8790 http://127.0.0.1:8790   # 켜기
sudo tailscale serve --https=8790 off                         # 끄기
```

어느 경로든 베어러 토큰은 그대로 필요합니다. tailnet 안이라고 인증을 생략하지 않습니다.

PC 쪽 포워딩 포트를 18790 으로 둔 것은 PC 에서 tsuba 를 직접 띄울 때의 8790 과 겹치지
않게 하려는 것입니다. 토큰(`TSUBA_TOKEN`)은 어댑터를 띄운 기계의 `.env` 에 있고,
클라이언트 쪽에서는 프록시가 헤더로 넣습니다. 브라우저에는 가지 않습니다.
