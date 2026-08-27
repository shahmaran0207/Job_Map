-- 주거 축 스키마.
--
-- 제품: 직장 주소를 입력하면 통근 시간 내에 있는 거주지(아파트/오피스텔/원룸)를
--       시세와 함께 지도에 보여준다.
--
-- 데이터: 국토교통부 전월세 실거래가 (공공데이터포털)
--   - 이용허락범위 제한 없음 = 상업적 이용 가능. 채용 데이터(KOGL 제4유형)와 결정적 차이
--   - 자동승인, 개발계정 10,000회/일
--   - 조회 단위: 법정동코드 5자리(시군구) + 계약년월 6자리
--   - 개인정보 보호로 동/호 정보는 제공되지 않는다 -> 건물 단위까지가 최대 해상도
--
-- 설계 원칙은 채용 축과 동일하다.
--   1) 원본 payload 를 raw jsonb 로 보존한다. 주택 유형별로 필드명이 다르고
--      (아파트=보증금액/월세금액, 오피스텔=보증금/월세) 매핑이 틀릴 수 있다.
--   2) 수집 실패와 "그 달 거래 0건" 을 구별한다. 실거래는 실제로 0건인 달이 있다.
--   3) 좌표를 어떤 전략으로 얻었는지, 통근 계산에 써도 되는지를 데이터에 명시한다.

