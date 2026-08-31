# 라우팅 엔진

통근 등시선(N분 안에 실제로 닿는 영역)을 계산한다. 이 프로젝트에서 **유일하게 무료 티어에 들어가지 않는 부분**이라 개발 PC의 Docker 위에서 돌린다.

## 왜 인증 프록시를 두는가

**Valhalla 와 OTP2 에는 인증 기능이 전혀 없다.** 포트를 그대로 노출하면 URL 을 아는 누구나 무제한으로 경로 계산을 시킬 수 있고, 그것은 곧 이 PC 의 CPU 를 태우는 무료 연산 서비스가 된다.

그래서 엔진 포트는 호스트에 바인딩하지 않고(`127.0.0.1` 도 아니고 아예 노출하지 않음) 도커 네트워크 안에서만 접근 가능하게 두고, nginx 프록시 하나만 로컬호스트에 연다.

| 계층 | 수단 | 막는 것 |
|---|---|---|
| 1 | Cloudflare Access (외부 공개 시) | 터널 URL 만 아는 외부인 |
| 2 | nginx — Bearer 토큰 + 레이트리밋(5r/s) + 경로 allowlist + 바디 64KB | 토큰 없는 요청, 폭주, 엔진 관리 엔드포인트 |
| 3 | 엔진 포트 미노출 | 프록시 우회 |

추가로 프록시는 `read_only` / `cap_drop: ALL` / `no-new-privileges` 로 실행하고, 클라이언트의 `Authorization` 헤더는 엔진으로 전달하지 않는다.

## 실행

저장소 루트에서:

```bash
npm run routing:up      # 기동 (Valhalla = 도보·자차)
npm run routing:logs    # 진행 상황
npm run routing:check   # 진단 — 무엇이 왜 안 되는지 알려준다
npm run routing:down    # 정지
```

`ROUTING_TOKEN` 은 이미 `.env` 에 생성되어 있다. compose 가 `--env-file .env` 로 같은 값을 읽으므로 두 곳을 맞출 필요가 없다. 토큰을 바꾸면 `routing:down` 후 다시 `up` 해야 반영된다.

### 첫 기동은 오래 걸린다

Valhalla 가 한국 OSM 추출본(약 300MB)을 내려받고 타일을 빌드한다. 사양에 따라 **15~40분**. 그동안 앱은 죽지 않고 **직선거리로 폴백**하며, 화면에 "직선거리 근사로 표시 중" 배너가 뜬다.

진행 상황은 `npm run routing:logs` 로 본다. `tile_dir` 관련 로그가 멈추고 `Running tile service` 가 보이면 완료다.

빌드된 타일은 `data/valhalla/` 에 남으므로 다음 기동부터는 즉시 뜬다. 이 디렉터리는 gitignore 된다(수 GB, 재생성 가능).

## 대중교통 (OTP2) — 미구성

**GTFS 확보가 선행되어야 한다.** 국토부 표준 GTFS 는 국가대중교통정보센터(TAGO) 등록이 필요해 즉시 받을 수 없다. 그래서 기본 기동에서 제외했고, `transit` 프로필로 분리해 두었다.

준비되면:

1. `data/otp/` 에 GTFS(zip) 와 한국 OSM PBF 를 넣는다
2. `docker-compose.yml` 의 `otp.command` 를 `['--build','--save']` 로 바꿔 한 번 실행해 그래프를 만든다
3. `['--load','--serve']` 로 되돌리고 `npm run routing:up:transit`

OTP2 는 전국 그래프에 램 8~16GB 를 요구한다. 개발 PC 사양을 먼저 확인할 것.

그 전까지 앱에서 **대중교통 모드는 직선거리 근사**로 동작한다(배너로 표시됨).

## 등시선 캐시

계산 결과는 `isochrone_cache` 테이블에 **영구 저장**된다. 키는 `(500m 격자, 이동수단, 분)` 이다.

- 같은 동네의 두 번째 사용자부터는 엔진을 아예 호출하지 않는다
- **엔진이 꺼져 있어도 캐시된 지역은 계속 서비스된다**
- 격자 스냅은 개인정보 보호도 겸한다. 캐시 키에서 사용자의 직장 좌표가 복원되지 않는다

현황은 `npm run routing:check` 하단에 표시된다.

## 외부 공개 (나중에)

```bash
cloudflared tunnel --url http://127.0.0.1:8000
```

터널 앞단에 Cloudflare Access 서비스 토큰을 걸어 계층 1을 채운다. 터널 URL 만으로는 통과하지 못하게 하는 것이 목적이다.
