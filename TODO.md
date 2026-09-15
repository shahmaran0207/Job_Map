# TODO

**현재 방향: 통근 시간 기반 거주지 지도.** 방향 전환 배경은 [README](./README.md) 상단 참고. 보안 제약는 [SECURITY.md](./SECURITY.md).

작업 순서는 위에서 아래로.

---

## 0. 다음에 할 것 (2026-09-15 기준)

우선순위 순. 각 항목에 필요한 작업이 무엇인지 적혀 있다.

### ① 배포 — 완료 (2026-09-15)

**https://chulmap.vercel.app** 배포 완료. `ORS_API_KEY` 등록, Fluid Compute +
Function Region(icn1) 설정까지 끝냈다. 자세한 내용은 7번 참고.
**Cloudflare Tunnel/자체 라우팅 서버는 더 이상 필요 없다** — 4번 참고
(2026-09-15, ORS + minotor 서버리스 전환).

### ② 대중교통 커버리지 확대 (필요해지면)

지금은 부산+인근 통근권(김해·양산·창원 일부)만 대중교통 모드가 실제 등시선으로
동작한다. 다른 지역이 필요해지면 4번 절차대로 GTFS를 새 bbox로 다시 필터링해
`npm run build:transit-graph` 로 재빌드. 이 GTFS는 국가교통DB(KTDB) 포털에서
수동 다운로드만 가능해 완전 자동화는 안 된다.

### ③ 유료 후보지 비교 리포트 — 나머지 조각 (보류)

"2인 교집합 통근권"(2026-09-05), 후보지 저장/불러오기(2026-09-08), 나란히 비교
화면(2026-09-12)까지 만들었다 — 여기까지가 무료로 쓸 수 있는 범위다. 나머지는
결제 붙일 준비(사업자/PG 계약 등)가 되면 다시 잡는다:

- PDF로 저장하는 일회성 결제 리포트로 패키징
- 적정가 진단(같은 동네·유형 12개월 비교군 대비 percentile) 추가
- 통근수단 포함 진짜 총비용 계산(월세 + 대중교통비/유류비) 추가
- 결제는 아직 안 붙었음 — Stripe/토스페이먼츠 등 검토 필요

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
- [x] 2인 교집합 통근권 — 커플/룸메이트용, 두 사람 통근권의 PostGIS 교집합으로 건물 필터링 (`/api/rents`, `RentMap.tsx`, `page.tsx`) — 2026-09-05
- [x] 라우팅 엔진 도보·자차 정상 가동 확인 (`npm run routing:check` ✓walk ✓drive) — 2026-09-08
- [x] Dependabot #12(minor-and-patch) 머지, #13(next@16) 머지 후 실제 동작 확인 — `tsconfig.json`(jsx: react-jsx) 자동 반영, dev 서버가 Turbopack 기본으로 전환됨, 지도 정상 — 2026-09-12
- [x] 후보지 저장/불러오기/삭제 — `localStorage` 기반, 결제 없는 v1 (`app/lib/candidates.ts`) — 2026-09-08
- [x] 후보지 나란히 비교 화면 — 체크박스로 선택, 전체화면 오버레이 테이블 (`app/page.tsx`) — 2026-09-12
- [x] 매물 검색 딥링크 — 자동 검색 URL 3사 다 실패 확인 후 "검색어 복사 + 홈 열기" 방식으로 전환, 버튼 다시 켬 (`src/lib/listing-links.ts`, `RentMap.tsx`) — 2026-09-13
- [x] 대중교통(OTP2) 라우팅 — 부산+인근 통근권 한정으로 실제 동작 확인. GTFS는 KTDB에서 확보,
      전국 그래프는 이 PC로 빌드 불가(OOM 2회)해서 bbox로 잘라 빌드. OTP2 등시선 API가
      기본 꺼진 샌드박스 기능이었던 것과 POST가 아니라 GET+쿼리스트링이어야 하는 것,
      nginx가 쿼리스트링을 안 넘기던 것까지 전부 처음 발견·수정. 출발 요일/시각을
      사용자가 직접 고르는 UI 추가(유연근무 대응) — 2026-09-14
