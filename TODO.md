# TODO

**현재 방향: 통근 시간 기반 거주지 지도.** 방향 전환 배경은 [README](./README.md) 상단 참고. 보안 제약는 [SECURITY.md](./SECURITY.md).

작업 순서는 위에서 아래로.

---

## 0. 다음에 할 것 (2026-09-05 기준)

우선순위 순. 각 항목에 필요한 작업이 무엇인지 적혀 있다.

### ① 라우팅 엔진 기동 재개 ← 지금 당장

**엔진 코드/Docker 설정 버그는 다 고쳤다. 다시 띄우기만 하면 된다.**

2026-09-04에 처음 `npm run routing:up` 을 돌리면서 실제 버그 2개를 잡았다 (아래 4번 참고: `no-new-privileges` 때문에 valhalla가 부팅 중 죽던 것, nginx `map_hash_bucket_size` 부족). 고친 뒤 OSM 추출본(273MB) 다운로드까지 끝내고 admin DB → timezone DB → 타일 빌드로 들어갔는데, **그 도중에 Docker Desktop이 꺼져서 빌드가 중간에 끊겼다.** 타일 빌드가 어디까지 됐는지(재개되는지 처음부터 다시인지)는 확인 못 한 상태.

```bash
# 1. Docker Desktop 실행
# 2. 엔진 기동
npm run routing:up
npm run routing:logs     # 진행 상황 — admin db / timezone db / tile build 순서로 로그가 찍힌다
npm run routing:check    # 진단 — 무엇이 왜 안 되는지 알려준다
```

빌드가 끝나면 지도가 자동으로 등시선으로 전환된다. 그전까지는 직선거리 근사로 동작하며 화면에 배너가 뜬다. **이번엔 Docker Desktop을 빌드 끝날 때까지 끄지 말 것.**

현재 데이터 상태 (2026-08-30 기준, 그 이후 재수집 안 했으면 그대로):

```
건물 73,062 (좌표 100%)   거래 396,262   시군구 256/269   기간 202606~202608
통근 계산 가능: 건물 94.6% / 거래 75.5%
남은 24.5%는 전부 단독·다가구 (정부가 지번을 공개하지 않는 구조적 한계)
지도: npm start → http://127.0.0.1:3000
```

시작 전 `npm run stats:rent` 로 현재 수치를 확인할 것.

### ② 매물 검색 딥링크 URL 재조사

네이버부동산·직방·다방 3곳 다 URL이 깨져서 버튼을 꺼둔 상태다. 자세한 내용은 6번 참고.

### ③ 배포 준비

Cloudflare Tunnel, Vercel 배포. 자세한 내용은 7번 참고.

---

## 완료 항목

- [x] 실거래가 수집기 (`src/collectors/molit-rent.ts`) — 2026-08-28
- [x] 법정동코드 마스터 적재 (`npm run seed:regions`) — 2026-08-26
- [x] 건물 좌표 해결 배치 (`npm run geocode:buildings`) — 2026-08-28
- [x] 전국 데이터 수집 (건물 73,062 / 거래 396,262 / 시군구 256) — 2026-08-29
- [x] 도 이름 축약형 버그 수정 (충남·충북·경남·경북 4개 도) — 2026-08-29
- [x] 지오코딩 캐시 오염 버그 수정 + 병렬 배치 — 2026-08-29
- [x] 지도 UI 1단계 (직선 반경, MapLibre + Next.js) — 2026-08-29
- [x] 라우팅 엔진 코드 완료 (등시선 + 우아한 폴백) — 2026-08-30
- [x] Docker 구성 (Valhalla + nginx 인증 프록시) — 2026-08-30
- [x] CI 보안 검사 실패 2건 수정 (CodeQL 중복 init, postcss overrides) — 2026-08-30
- [x] collect.yml — 실거래가 수집 크론으로 교체 — 2026-09-02
- [x] 딥링크 UI 배선 완료했으나 URL 3개 다 깨진 것 확인 → 버튼 비활성화 (`SHOW_LISTING_LINKS`) — 2026-09-04
- [x] 지도 렌더링 버그 3건 수정 (CSP nonce, MapLibre 워커 URL, oklch 색상) — 2026-09-04
- [x] 건축년도 필터 (`FilterPanel.tsx` 슬라이더 + `/api/rents` 쿼리) — 2026-09-04
- [x] npm audit CI가 레지스트리 일시 장애로 12분씩 실패하던 것 수정 (재시도+타임아웃) — 2026-09-04
- [x] Docker 라우팅 스택 최초 기동 실패 2건 수정 (valhalla no-new-privileges, nginx map_hash_bucket_size) — 2026-09-04
- [x] 로딩 UX 전면 개편 — 화면 전체 반투명 오버레이 + 점 12개짜리 링 스피너(입체감·꼬리 방향까지 다듬음), 로컬 라우팅 엔진 미기동 시 타임아웃 40초→2초로 단축 — 2026-09-04
- [x] 전체 UI 다크(사이버펑크/관제센터) 테마로 리디자인 — 배경·사이드바·필터·지도 타일(OpenFreeMap dark)·팝업까지, disabled 상태는 grayscale로 구분되게 — 2026-09-05
- [x] 모바일 레이아웃 수정 — 사이드바가 `max-h-[45vh]`로 묶여 지도가 화면 밖으로 밀려나지 않음 — 2026-09-05