-- ── 건물 (아파트 단지 / 오피스텔 / 연립다세대 / 단독다가구) ─────────────────
-- 실거래 레코드는 같은 건물에 대해 수없이 반복되므로 건물을 분리해 좌표를 1회만 확정한다.
CREATE TABLE IF NOT EXISTS building (
  id            bigserial PRIMARY KEY,
  -- 주택 유형. API 서비스가 유형별로 나뉘어 있다.
  housing_type  text        NOT NULL CHECK (housing_type IN ('apt','offi','rh','sh')),
  name          text,                          -- 아파트명 / 단지명. 단독다가구는 없을 수 있다
  name_norm     text,                          -- 정규화 상호 (공백/기호 제거)

  region_code   text        NOT NULL,          -- 법정동코드 앞 5자리 (시군구)
  sido          text,
  sigungu       text,
  legal_dong    text,                          -- 법정동
  jibun         text,                          -- 지번. 단독다가구는 미제공일 수 있다
  address       text,                          -- 정규화된 주소 (지오코딩 결과)
  built_year    integer,

  geom          geography(Point,4326),
  geo_strategy  text,                          -- place-resolver 의 전략
  geo_precision text        CHECK (geo_precision IN ('building','road','sigungu','sido','unknown')),
  geo_confidence real       NOT NULL DEFAULT 0,
  geo_query     text,
  -- 이 좌표로 통근시간을 계산해도 되는가. false 면 시세는 보여주되 통근시간은 표시하지 않는다.
  commute_usable boolean    NOT NULL DEFAULT false,
  geo_resolved_at timestamptz,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- 같은 유형 + 지역 + 법정동 + 지번 + 이름이면 같은 건물로 수렴시킨다.
-- 지번/이름이 없는 단독다가구도 충돌하지 않도록 coalesce 로 빈 문자열 처리한다.
CREATE UNIQUE INDEX IF NOT EXISTS building_identity_uk
  ON building (housing_type, region_code, coalesce(legal_dong,''), coalesce(jibun,''), coalesce(name_norm,''));

CREATE INDEX IF NOT EXISTS building_geom_ix    ON building USING gist (geom);
CREATE INDEX IF NOT EXISTS building_region_ix  ON building (region_code);
CREATE INDEX IF NOT EXISTS building_pending_ix ON building (id) WHERE geom IS NULL;
CREATE INDEX IF NOT EXISTS building_commute_ix ON building (commute_usable) WHERE commute_usable;

-- ── 전월세 실거래 ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rent_deal (
  id            bigserial PRIMARY KEY,
  building_id   bigint      NOT NULL REFERENCES building(id) ON DELETE CASCADE,

  deal_ym       text        NOT NULL,          -- 계약년월 'YYYYMM'
  deal_day      integer,                       -- 계약일
  -- 전세는 monthly_rent = 0 이다. 이 구분으로 전세/월세를 가른다.
  deposit       bigint      NOT NULL,          -- 보증금 (원)
  monthly_rent  bigint      NOT NULL DEFAULT 0,-- 월세 (원). 0 이면 전세
  area          numeric(10,2),                 -- 전용면적/계약면적 (㎡)
  floor         integer,
  contract_type text,                          -- 계약구분 (신규/갱신)
  contract_term text,                          -- 계약기간
  renewal_right text,                          -- 갱신요구권 사용

  -- 원본 payload. 유형별 필드명 차이와 매핑 오류에 대비해 전량 보존한다.
  raw           jsonb       NOT NULL,
  first_seen_on date        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- 실거래 데이터에는 고유 ID 가 없다. 같은 레코드를 재수집할 때 중복이 쌓이지 않도록
-- 내용 기반 유니크 키를 만든다. (같은 건물/같은 날/같은 조건/같은 금액 = 같은 거래)
CREATE UNIQUE INDEX IF NOT EXISTS rent_deal_identity_uk
  ON rent_deal (building_id, deal_ym, coalesce(deal_day,0), deposit, monthly_rent,
                coalesce(area,0), coalesce(floor,-999), coalesce(contract_type,''));

CREATE INDEX IF NOT EXISTS rent_deal_building_ix ON rent_deal (building_id);
CREATE INDEX IF NOT EXISTS rent_deal_ym_ix       ON rent_deal (deal_ym DESC);
-- 예산 필터용. 월세 매물(monthly_rent > 0)과 전세를 따로 조회한다.
CREATE INDEX IF NOT EXISTS rent_deal_monthly_ix  ON rent_deal (monthly_rent, deposit)
  WHERE monthly_rent > 0;
CREATE INDEX IF NOT EXISTS rent_deal_jeonse_ix   ON rent_deal (deposit)
  WHERE monthly_rent = 0;

-- ── 수집 실행 이력 ──────────────────────────────────────────────────────────
-- 실거래는 그 달 거래가 실제로 0건일 수 있다. 수집 실패와 진짜 0건을 반드시 구별한다.
CREATE TABLE IF NOT EXISTS molit_run (
  id           bigserial PRIMARY KEY,
  housing_type text        NOT NULL,
  region_code  text        NOT NULL,
  deal_ym      text        NOT NULL,
  run_date     date        NOT NULL,
  status       text        NOT NULL DEFAULT 'running'
                           CHECK (status IN ('running','ok','empty','failed')),
  total_count  integer     NOT NULL DEFAULT 0,  -- API 가 보고한 전체 건수
  new_count    integer     NOT NULL DEFAULT 0,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  error        text
);

-- 같은 (유형, 지역, 계약년월) 을 이미 성공적으로 수집했는지 빠르게 확인한다.
-- 10,000회/일 한도 안에서 전국을 훑으려면 중복 호출을 피하는 것이 핵심이다.
CREATE UNIQUE INDEX IF NOT EXISTS molit_run_slot_uk
  ON molit_run (housing_type, region_code, deal_ym, run_date);
CREATE INDEX IF NOT EXISTS molit_run_done_ix
  ON molit_run (housing_type, region_code, deal_ym) WHERE status IN ('ok','empty');

-- ── 법정동코드 (시군구) 마스터 ──────────────────────────────────────────────
-- 실거래가 API 는 시군구 단위로만 조회된다. 전국을 훑으려면 이 목록이 필요하다.
CREATE TABLE IF NOT EXISTS region_code (
  code       text PRIMARY KEY,                 -- 법정동코드 앞 5자리
  sido       text NOT NULL,
  sigungu    text NOT NULL,
  -- 수집 우선순위. 인구·거래량이 많은 지역을 먼저 훑는다.
  priority   integer NOT NULL DEFAULT 100,
  active     boolean NOT NULL DEFAULT true
);

-- ── 파생 뷰: 건물별 최근 시세 ───────────────────────────────────────────────
-- 지도에 뿌릴 최소 단위. 최근 12개월 거래로 대표값을 만든다.
CREATE OR REPLACE VIEW building_rent_summary AS
SELECT b.id                                            AS building_id,
       b.housing_type,
       b.name,
       b.sido,
       b.sigungu,
       b.legal_dong,
       b.geom,
       b.commute_usable,
       count(*)                                        AS deals,
       count(*) FILTER (WHERE d.monthly_rent = 0)      AS jeonse_deals,
       count(*) FILTER (WHERE d.monthly_rent > 0)      AS wolse_deals,
       -- 월세 물건의 대표값. 평균보다 중앙값이 이상치에 강하다.
       percentile_cont(0.5) WITHIN GROUP (ORDER BY d.deposit)
         FILTER (WHERE d.monthly_rent > 0)             AS median_deposit_wolse,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY d.monthly_rent)
         FILTER (WHERE d.monthly_rent > 0)             AS median_monthly_rent,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY d.deposit)
         FILTER (WHERE d.monthly_rent = 0)             AS median_deposit_jeonse,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY d.area) AS median_area,
       max(d.deal_ym)                                  AS latest_deal_ym
FROM   building b
JOIN   rent_deal d ON d.building_id = b.id
-- 최근 12개월. 오래된 거래는 시세로서 신뢰도가 떨어진다.
WHERE  d.deal_ym >= to_char(current_date - interval '12 months', 'YYYYMM')
GROUP  BY b.id, b.housing_type, b.name, b.sido, b.sigungu, b.legal_dong, b.geom, b.commute_usable;

-- ── 파생 뷰: 좌표 품질 ──────────────────────────────────────────────────────
-- 통근시간 계산 가능 비율이 곧 지도의 신뢰도다.
CREATE OR REPLACE VIEW building_quality AS
SELECT coalesce(b.geo_strategy, '(미해결)')                    AS strategy,
       b.housing_type,
       coalesce(b.geo_precision, '(없음)')                     AS precision,
       b.commute_usable,
       count(DISTINCT b.id)                                    AS buildings,
       count(d.id)                                             AS deals
FROM   building b
LEFT   JOIN rent_deal d ON d.building_id = b.id
GROUP  BY 1, 2, 3, 4
ORDER  BY 6 DESC, 5 DESC;
