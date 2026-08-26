-- Job_Map 초기 스키마
-- 설계 원칙
--  1) 공고는 마감되면 원본이 사라진다 => 관측한 원본 payload 를 raw jsonb 로 영구 보존한다.
--  2) 시계열은 "일별 행" 이 아니라 "구간(first_seen_on ~ last_seen_on)" 으로 저장한다.
--     일별 행은 5만 공고 x 365일 = 1800만 행이 되어 무료 티어를 넘긴다.
--     일별 활성 공고 수는 구간 겹침 쿼리로 손실 없이 복원된다 (일 1회 이상 수집 가정).
--  3) 수집이 조용히 실패하면 시계열에 가짜 하락이 생겨 데이터 상품 전체가 오염된다.
--     따라서 collect_run 으로 매 실행을 기록하고, 결측일과 진짜 0 을 구별한다.

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ── 회사 ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS company (
  id            bigserial PRIMARY KEY,
  name          text        NOT NULL,
  name_norm     text        NOT NULL,          -- 상호 정규화 (주)/(유)/공백 제거, 국민연금 조인 키
  biz_no        text,                          -- 사업자등록번호 (알 수 있으면)
  corp_no       text,                          -- 법인등록번호
  employee_cnt  integer,                       -- 국민연금 가입자 수로 보강
  industry_code text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS company_name_norm_uk ON company (name_norm);
CREATE INDEX IF NOT EXISTS company_name_trgm_ix ON company USING gin (name gin_trgm_ops);

-- ── 근무지 (본사/지사/공장 각각 한 행) ──────────────────────────────────────
-- 프로젝트의 핵심 자산. 공고에 적힌 주소는 본사이거나 "서울 강남구" 수준이거나 아예 없다.
-- 그래서 raw_address 와 확정 좌표를 분리하고, 어떤 경로로 확정했는지 provenance 를 남긴다.
CREATE TABLE IF NOT EXISTS worksite (
  id            bigserial PRIMARY KEY,
  company_id    bigint      NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  label         text,                          -- '본사', '부산지사', '평택캠퍼스'
  site_type     text        NOT NULL DEFAULT 'unknown'
                            CHECK (site_type IN ('hq','branch','factory','store','site','unknown')),
  raw_address   text,                          -- 공고에 적혀 있던 원문 그대로
  address       text,                          -- 정규화된 도로명주소
  region_code   text,                          -- 법정동코드 10자리 (집계/조인용)
  sido          text,
  sigungu       text,
  geom          geography(Point,4326),
  -- 좌표를 어떻게 얻었는가. 데이터 신뢰도의 근거이며 B2B 판매 시 반드시 요구된다.
  geo_source    text        CHECK (geo_source IN
                            ('kakao_address','kakao_keyword','jsonld','nps_join','manual','user_report')),
  geo_confidence real       NOT NULL DEFAULT 0,   -- 0.0 ~ 1.0
  geo_precision  text       CHECK (geo_precision IN ('building','road','sigungu','sido','unknown')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS worksite_geom_ix    ON worksite USING gist (geom);
CREATE INDEX IF NOT EXISTS worksite_company_ix ON worksite (company_id);
CREATE INDEX IF NOT EXISTS worksite_region_ix  ON worksite (region_code);
-- 같은 회사 + 같은 주소원문은 한 근무지로 수렴시킨다
CREATE UNIQUE INDEX IF NOT EXISTS worksite_company_addr_uk
  ON worksite (company_id, coalesce(raw_address, ''));

-- ── 공고 ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS posting (
  id              bigserial PRIMARY KEY,
  source          text        NOT NULL,          -- 'worknet' | 'jsonld' | ...
  source_id       text        NOT NULL,          -- 원본 사이트의 공고 고유번호
  url             text,
  title           text        NOT NULL,
  company_id      bigint      REFERENCES company(id)  ON DELETE SET NULL,
  worksite_id     bigint      REFERENCES worksite(id) ON DELETE SET NULL,

  -- 필터 조건
  job_category    text,                          -- 원본 직종명
  job_code        text,                          -- 원본 직종코드
  employment_type text,                          -- 정규직/계약직/인턴 ...
  career_type     text,                          -- 신입/경력/무관
  career_min_year integer,
  education       text,                          -- 학력
  salary_type     text,                          -- 연봉/월급/시급/면접후결정
  salary_min      integer,                       -- 원 단위
  salary_max      integer,
  work_hours      text,

  posted_on       date,
  closes_on       date,

  -- 시계열 구간. 이 두 컬럼이 알터너티브 데이터 상품의 뼈대다.
  first_seen_on   date        NOT NULL,
  last_seen_on    date        NOT NULL,
  is_open         boolean     NOT NULL DEFAULT true,

  raw             jsonb       NOT NULL,          -- 원본 payload 전량 보존
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS posting_source_uk    ON posting (source, source_id);
CREATE INDEX IF NOT EXISTS posting_open_ix             ON posting (is_open) WHERE is_open;
CREATE INDEX IF NOT EXISTS posting_worksite_ix         ON posting (worksite_id);
CREATE INDEX IF NOT EXISTS posting_seen_ix             ON posting (first_seen_on, last_seen_on);
CREATE INDEX IF NOT EXISTS posting_company_ix          ON posting (company_id);
CREATE INDEX IF NOT EXISTS posting_salary_ix           ON posting (salary_min);

-- 공고 내용이 바뀐 순간만 기록 (연봉 인상, 마감 연장 등). 매일 전량을 쌓지 않는다.
CREATE TABLE IF NOT EXISTS posting_change (
  id          bigserial PRIMARY KEY,
  posting_id  bigint      NOT NULL REFERENCES posting(id) ON DELETE CASCADE,
  observed_on date        NOT NULL,
  field       text        NOT NULL,
  old_value   text,
  new_value   text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS posting_change_posting_ix ON posting_change (posting_id, observed_on);

-- ── 수집 실행 이력 (데이터 무결성의 근거) ───────────────────────────────────
-- "그날 공고가 0건이었다" 와 "그날 수집기가 깨졌다" 를 구별하기 위해 반드시 필요하다.
CREATE TABLE IF NOT EXISTS collect_run (
  id           bigserial PRIMARY KEY,
  source       text        NOT NULL,
  run_date     date        NOT NULL,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  status       text        NOT NULL DEFAULT 'running'
                           CHECK (status IN ('running','ok','partial','failed')),
  pages_read   integer     NOT NULL DEFAULT 0,
  seen_count   integer     NOT NULL DEFAULT 0,   -- 이번 실행에서 관측한 공고 수
  new_count    integer     NOT NULL DEFAULT 0,
  closed_count integer     NOT NULL DEFAULT 0,
  error        text
);
CREATE INDEX IF NOT EXISTS collect_run_src_date_ix ON collect_run (source, run_date DESC);

-- ── 지오코딩 캐시 (Kakao 콜 절약 + 재현성) ──────────────────────────────────
CREATE TABLE IF NOT EXISTS geocode_cache (
  query       text        PRIMARY KEY,
  geom        geography(Point,4326),
  address     text,
  region_code text,
  sido        text,
  sigungu     text,
  precision   text,
  provider    text        NOT NULL,
  hit_count   integer     NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ── 주차장 (자차 모드: 목적지 근처 주차장까지 운전 + 도보) ──────────────────
CREATE TABLE IF NOT EXISTS parking_lot (
  id           bigserial PRIMARY KEY,
  source_id    text        NOT NULL,
  name         text,
  address      text,
  geom         geography(Point,4326) NOT NULL,
  lot_type     text,                          -- 노외/노상/부설
  capacity     integer,
  fee_type     text,                          -- 유료/무료
  base_fee     integer,
  base_minutes integer,
  operating    text,
  raw          jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS parking_source_uk ON parking_lot (source_id);
CREATE INDEX IF NOT EXISTS parking_geom_ix ON parking_lot USING gist (geom);

-- ── 등시선 캐시 ─────────────────────────────────────────────────────────────
-- 출발지를 격자에 스냅해 (격자, 모드, 분) 단위로 폴리곤을 영구 저장한다.
-- 같은 동네의 두 번째 사용자부터 라우팅 엔진을 호출하지 않는다.
CREATE TABLE IF NOT EXISTS isochrone_cache (
  cell_key   text        NOT NULL,            -- 스냅된 격자 키 (예: 'g500:126.9784:37.5665')
  mode       text        NOT NULL CHECK (mode IN ('walk','transit','drive')),
  minutes    integer     NOT NULL,
  geom       geography(MultiPolygon,4326) NOT NULL,
  engine     text        NOT NULL,            -- 'valhalla' | 'otp2'
  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (cell_key, mode, minutes)
);
CREATE INDEX IF NOT EXISTS isochrone_geom_ix ON isochrone_cache USING gist (geom);

-- ── 파생 뷰: 일별 활성 공고 수 (알터너티브 데이터의 최소 단위 상품) ─────────
CREATE OR REPLACE VIEW daily_open_postings AS
SELECT d.day,
       p.source,
       w.sido,
       w.sigungu,
       p.job_category,
       count(*) AS open_count
FROM   generate_series(
         (SELECT min(first_seen_on) FROM posting),
         current_date,
         interval '1 day'
       ) AS d(day)
JOIN   posting  p ON p.first_seen_on <= d.day::date AND p.last_seen_on >= d.day::date
LEFT   JOIN worksite w ON w.id = p.worksite_id
GROUP  BY d.day, p.source, w.sido, w.sigungu, p.job_category;