---

## 1. 실거래가 수집기 — 완료 (2026-08-28)

`src/collectors/molit-rent.ts`.

### 확정된 API 스펙 (2026-08-26 실측)

호스트 `apis.data.go.kr`, 공통 파라미터 `serviceKey` / `LAWD_CD`(시군구 5자리) / `DEAL_YMD`(YYYYMM) / `numOfRows` / `pageNo`.

| 유형 | 경로 |
|---|---|
| `apt` | `/1613000/RTMSDataSvcAptRent/getRTMSDataSvcAptRent` |
| `offi` | `/1613000/RTMSDataSvcOffiRent/getRTMSDataSvcOffiRent` |
| `rh` | `/1613000/RTMSDataSvcRHRent/getRTMSDataSvcRHRent` |
| `sh` | `/1613000/RTMSDataSvcSHRent/getRTMSDataSvcSHRent` |

**응답 필드는 문서의 한국어 명칭이 아니라 영문 camelCase 다.** 실측 결과:

| 의미 | apt | offi | rh | sh |
|---|---|---|---|---|
| 건물명 | `aptNm` | `offiNm` | `mhouseNm` | **없음** |
| 안정 ID | `aptSeq` | — | — | — |
| 지번 | `jibun` | `jibun` | `jibun` | **없음** |
| 법정동 | `umdNm` | `umdNm` | `umdNm` | `umdNm` |
| 도로명 | `roadnm` 외 6개 | — | — | — |
| 시군구코드 | `sggCd` | `sggCd` | `sggCd` | `sggCd` |
| 시군구명 | **없음** | `sggNm` | **없음** | **없음** |
| 보증금 | `deposit` | `deposit` | `deposit` | `deposit` |
| 월세 | `monthlyRent` | `monthlyRent` | `monthlyRent` | `monthlyRent` |
| 면적 | `excluUseAr` | `excluUseAr` | `excluUseAr` | `totalFloorAr` |
| 층 | `floor` | `floor` | `floor` | **없음** |
| 건축년도 | `buildYear` | `buildYear` | `buildYear` | `buildYear` |
| 주택유형 | — | — | `houseType` | `houseType` |
| 계약 | `contractType` / `contractTerm` / `useRRRight` / `preDeposit` / `preMonthlyRent` (4종 공통) |

### ⚠️ 금액 단위 — 만원, 쉼표 포함 문자열

```
deposit="70,000"  monthlyRent="230"   -> 보증금 7억, 월세 230만원
deposit="1,000"   monthlyRent="67"    -> 보증금 1,000만원, 월세 67만원
```

**쉼표 제거 후 × 10,000 을 해야 원 단위가 된다.** `npm run test:molit` 이 45개 항목으로 이를 고정한다.

### 알려진 한계 — 거래 중복 제거

실거래 레코드에는 고유 ID 가 없고 동/호 정보도 제공되지 않는다. (건물, 계약일, 보증금, 월세, 면적, 층, 계약구분)이 모두 같은 두 계약은 원리적으로 구별할 수 없다. 실측에서 1.5%가 합쳐졌고, 시세 중앙값에는 영향이 거의 없다.

### 트래픽 예산 설계

개발계정 **10,000회/일**, 전국 시군구 약 269개, 주택 유형 4종.

- 정기 갱신: 최근 3개월만 = 269 × 4 × 3 = 3,228회/일 → 여유
- `molit_run` 으로 이미 수집한 슬롯을 건너뛰어 중복 호출을 없앤다

---

## 2. 법정동코드 마스터 적재 — 완료 (2026-08-26)

`npm run seed:regions`. **전국 시군구 269건** 적재 완료.

주의할 점:
- 파라미터명이 `ServiceKey`(대문자 S) — 실거래가 API 의 `serviceKey` 와 다르다
- 페이징 필수 — 1페이지만 읽으면 경북 등 뒤쪽 시군구가 누락된다 (169건 → 269건)
- 광주·전남이 `전남광주통합특별시`로 통합됨 — `SIDO_ALIAS_GROUPS` 로 별칭 처리

---

