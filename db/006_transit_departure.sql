-- 대중교통 등시선은 시간표 기반이라 출발 시각에 따라 결과가 달라진다.
-- 도보/자차와 달리 "몇 시에 출발하느냐"를 캐시 키에 넣어야 한다.
--
-- 유연근무가 흔해져서 "평일 오전 8시" 같은 고정값을 강제하지 않고 사용자가
-- 직접 출발 요일/시각을 고르게 한다. 다만 사용자가 매번 1분 단위로 다른 시각을
-- 넣으면 캐시가 거의 안 맞으므로, 30분 단위로 반올림한 슬롯('weekday-0830',
-- 'sat-1400' 형태)을 캐시 키로 쓴다. 도보/자차는 시간 무관이라 빈 문자열로 둔다.

ALTER TABLE isochrone_cache DROP CONSTRAINT isochrone_cache_pkey;

ALTER TABLE isochrone_cache
  ADD COLUMN departure_slot text NOT NULL DEFAULT '';

ALTER TABLE isochrone_cache
  ADD PRIMARY KEY (cell_key, mode, minutes, departure_slot);