- [x] 라우팅 엔진 전체를 서버리스로 전환 — Docker(Valhalla/OTP2/nginx) 완전 폐기, 도보·자차는
      OpenRouteService 무료 API, 대중교통은 minotor(GTFS→protobuf, RAPTOR를 Vercel 함수
      안에서 직접 실행)로 교체. "PC를 켜놔야 라우팅이 된다"는 문제와 Oracle Cloud 가입
      실패 문제를 동시에 해결. `db/007_transit_graph.sql`, `src/lib/transit.ts`,
      `src/scripts/build-transit-graph.ts` — 2026-09-15

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

## 4. 라우팅 엔진 — 서버 없음 (ORS + minotor), 대중교통은 부산권 (2026-09-15)

**결론부터: 자체 호스팅 서버가 없다.** 도보/자차는 OpenRouteService 무료 API,
대중교통은 minotor(GTFS→protobuf, RAPTOR를 Vercel 함수 안에서 직접 실행)로
동작한다. `npm run routing:check` 로 확인(프로브 좌표: 부산역):

```
✓ walk     ORS 응답 확인 (ORS_API_KEY 설정 시)
✓ drive    ORS 응답 확인 (ORS_API_KEY 설정 시)
✓ transit  폴리곤 9개 / 206점  (콜드 8.3초, 웜 상태는 즉시)
```

**왜 자체 서버(Docker/VPS)를 버렸나 — 2026-09-14→15 하루 동안의 전환**

원래 계획은 Valhalla+OTP2를 개발 PC Docker에 띄우고 Cloudflare Tunnel로 노출하는
것이었다(아래 "2026-09-04~14 기록" 참고, 그 자체는 실제로 완성해서 검증까지
끝냈다). 그런데 이건 "PC를 24시간 켜놔야 배포한 의미가 있다"는 근본 문제가
있었다 — 배포 목적 자체를 무너뜨린다는 지적을 받고 대안을 찾았다.

- **Oracle Cloud Always Free**(ARM 4코어/24GB, 영구 무료)를 먼저 시도했으나 계정
  가입이 막혔다(이메일 인증/카드 검증 트랜잭션 오류 — 흔한 증상이라고 함)
- **GCP e2-micro**(1GB, 영구 무료)도 검토했으나 가입 확실성을 100% 보장 못 함
- **Hetzner 등 유료 VPS**(월 6천~1만원)도 검토했으나 "무료가 아니면 안 된다"는
  요구와 맞지 않음