## 3. 건물 좌표 해결 — 완료 (2026-08-28)

`npm run geocode:buildings`.

**전국 결과 (2026-08-29)**

```
통근 계산 가능: 건물 94.6% / 거래 75.5%
남은 24.5%는 전부 단독·다가구 (정부가 지번 미공개)
```

### 남은 작업

- **단독/다가구 개선** — 건축물대장(공공데이터포털) 조인으로 법정동 내 단독주택 위치 보강 가능한지 검토. 거래 기준 16%가 여기서 빠진다
- `region_code.priority` 를 관측 거래량으로 갱신해 수집·지오코딩 우선순위 자동 조정

---

## 4. 라우팅 엔진 — 코드 완료, 엔진 기동 재개 대기 (2026-09-04)

앱 쪽은 전부 붙었다. `npm run routing:up` 으로 엔진만 띄우면 등시선으로 전환된다.

**구현됨**
- `src/lib/isochrone.ts` — 캐시(`isochrone_cache`) + 실패 처리. 500m 격자 키로 영구 저장
- `app/api/rents` — `ST_Intersects`(등시선 폴리곤) 공간 쿼리
- UI — 이동수단(도보/대중교통/자차) + 통근 시간 필터
- `docker/` — Valhalla + nginx 인증 프록시
- 우아한 폴백 — 엔진 미가동 시 직선 반경으로 물러서되 화면에 경고 배너 + 점선 경계 표시
- 로컬 엔진(127.0.0.1)이 죽어 있을 때의 폴백 타임아웃을 40초 → 2초로 단축 (`src/lib/routing.ts`) — 실제 배포(원격 엔진)는 40초 그대로

**2026-09-04에 실제로 `npm run routing:up` 을 돌리며 잡은 버그 2건**
- `valhalla` 컨테이너가 `no-new-privileges` 때문에 부팅 중 exit 1 반복 → 이미지 자체가 내부적으로 sudo를 써서 이 서비스만 완화 (`docker/docker-compose.yml`)
- nginx 프록시가 Bearer 토큰 길이 때문에 `map_hash_bucket_size` 부족으로 기동 자체를 못 함 → 128로 상향 (`docker/nginx/routing.conf.template`)

**남은 것**
- 위 두 버그를 고친 뒤 OSM 추출본(273MB) 다운로드까지 끝내고 타일 빌드에 들어갔는데, **빌드 도중 Docker Desktop이 꺼져서 중단됨.** Docker Desktop 켜고 `npm run routing:up` 다시 돌려서 재개(또는 재시작) 확인 필요 — 0번 ① 참고
- **대중교통(OTP2)은 GTFS 확보가 선행되어야 한다.** 국토부 표준 GTFS 는 국가대중교통정보센터(TAGO) 등록 필요. 그 전까지 대중교통 모드는 직선거리 근사
- 전국 주차장 표준데이터 적재 → 자차 2구간 경로(운전 + 주차장에서 도보)
- 상세는 [docker/README.md](./docker/README.md)

---

## 5. 지도 — 1단계 완료, 다크 테마 적용 (2026-09-05)

`npm start` → http://127.0.0.1:3000

**구성**
- Next.js 15 App Router + React 19 + Tailwind v4
- MapLibre GL (WebGL). 배경 타일은 **OpenFreeMap dark** 스타일 (사이버펑크/관제센터 톤으로 전체 UI를 다크 테마로 리디자인하면서 라이트 타일에서 교체)
- `app/api/geocode` — Kakao Local API 서버 프록시
- `app/api/rents` — PostGIS 공간 쿼리 + 최근 12개월 중앙값 집계
- 로딩 중에는 화면 전체를 덮는 오버레이 + 점 링 스피너가 뜬다 (서버 왕복이 있어 버튼만 disabled 로는 "멈췄다"로 오해하기 쉬웠음)
- 모바일에서는 사이드바가 `max-h-[45vh]`로 묶여 지도가 화면 밖으로 밀려나지 않는다

### ⚠️ TypeScript 7 비호환 (해결됨)

`typescript@^5.9` 로 고정. `ci.yml` 에 `npm run build` 추가해 재발 방지. Next 15 가 TS 7 을 지원하면 다시 올린다.

### 남은 작업

- 전국 데이터 밀집 지역 클러스터링 검토 (현재 결과 상한 3,000건으로 제어)
- 동 단위 히트맵 레이어 (건물 핀과 두 층으로)

---

## 6. 매물 검색 딥링크 — 버튼 꺼둠, URL 재조사 필요 (2026-09-04)

`src/lib/listing-links.ts`, `RentMap.tsx` 팝업 연결 자체는 구현 완료했지만, **`npm run check:deeplinks` 로 나온 URL 3개를 실제 브라우저(Playwright)로 열어서 확인해보니 셋 다 깨져 있었다.**

