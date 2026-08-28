-- 실거래가 응답에서 좌표 해결에 직접 쓰이는 항목을 보존한다.
--
-- 실측 확인:
--   apt 만 도로명주소를 준다. roadnm 이 "언주로30길 21" 처럼 번호까지 포함하므로
--   {시군구명} {roadnm} 으로 조회하면 건물 정밀도로 직행한다. 지번보다 정확하다.
--   aptSeq("11680-566")는 단지의 안정적 식별자다. 단지명 표기가 바뀌거나 오타가
--   있어도 같은 건물임을 알 수 있어, 나중에 중복 정리와 이력 추적에 쓴다.

ALTER TABLE building
  ADD COLUMN IF NOT EXISTS road_address text,
  ADD COLUMN IF NOT EXISTS apt_seq text;

COMMENT ON COLUMN building.road_address IS
  '실거래가 응답의 도로명(apt 전용). 지오코딩 1순위 질의에 쓴다.';
COMMENT ON COLUMN building.apt_seq IS
  '실거래가 응답의 aptSeq. 단지명이 바뀌어도 유지되는 식별자.';

-- 같은 단지가 이름 표기 차이로 여러 행이 되는 것을 나중에 정리하기 위한 인덱스
CREATE INDEX IF NOT EXISTS building_apt_seq_ix ON building (apt_seq) WHERE apt_seq IS NOT NULL;