- 최종적으로 **자체 서버 자체를 없애는 방향**을 찾음: 도보/자차는
  OpenRouteService(이메일 가입만, 카드 불필요) 무료 API로, 대중교통은
  [minotor](https://github.com/aubryio/minotor)로 서버리스 함수 안에서 직접 계산

**구현됨**
- `src/lib/routing.ts` — 도보/자차는 ORS Isochrones API(`POST /v2/isochrones/{profile}`) 호출
- `src/lib/transit.ts` — minotor Router로 RAPTOR 실행. 정류장까지는 직선거리 근사,
  대중교통 구간은 시간표 기반 정확 계산. 그래프(timetable/stops 바이너리, 약 16MB)는
  **`src/data/transit-graph/`에 파일로 커밋**돼 배포 번들에 그대로 포함된다(첫 버전은
  DB(bytea)에 저장했다가 콜드스타트마다 16MB를 새로 받아오는 것 자체가 30~60초짜리
  병목이었다 — 파일로 바꾸니 콜드스타트도 2~4초로 줄었다). 모듈 스코프에 한 번 더 캐싱
- `src/scripts/build-transit-graph.ts` — GTFS → minotor 바이너리 → `src/data/transit-graph/`
  에 저장 (수동 실행, 크론 아님 — GTFS 원본이 KTDB 포털 수동 다운로드라 자동화가 안
  되고, 우리 GTFS는 서비스가 요일 무관하게 매일 동일해서(`calendar.txt`) 날짜별
  재생성이 실익이 없다). 재실행하면 결과를 git에 커밋해야 배포에 반영된다
- `app/api/rents/route.ts` 에 `maxDuration = 60` — Vercel Hobby는 Fluid Compute를
  꺼두면 10초로 강제 제한된다(코드의 `maxDuration` 은 무시됨). 프로젝트 설정에서
  Fluid Compute를 켜고 Function Region을 DB와 같은 서울(icn1)로 맞춰야 실제로 적용된다
- `src/lib/isochrone.ts`, `app/api/rents`, UI(`FilterPanel.tsx` 등)는 **거의 안 건드림** —
  `isochrone()` 의 시그니처와 캐시 키 구조가 그대로라 상위 계층은 영향 없음

**트레이드오프**
- minotor는 정류장까지 걷는 구간을 직선거리로 근사한다(예전 OTP2는 실제 도로 기준).
  나중에 ORS Matrix API로 격자↔정류장 도보시간을 미리 계산해 캐시하면 정밀도를
  높일 수 있다(2단계, 아직 안 함)
- `db/007_transit_graph.sql`(bytea 테이블)은 첫 시도의 잔재로 DB에는 남아있지만
  더 이상 코드에서 쓰지 않는다. 지우진 않았다(있어도 무해)

**남은 것**
- 다른 지역(수도권 등)이 필요해지면 GTFS를 새 bbox로 다시 필터링해
  `npm run build:transit-graph` 재실행
- 정류장 도보 접근 정밀도 개선(위 2단계)
- 전국 주차장 표준데이터 적재 → 자차 2구간 경로(운전 + 주차장에서 도보) — 아직 미착수,
  ORS로 전환하면서도 이 기능 자체는 구현된 적 없음

<details>
<summary>2026-09-04~14 기록 — Docker(Valhalla/OTP2) 시절 (폐기됨, 참고용으로 보존)</summary>

`npm run routing:up` 으로 도보·자차 기동, `npm run routing:up:transit` 으로 대중교통까지
띄우던 시절의 기록. 지금은 이 커맨드들도, `docker/` 디렉터리도 없다.

**2026-09-04에 실제로 `npm run routing:up` 을 돌리며 잡은 버그 2건**
- `valhalla` 컨테이너가 `no-new-privileges` 때문에 부팅 중 exit 1 반복 → 이미지 자체가 내부적으로 sudo를 써서 이 서비스만 완화
- nginx 프록시가 Bearer 토큰 길이 때문에 `map_hash_bucket_size` 부족으로 기동 자체를 못 함 → 128로 상향

**참고 — 첫 빌드가 한 번 깨졌었다**
2026-09-04 첫 빌드 도중 Docker Desktop이 꺼지면서 타일이 깨졌다(강남역 좌표에서도
"No suitable edges near location"). PBF는 이미 받아져 있어서 타일 캐시만 지우고
재기동하니 재다운로드 없이 재빌드되어 해결됐다.

**2026-09-14: 대중교통(OTP2) — GTFS 확보 및 부산권 구성 완료**

GTFS는 TAGO가 아니라 국가교통DB(KTDB, ktdb.go.kr)에서 받는다(회원가입 없이 일반이용자
무상 신청 가능). 전국 그래프는 이 개발 PC(RAM 15.4GB)로 빌드 시도 2회 다 OOM —
`osmium extract` + 커스텀 GTFS 스트리밍 필터로 부산+김해·양산·창원 일부만 잘라 빌드.

과정에서 처음 발견·수정한 것 3건(GTFS가 이전엔 없어서 한 번도 실제 테스트된 적이 없었음):
- OTP2의 등시선(TravelTime) API가 기본적으로 꺼진 샌드박스 기능
- OTP2 API가 POST JSON이 아니라 GET+쿼리스트링, `time` 파라미터는 ISO 오프셋 형식만 파싱
- nginx 프록시가 쿼리스트링을 넘기지 않고 있었음

대중교통은 시간표 기반이라 출발 요일/시각이 결과에 영향을 준다는 것도 이때 확인했고,
그래서 사용자가 직접 출발 시각을 고르는 UI(`FilterPanel.tsx`)와 캐시 키의 출발시각
슬롯(`db/006_transit_departure.sql`)은 서버리스 전환 이후에도 그대로 유지된다.

</details>

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

## 6. 매물 검색 딥링크 — "검색어 복사 + 홈 열기" 로 완료 (2026-09-13)

`src/lib/listing-links.ts`, `RentMap.tsx` 팝업 연결은 구현했지만, 검색어를 URL에 실어
자동 적용시키는 방식은 사람이 직접 클릭해서 두 번(2026-09-04, 2026-09-13) 확인한 결과
3사(네이버부동산·직방·다방) 다 실패였다:

| 서비스 | 결과 |
|---|---|
| 네이버부동산 | `fin.land.naver.com/search?query=` 로 새로 바꿔봤지만, 검색어와 무관하게 항상 같은 일반 지도 화면만 뜸(사람이 직접 확인) |
| 직방 | 검색해도 "결과 없음" |
| 다방 | 홈으로 리다이렉트 |

세 사이트 다 검색어 기반 딥링크 자체를 없앤 것으로 결론 내렸다. **그래서 접근을
바꿨다** — URL에 검색어를 실어 자동 검색시키는 대신, 버튼을 누르면 검색어를
클립보드에 복사하고 그 사이트 **홈**을 새 탭으로 연다. 내부 검색 API가 어떻게
바뀌든 "홈페이지가 있다"는 사실만 있으면 되므로 계속 동작한다.

- `ListingLink` 를 `{ homeUrl, query }` 형태로 변경, URL 빌더 제거
- 팝업 버튼은 `<a href>` 대신 `data-*` 속성을 쓰는 `<button>` — 클릭 리스너는
  `map.on('click', ...)` 안에서 진짜 JS로 붙인다(CSP가 인라인 `onclick=""` 을
  막아서 정적 HTML엔 못 심음)
- `SHOW_LISTING_LINKS = true` 로 켬
- Playwright(클립보드 권한 부여)로 클릭 → 클립보드 복사 → 새 탭 오픈 → 버튼
  텍스트 "복사됨 ✓" 전환까지 확인

**남은 것**
- 딥링크 클릭 이벤트 기록 (전환 측정의 기초)

---

## 7. 배포 — 완료 (2026-09-15)

**https://chulmap.vercel.app** (프로젝트 `gis19/chulmap`)

- Vercel(프론트+API) + Supabase(DB) + GitHub Actions(수집 크론)
- 라우팅(도보/자차=ORS, 대중교통=minotor)도 전부 Vercel 함수 안에서 돈다 — 4번 참고.
  별도 서버·터널이 필요 없다
- 환경변수 등록 완료: `DATABASE_URL`, `DATABASE_CA_CERT`, `KAKAO_REST_KEY`, `ORS_API_KEY`
- Function Region: **Seoul(icn1)** — DB(Supabase ap-northeast-2)와 같은 리전으로
  맞춰야 한다. 기본값(북미)으로 두면 왕복 지연이 커서 대중교통 콜드스타트가
  타임아웃 났었다
- **Fluid Compute 켜야 함** — 꺼져 있으면 Hobby 플랜 함수 실행시간이 10초로
  강제 제한되고, `route.ts`의 `maxDuration` 설정이 무시된다

**배포 중 실수 하나 — `.env` 파일이 첫 배포에 통째로 업로드될 뻔함**

`.vercelignore`를 만들면서 `.env` 제외를 빠뜨려서, DB 비밀번호가 든 로컬 `.env`가
배포 소스에 포함될 뻔했다(빌드 로그의 "Detected .env file" 메시지로 확인). 즉시
`.vercelignore`에 `.env`/`.env.*` 추가하고 문제가 된 첫 배포는 삭제, Supabase DB
비밀번호와 Kakao REST 키를 둘 다 재발급했다. `.vercelignore`를 새로 만들 때는
`.gitignore`와 내용이 겹치더라도 **명시적으로 다시 다 써야 한다** — 둘 중 하나가
있으면 다른 하나는 무시되는 것으로 보인다(둘 다 있어도 안전하게 하려면 두 파일
내용을 동기화해야 함).

**도메인**: `chulmap.com`을 Cloudflare Registrar에서 구매해뒀지만 라우팅 때문에
필요했던 건 아니었다(어차피 서버가 없어졌으므로) — Vercel 프로젝트에 커스텀
도메인으로 연결하는 것만 남았다(아직 안 함, `chulmap.vercel.app` 기본 주소로도
정상 동작)

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
- 단독/다가구 좌표 개선 — 건축물대장 조인 검토
- `middleware.ts` → `proxy.ts` 컨벤션 마이그레이션 (`npx @next/codemod@canary middleware-to-proxy .`) — next@16이 middleware를 deprecated 취급, 아직 동작은 함
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