| 서비스 | 시도한 URL | 결과 |
|---|---|---|
| 네이버부동산 | `m.land.naver.com/search/result/{검색어}` | 건물명이든 흔한 동명("강남구 개포동")이든 전부 "검색결과가 없습니다". 이 구주소 방식 자체가 죽은 것으로 보임 — 지금은 `fin.land.naver.com` SPA 지도앱으로 이전됨 |
| 직방 | `zigbang.com/search?q=` | 그 경로 자체가 없음, 404 |
| 다방 | `dabangapp.com/search?search=` | 파라미터를 안 읽고 홈으로 리다이렉트 |

세 사이트 다 검색어 기반 딥링크에서 자체 지도앱/자동완성 흐름으로 바뀐 것으로 보인다. `RentMap.tsx`에 `SHOW_LISTING_LINKS = false` 플래그로 버튼을 꺼뒀다 — 깨진 링크를 사용자에게 보여주는 것보다 안 보여주는 게 낫다.

**남은 것**
- 사이트별로 실제 검색 흐름을 다시 조사해서 URL 빌더 교체 (비공식 API라 시간이 걸리고, 또 바뀔 수 있음)
- 또는 "검색어만 클립보드에 복사" 방식으로 축소하는 것도 검토 (구현 간단, 항상 동작)
- 고치면 `RentMap.tsx` 의 `SHOW_LISTING_LINKS` 를 `true` 로
- 딥링크 클릭 이벤트 기록 (전환 측정의 기초) — URL 고친 뒤에

---

## 7. 배포

- Vercel(프론트) + Supabase(DB, 구축 완료) + GitHub Actions(수집 크론)
- 라우팅 엔진은 개발 PC Docker + Cloudflare Tunnel, 앞단에 Cloudflare Access

**남은 것**
- Cloudflare Tunnel 설정 (`cloudflared` 설치 → tunnel 생성 → docker-compose에 서비스 추가)
- Vercel 배포 (`DATABASE_URL`, `KAKAO_REST_KEY`, `ROUTING_TOKEN` 환경변수 등록)

---

## 8. Dependabot PR 검토 규칙 ← 두 번 데였다

**워크플로 파일(`.github/workflows/*.yml`) 변경 PR 은 반드시 diff 를 눈으로 보고 머지한다.**

| PR 종류 | 처리 |
|---|---|
| 코드 의존성 | CI 초록불 확인 후 머지. `test:parse` / `test:molit` / `npm run build` 가 게이트 |
| **워크플로 파일** | **CI 로 잡히지 않는다.** diff 를 직접 확인하고 머지 |
| 메이저 업그레이드 | 로컬에서 `npm run build` + 테스트 3종 확인 후 머지 |
| 전이 의존성 취약점 | 메이저 업그레이드보다 `overrides` 를 먼저 검토 |

**데인 사례**
- CodeQL v3/v4 스텝 중복 → `Loaded a configuration file for version '3.37.9', but running version '4.37.9'`
- next 내부 postcss `8.4.31` 고정 → `overrides`로 `^8.5.26` 강제해 해결

---

## 나중에

- 지하철역·버스정류장 데이터 → 역세권 지표
- 통근권별 주거비 지수 (수익 모델 2번의 기초) — 12개월 시계열 필요
- 매매 실거래가 추가 → "통근 30분 내 매수 가능 가격대"
- `next@16` 업그레이드 검토 (현재 postcss overrides 로 막아둔 상태)
- 단독/다가구 좌표 개선 — 건축물대장 조인 검토
- `qs`(6.15.3) moderate 취약점 — `shadcn` MCP 도구가 쓰는 개발용 전이 의존성. 상위 패치 아직 없음, 프로덕션 런타임엔 안 들어감. 패치 나오면 `npm audit fix`

---

## 부록: 채용 축 실측 기록 (보류)

코드(`company`/`worksite`/`posting` 스키마, `worknet.ts`, `ingest.ts`)는 그대로 있고 테스트도 통과 상태다.

| 소스 | 결과 |
|---|---|
| 고용24 채용정보 API | ❌ 개인회원 런타임 차단 |
| 공공데이터포털 워크넷 | ⚠️ KOGL 제4유형 = 비상업적 이용만 |
| 사람인 오픈API | ⚠️ 심사 중. 근무지 해상도 시군구까지 |
| 잡코리아 API | ❌ 공공기관·학교 우선 |
| 기업 채용페이지 JSON-LD | ✅ 승인 불필요. 시드 구축 필요 |

복원 조건: JSON-LD 수집기 구축, 또는 사람인 승인, 또는 사업자등록 후 고용24 기업회원 전환.
