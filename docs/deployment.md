# 배포

어댑터는 메신저 계정 하나를 쥐는 로컬 프로세스이고, **항상 `127.0.0.1` 에만** 엽니다.
밖에서 닿는 길은 SSH 포워딩이나 TLS 를 끝내는 리버스 프록시뿐입니다.

## 어디서 돌리나

| 곳 | 언제 | 메모 |
| --- | --- | --- |
| VPS | 기본. 늘 켜져 있어 업데이트 공백이 없음 | 프록시 불필요 |
| PC | 개발, 또는 VPS 없이 쓸 때 | Telegram 이 막힌 네트워크면 `TSUBA_TELEGRAM_PROXY` |

**한 세션 파일을 두 곳에서 동시에 쓰지 않습니다.** 기계마다 따로 `login` 해서 각자의
세션(= Telegram 의 "기기" 하나)을 가집니다. 세션 파일은 계정 전체 권한이므로 복사해
옮기지 않고, 쓰지 않는 쪽은 Telegram 설정의 기기 목록에서 종료합니다.

## VPS (ubuntu@158.180.64.185, aarch64, Ubuntu 24.04)

Bun 1.4.2 는 `~/.bun-tsuba` 에 따로 둡니다. 같은 VPS 의 다른 프로젝트가 쓰는 `~/.bun`
(1.3.x)과 셸 설정은 건드리지 않습니다.

```sh
# Bun 1.4.2 (설치 스크립트는 셸 설정을 고치므로 릴리스 zip 을 직접 풂)
mkdir -p ~/.bun-tsuba/bin && cd /tmp
curl -fsSLO https://github.com/oven-sh/bun/releases/download/bun-v1.4.2/bun-linux-aarch64.zip
unzip -o bun-linux-aarch64.zip && mv bun-linux-aarch64/bun ~/.bun-tsuba/bin/bun

git clone git@github.com:sanguneo/tsuba.git ~/tsuba && cd ~/tsuba
~/.bun-tsuba/bin/bun install --frozen-lockfile
~/.bun-tsuba/bin/bun run typecheck && ~/.bun-tsuba/bin/bun test
```

`~/tsuba/.env` (권한 600): `TSUBA_TELEGRAM_API_ID`, `TSUBA_TELEGRAM_API_HASH`,
`TSUBA_TOKEN`(`openssl rand -hex 32`). 프록시 줄은 두지 않습니다.

```sh
~/.bun-tsuba/bin/bun adapters/telegram/src/cli.ts login   # 사람이 직접 입력
~/.bun-tsuba/bin/bun adapters/telegram/src/cli.ts serve   # 127.0.0.1:8790
```

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
| PC 에서 직접 띄운 tsuba | `http://127.0.0.1:8790` |

PC 쪽 포워딩 포트를 18790 으로 둔 것은 PC 에서 tsuba 를 직접 띄울 때의 8790 과 겹치지
않게 하려는 것입니다. 토큰(`TSUBA_TOKEN`)은 어댑터를 띄운 기계의 `.env` 에 있고,
클라이언트 쪽에서는 프록시가 헤더로 넣습니다. 브라우저에는 가지 않습니다.
