# TODO

**현재 방향: 통근 시간 기반 거주지 지도.** 방향 전환 배경은 [README](./README.md) 상단 참고. 보안 제약은 [SECURITY.md](./SECURITY.md).

작업 순서는 위에서 아래로.

---

## 0. 지금 막혀 있는 것 — 인증키 하나

**공공데이터포털 인증키 발급 + 실거래가 4종 활용신청.** 전부 자동승인이라 5분이면 된다.

1. https://www.data.go.kr 로그인
2. 아래 4개 링크로 각각 들어가 **활용신청** (활용목적 `앱개발`). ID 가 연속이다.

   | 데이터셋 | ID | 링크 |
   |---|---|---|
   | 국토교통부_단독/다가구 전월세 실거래가 자료 | 15126472 | https://www.data.go.kr/data/15126472/openapi.do |
   | 국토교통부_연립다세대 전월세 실거래가 자료 | 15126473 | https://www.data.go.kr/data/15126473/openapi.do |
   | 국토교통부_아파트 전월세 실거래가 자료 | 15126474 | https://www.data.go.kr/data/15126474/openapi.do |
   | 국토교통부_오피스텔 전월세 실거래가 자료 | 15126475 | https://www.data.go.kr/data/15126475/openapi.do |

3. **마이페이지 → 오픈API → 인증키 발급현황** → **일반 인증키(Decoding)** 복사
4. `.env` 에 `MOLIT_API_KEY=...`
5. `npm run probe:molit`

> 공공데이터포털은 **계정당 인증키 1개를 모든 API 에 공용**으로 쓴다(고용24는 API별 개별 발급이라 반대). 키 하나로 4개가 다 된다.
>
> **Decoding 키**를 넣어야 한다. Encoding 키는 `URLSearchParams` 가 다시 인코딩해 이중 인코딩이 되어 인증이 실패한다.
>
> 자동승인이지만 반영에 최대 1시간 걸릴 수 있다. `resultCode 30` = 등록되지 않은 키.

`probe:molit` 이 하는 일: 엔드포인트 URL 이 공공데이터포털 문서에 노출되지 않으므로 후보를 자동으로 훑어 동작하는 것을 찾고, **실제 응답 필드명을 덤프**한다. 주택 유형별로 필드명이 다르므로(아파트=`보증금액`/`월세금액`, 오피스텔=`보증금`/`월세`) 이 출력으로 수집기 매핑을 확정한다.

---

## 1. 실거래가 수집기

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

**쉼표 제거 후 × 10,000 을 해야 원 단위가 된다.** 틀려도 예외가 나지 않고 시세만 1만배 어긋나므로, 파서에 단위 테스트를 반드시 붙인다.

### 그 외 실측 사항

- 날짜는 `dealYear` / `dealMonth` / `dealDay` 로 분리되고 **0 패딩이 없다**(`"6"`, `"25"`)
- `contractType` / `contractTerm` / `useRRRight` / `preDeposit` / `preMonthlyRent` 는 빈 문자열인 경우가 많다
- `sh` 의 `buildYear` 도 빈 값이 있다
- **`rh` 의 `mhouseNm` 이 지번 숫자인 경우가 있다**(`mhouseNm="1213"`). 이름 검색이 무의미하므로 지번주소를 우선한다
- `apt` 의 `roadnm` 은 `"언주로30길 21"` 처럼 번호까지 포함된 완전한 도로명이다 -> `{시군구명} {roadnm}` 으로 건물 정밀도 직행
- **`apt`/`rh`/`sh` 에는 시군구명이 없다.** 주소를 조립하려면 2번(법정동코드 마스터)이 선행되어야 한다

### 좌표 해결 전략 (유형별)

1. `apt` — `{시군구명} {roadnm}` (도로명주소)
2. `offi`/`rh` — `{시군구명} {umdNm} {jibun}` (지번주소). 검증됨: `"서울특별시 서초구 반포동 2-12"` -> 건물 정밀도
3. 폴백 — `{건물명} {시군구명}` (`place-resolver` 의 `name_region`)
4. `sh` — `{시군구명} {umdNm}` 중심점, `commute_usable=false`

