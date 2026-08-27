-- 근무지 좌표 확정 이력을 더 자세히 남긴다.
--
-- 배경: 사람인 API 는 근무지를 시군구 해상도로만 준다("서울 > 관악구").
-- 시군구 중심점으로 통근시간을 계산하면 관악구만 해도 동서 5km 오차가 생겨
-- "도보 30분 이내" 필터가 무의미해진다. 그래서 좌표를 어떤 전략으로 얻었는지,
-- 그 좌표를 통근 계산에 써도 되는지를 데이터에 명시적으로 기록해야 한다.

-- 기존 geo_source CHECK 제약을 전략 기반으로 교체한다.
ALTER TABLE worksite DROP CONSTRAINT IF EXISTS worksite_geo_source_check;

ALTER TABLE worksite
  ADD COLUMN IF NOT EXISTS geo_strategy text,
  -- 이 좌표로 통근시간을 계산해도 되는가.
  -- false 면 지도에는 표시하되 통근시간은 "정확도 낮음"으로 처리한다.
  ADD COLUMN IF NOT EXISTS commute_usable boolean NOT NULL DEFAULT false,
  -- 좌표 확정에 실제로 사용한 질의문. 재현성과 오류 추적에 쓴다.
  ADD COLUMN IF NOT EXISTS geo_query text,
  ADD COLUMN IF NOT EXISTS geo_resolved_at timestamptz;

COMMENT ON COLUMN worksite.geo_strategy IS
  'address=상세주소 직접 / company_region=회사명+시군구 키워드 / company=회사명 단독 / region_centroid=시군구 중심점(폴백)';

CREATE INDEX IF NOT EXISTS worksite_commute_usable_ix
  ON worksite (commute_usable) WHERE commute_usable;

-- 통근 계산에 쓸 수 없는 근무지를 우선 개선 대상으로 뽑기 위한 인덱스
CREATE INDEX IF NOT EXISTS worksite_needs_work_ix
  ON worksite (geo_confidence) WHERE NOT commute_usable;

-- ── 좌표 품질 현황 뷰 ───────────────────────────────────────────────────────
-- 이 비율이 곧 제품의 신뢰도다. 통근 계산 가능 비율이 낮으면 지도가 거짓말을 한다.
CREATE OR REPLACE VIEW worksite_quality AS
SELECT coalesce(w.geo_strategy, '(미해결)')                          AS strategy,
       coalesce(w.geo_precision, '(없음)')                           AS precision,
       w.commute_usable,
       count(DISTINCT w.id)                                          AS worksites,
       count(DISTINCT w.id) FILTER (WHERE w.geom IS NOT NULL)        AS geocoded,
       -- 공고 수로 가중치를 본다. 근무지 1건이라도 공고가 많으면 개선 우선순위가 높다.
       count(p.id) FILTER (WHERE p.is_open)                          AS open_postings
FROM   worksite w
LEFT   JOIN posting p ON p.worksite_id = w.id
GROUP  BY 1, 2, 3
ORDER  BY 6 DESC, 4 DESC;
