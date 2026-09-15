import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  GtfsParser,
  StraightLineTransferGenerator,
  standardGtfsProfile,
} from 'minotor/parser';

/**
 * GTFS(부산권, 필터링 완료본) → minotor 바이너리(timetable/stops) → 저장소에 커밋.
 *
 * DB(bytea)에 저장했다가 배포 첫 버전에서 요청마다 16MB를 DB에서 새로 받아오는
 * 것 자체가 병목이라는 게 드러났다(콜드스타트 30~60초). 이 그래프는 GTFS 원본을
 * 새로 받았을 때만 바뀌는 정적 데이터이므로, 배포 번들에 파일로 직접 포함시켜
 * 네트워크 왕복 자체를 없앤다 — `src/lib/transit.ts` 가 이 경로를 fs로 직접 읽는다.
 *
 * 수동 실행 스크립트다. 크론이 아니다 — GTFS 원본은 KTDB 포털에서 수동
 * 다운로드만 가능해 자동 재수집이 안 되고, 우리 GTFS는 서비스가 요일 무관하게
 * 매일 동일하게 적용돼(`calendar.txt` 참고) "오늘 날짜 기준"이 결과에 영향을
 * 주지 않는다. GTFS 원본을 새로 받았을 때만 다시 돌리고 결과를 커밋하면 된다.
 *
 * 사용법: npm run build:transit-graph -- <GTFS zip 경로>
 */
const OUT_DIR = join(process.cwd(), 'src/data/transit-graph');

async function main(): Promise<void> {
  const gtfsPath = process.argv[2];
  if (!gtfsPath) {
    throw new Error('사용법: npm run build:transit-graph -- <GTFS zip 경로>');
  }

  const parser = new GtfsParser(
    gtfsPath,
    standardGtfsProfile,
    new StraightLineTransferGenerator({ maxDistanceMeters: 500 }),
  );

  console.log('타임테이블 파싱 중...');
  const timetable = await parser.parseTimetable(new Date());
  console.log('정류장 인덱스 파싱 중...');
  const stopsIndex = await parser.parseStops();

  const timetableBytes = Buffer.from(timetable.serialize());
  const stopsBytes = Buffer.from(stopsIndex.serialize());

  console.log(
    `timetable ${(timetableBytes.length / 1024 / 1024).toFixed(1)}MB, ` +
      `stops ${(stopsBytes.length / 1024 / 1024).toFixed(1)}MB`,
  );

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 'timetable.bin'), timetableBytes);
  writeFileSync(join(OUT_DIR, 'stops.bin'), stopsBytes);

  console.log(`저장 완료: ${OUT_DIR} — git에 커밋하세요.`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