### 구현 메모

- 주택 유형 4종을 하나의 수집기로 처리하고 유형별 필드명 차이는 후보 키 순회로 흡수
- `NormalizedPosting` 과 같은 방식으로 `NormalizedDeal` 계약을 두고 적재 코드를 하나로 유지
- `building` 은 `jsonb_to_recordset` 배치 upsert (채용 축에서 검증된 패턴 재사용)
- `rent_deal` 은 내용 기반 유니크 키로 중복 방지 (실거래 데이터에는 고유 ID 가 없다)
- **`molit_run` 에 (유형, 지역, 계약년월) 단위로 결과를 기록한다.** 실거래는 그 달 거래가 진짜 0건일 수 있으므로 수집 실패와 구별이 필수다

### 트래픽 예산 설계 ← 중요

개발계정 **10,000회/일**, 전국 시군구 약 250개, 주택 유형 4종.

- 전량 백필: 250 × 4 × 개월수. 1년치면 12,000회 → **이틀**. 2021년 6월부터면 약 8일
- 정기 갱신: 최근 3개월만 = 250 × 4 × 3 = 3,000회/일 → 여유
- `molit_run` 으로 이미 수집한 슬롯을 건너뛰어 중복 호출을 없앤다
- `region_code.priority` 로 인구·거래량 많은 지역을 먼저 훑어, 백필 중에도 지도가 쓸 만해지게 한다

## 2. 법정동코드 마스터 적재

실거래가 API 는 시군구 단위로만 조회된다. `region_code` 테이블을 채워야 전국을 훑을 수 있다.

- 출처: 행정표준코드관리시스템 법정동코드 전체 목록 (파일 다운로드) 또는 공공데이터포털
- 앞 5자리만 distinct 로 추출 → 약 250건
- `priority` 는 인구 또는 최초 수집 시 관측된 거래량으로 설정

## 3. 건물 좌표 해결

`place-resolver` 를 그대로 쓴다. 이미 검증됨:

```
"래미안대치팰리스 서울 강남구" → 서울 강남구 삼성로51길 37
"헬리오시티 서울 송파구"       → 서울 송파구 송파대로 345
"서울특별시 서초구 반포동 2-12" → 신반포로15길 19
단지명 없음(단독다가구)        → 중심점 폴백, commute_usable=false
```

- `geocode-pending.ts` 를 `building` 테이블에도 적용하도록 확장 (현재는 `worksite` 전용)
- 거래 건수가 많은 건물을 우선 처리 (사용자가 볼 확률이 높은 순서)
- **단독다가구는 지번·건물명이 미제공일 수 있다.** 법정동 중심점만 나오면 `commute_usable=false` 로 격리하고, 지도에는 "이 동네 시세"로만 표시한다
- Kakao Local API 쿼터 10만/일. 건물 수가 많으므로 캐시 적중률이 중요하다

## 4. 라우팅 엔진

- `docker/docker-compose.yml` 로 Valhalla + OTP2 + nginx 인증 프록시 기동 (Docker Desktop 필요)
- OSM 한국 추출본 → `data/osm/`, 국토부 표준 GTFS → `data/otp/`
- 등시선 API + `isochrone_cache` 연결. `src/lib/routing.ts` 는 이미 준비됨
- 전국 주차장 표준데이터 적재 → 자차 2구간 경로(운전 + 주차장에서 도보)
- `ROUTING_TOKEN` 생성: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

> 이 프로젝트에서 유일하게 무료 티어에 안 들어가는 부분이다. 전국 OTP2 는 램 8~16GB 를 요구한다. 초기에는 개발 PC Docker + Cloudflare Tunnel, 상시 운영 시 Oracle Cloud Always Free(ARM 4코어/24GB).

## 5. 지도 (Next.js + MapLibre)

