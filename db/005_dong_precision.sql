-- 좌표 정밀도에 '법정동 중심점' 단계를 추가한다.
--
-- 단독/다가구는 개인정보 보호로 지번·건물명이 제공되지 않고 법정동만 온다.
-- 그래서 최선이 법정동 중심점이다. 이것을 시군구 중심점과 같은 등급으로 묶으면
-- 정보가 손실된다. 관악구(반경 약 3km)와 신림동(반경 약 1km)은 통근 계산에서
-- 의미가 다르고, 나중에 "대중교통 모드에서는 dong 까지 허용" 같은 정책을 두려면
-- 구분이 남아 있어야 한다.
--
-- 통근 계산 허용 여부(commute_usable)는 별도 컬럼이므로 이 등급 추가가
-- 정확도 판정을 느슨하게 만들지는 않는다. dong 은 여전히 false 다.

ALTER TABLE building DROP CONSTRAINT IF EXISTS building_geo_precision_check;

ALTER TABLE building
  ADD CONSTRAINT building_geo_precision_check
  CHECK (geo_precision IN ('building', 'road', 'dong', 'sigungu', 'sido', 'unknown'));

COMMENT ON COLUMN building.geo_precision IS
  'building=건물 / road=도로 / dong=법정동 중심점 / sigungu=시군구 중심점 / sido=시도';
