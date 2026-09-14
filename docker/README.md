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

## 대중교통 (OTP2) — 부산+인근 통근권만 구성됨 (2026-09-14)

GTFS 는 국가교통DB(KTDB, ktdb.go.kr — TAGO 가 아니다)의 "교통망 GIS DB > 대중교통 > 대중교통" 항목에서 받는다. 회원가입 없이 일반이용자도 무상 신청 가능(소속기관·목적만 기재).

**전국 그래프는 이 개발 PC(RAM 15.4GB, Docker WSL2 VM 기본 7.45GB)로 빌드 불가 — 두 번 다 OOM.** 그래서 `osmium extract` 로 OSM PBF를, 커스텀 스트리밍 필터로 GTFS(stops→stop_times→trips→routes 순으로 참조 무결성 유지하며)를 부산+김해·양산·창원 일부(bbox `128.35,34.80,129.35,35.65`)로 잘라서 빌드했다.

- 정류장 22,249개, 그래프 118MB (`data/otp/graph.obj`)
- 서빙 힙 `Xmx3g`/컨테이너 4g 로 충분 — 커버리지 밖(예: 서울)은 404 가 정상

다른 지역을 추가하려면:

1. `data/원본_대중교통GTFS_보관/202503_GTFS_DataSet/` 의 원본 GTFS txt에서 새 bbox로 다시 필터링(stops → stop_times → trips → routes → transfers 순서, 위 스크립트 방식 재사용)
2. `data/valhalla/south-korea-latest.osm.pbf` 에서 같은 bbox로 `osmium extract`
3. `data/otp/gtfs.zip`, `data/otp/korea.osm.pbf` 교체 (zip 최상위에 txt가 바로 있어야 함 — 폴더로 중첩하면 OTP가 빈 피드로 오인해 `missing required entity: Agency` 에러)
4. `data/otp/otp-config.json` 이 `{"otpFeatures":{"SandboxAPITravelTime": true}}` 인지 확인 — 등시선 API 자체가 기본은 꺼진 샌드박스 기능이라 없으면 항상 404
5. `docker-compose.yml` 의 `otp.command` 를 `['--build','--save']` 로 바꿔 한 번 실행해 그래프를 만들고(메모리 여유에 맞게 `Xmx` 조절), 끝나면 `['--load','--serve']` 로 되돌려 `npm run routing:up:transit`

OTP2 TravelTime(등시선) API 는 POST JSON 이 아니라 **GET + 쿼리스트링**만 받고, `time` 파라미터는 ISO 오프셋(`2026-09-15T08:00:00+09:00`)만 파싱된다 — `src/lib/routing.ts` 가 이 형식으로 호출한다. nginx 프록시도 `proxy_pass` 에 `$is_args$args` 를 명시해야 쿼리스트링이 전달된다(안 그러면 파라미터가 전부 null로 들어가 500).

대중교통은 시간표 기반이라 도보/자차와 달리 출발 요일/시각이 결과에 영향을 준다. 화면에서 사용자가 직접 고르고(`FilterPanel.tsx`), 등시선 캐시 키에도 30분 단위로 반올림한 슬롯이 들어간다(`db/006_transit_departure.sql`).

커버리지 밖 지역에서는 앱이 **직선거리 근사**로 동작한다(배너로 표시됨).

## 등시선 캐시

계산 결과는 `isochrone_cache` 테이블에 **영구 저장**된다. 키는 `(500m 격자, 이동수단, 분, 출발시각 슬롯)` 이다. 출발시각 슬롯은 도보/자차는 빈 문자열, 대중교통은 30분 단위로 반올림한 값(`db/006_transit_departure.sql`).

- 같은 동네의 두 번째 사용자부터는 엔진을 아예 호출하지 않는다
- **엔진이 꺼져 있어도 캐시된 지역은 계속 서비스된다**
- 격자 스냅은 개인정보 보호도 겸한다. 캐시 키에서 사용자의 직장 좌표가 복원되지 않는다

현황은 `npm run routing:check` 하단에 표시된다.

## 외부 공개 (나중에)

```bash
cloudflared tunnel --url http://127.0.0.1:8000
```

터널 앞단에 Cloudflare Access 서비스 토큰을 걸어 계층 1을 채운다. 터널 URL 만으로는 통과하지 못하게 하는 것이 목적이다.