- 직장 주소 검색(Kakao Local API는 **서버 사이드 프록시** 경유) → 등시선 오버레이 → 권역 내 건물 시세
- 필터: 보증금 / 월세 / 전용면적 / 주택유형 / 이동수단 / 통근시간
- 시세는 건물 핀 + 동 단위 히트맵 두 층으로. 건물이 수만 개라 클러스터링 필수
- `commute_usable=false` 건물은 통근시간을 표시하지 않고 "시세 참고용"으로 구분해 보여준다. **정확도 낮은 좌표로 통근시간을 표시하면 지도가 조용히 거짓말을 한다**
- 사용자 좌표는 `snapToCell()` 로 격자 스냅 후에만 저장·캐시·로깅 (직장 주소도 민감정보다)
- 프론트에는 도메인 제한된 JavaScript 키만. REST 키 노출 금지
- CSP 및 보안 헤더 적용 (SECURITY.md 9장)

## 6. 매물 검색 딥링크

개별 매물은 우리가 갖지 않는다. 통근권·예산으로 지역을 좁혀준 뒤 네이버부동산·직방 검색 결과로 넘긴다. 크롤링이 0이고 부동산 리드 수익 모델과 같은 구조다.

- 각 서비스의 검색 URL 파라미터 구조 조사 필요
- 딥링크 클릭을 이벤트로 기록 (전환 측정의 기초)

## 7. 배포

- Vercel(프론트) + Supabase(DB, 구축 완료) + GitHub Actions(수집 크론, 구축 완료)
- 라우팅 엔진은 개발 PC Docker + Cloudflare Tunnel, 앞단에 Cloudflare Access
- `collect.yml` 을 실거래가 수집기로 갱신 (현재는 워크넷 기준)

---

## 나중에

- 지하철역·버스정류장 데이터 → 역세권 지표
- 통근권별 주거비 지수 (수익 모델 2번의 기초) — 12개월 시계열 필요
- 매매 실거래가 추가 → "통근 30분 내 매수 가능 가격대"
- Dependabot 의존성 PR 은 **CI 초록불 확인 후** 머지. `test:parse` 가 파싱 회귀를 잡는다
- 적재 성능이 다시 문제되면 `COPY` 기반 스테이징 테이블 검토

---

## 부록: 채용 축 실측 기록 (보류)

되돌릴 가능성이 있으므로 조사 결과를 남긴다. 코드(`company`/`worksite`/`posting` 스키마, `worknet.ts`, `ingest.ts`)는 그대로 있고 테스트도 통과 상태다.

**고용24 = 워크넷이다.** 워크넷이 고용24로 개편·통합되었고 채용정보는 동일한 한국고용정보원 데이터다.

| 소스 | 결과 |
|---|---|
| 고용24 채용정보 API | ❌ `개인회원은 사용할 수 없는 OPEN-API입니다`. 호스트 2종 × 파라미터 2종 × XML/JSON 5가지 변형 모두 동일. 활용신청은 **자동승인 되었으나** 런타임에서 기관구분 `개인` 을 차단한다. 문서에 이 제한이 명시되어 있지 않다 |
| 공공데이터포털 워크넷 (3038225) | ⚠️ 자동승인, 개인 가능. 단 **KOGL 제4유형 = 비상업적 이용만, 변형 금지** |
| 사람인 오픈API | ⚠️ 심사. `count` 최대 110, `published_min` 으로 증분 수집 가능, 일 500회. **근무지 해상도가 시군구까지** |
| 잡코리아 API | ❌ 공공기관·학교 우선 제공. 기업·개인은 내부 검토 |
| 원티드 오픈API | 미조사. 잡코리아 대안 후보 |
| 기업 채용페이지 JSON-LD | ✅ 승인 불필요, 상업적 제약 없음. 시드 구축이 과제 |

스크래핑은 선택지가 아니다. 채용공고 크롤링을 저작권법상 데이터베이스제작자 권리 침해로 인정한 판례가 있고(원고가 잡코리아), 공식 API 가 있는 곳을 크롤링할 이유도 없다.

복원 조건: JSON-LD 수집기 구축, 또는 사람인 승인, 또는 사업자등록 후 고용24 기업회원 전환.
