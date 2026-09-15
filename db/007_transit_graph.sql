-- 대중교통 라우팅용 minotor 바이너리(timetable/stops) 저장.
--
-- 자체 호스팅 OTP2(Docker)를 폐기하고 minotor(서버 없이 서버리스 함수 안에서
-- RAPTOR를 직접 돌리는 라이브러리)로 대체하면서 필요해졌다. GTFS 원본은
-- KTDB 포털에서 수동 다운로드만 가능해 자동 재수집이 불가능하고, 우리 GTFS의
-- calendar.txt는 서비스 하나가 매일 동일하게 적용되어(요일별 차이 없음)
-- "하루치 스냅샷"이라도 갱신 주기가 빡빡할 필요가 없다. 그래서 크론이 아니라
-- `npm run build:transit-graph` 수동 스크립트로 채우고, GTFS 원본을 새로
-- 받을 때만 다시 실행한다.

CREATE TABLE IF NOT EXISTS transit_graph (
  name       text        PRIMARY KEY,   -- 'timetable' | 'stops'
  data       bytea       NOT NULL,
  built_for  date        NOT NULL,       -- minotor parseTimetable 에 넘긴 기준일
  built_at   timestamptz NOT NULL DEFAULT now()
);
