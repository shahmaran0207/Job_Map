import { closeDb, query } from '../lib/db.ts';
import { env } from '../lib/env.ts';
import { resolveWorksite } from '../lib/worksite-resolver.ts';

/**
 * 좌표가 없는 근무지를 배치로 해결한다.
 *
 * 수집 루프와 분리한 이유는 Kakao 일일 쿼터에 수집이 발목 잡히면 시계열에
 * 결측이 생기기 때문이다. 수집은 절대 멈추지 않아야 한다.
 *
 * 열린 공고가 많은 근무지를 먼저 처리한다. 사용자가 실제로 볼 확률이 높은 순서다.
 */
async function main(): Promise<void> {
  const limit = env.geocodeDailyLimit;
  const onlyUnusable = process.argv.includes('--improve');

  // --improve: 이미 좌표가 있지만 통근 계산에 쓸 수 없는(정밀도 낮은) 건을 재시도한다.
  //            시군구 중심점으로 폴백된 근무지를 건물 단위로 끌어올리는 용도.
  const where = onlyUnusable ? 'NOT w.commute_usable' : 'w.geom IS NULL';

  const pending = await query<{
    id: string; company_name: string; raw_address: string | null; posting_count: string;
  }>(
    `SELECT w.id, c.name AS company_name, w.raw_address, count(p.id) AS posting_count
       FROM worksite w
       JOIN company c ON c.id = w.company_id
       LEFT JOIN posting p ON p.worksite_id = w.id AND p.is_open
      WHERE ${where}
      GROUP BY w.id, c.name, w.raw_address
      ORDER BY count(p.id) DESC, w.id
      LIMIT $1`,
    [limit],
  );

  console.log(`대상 ${pending.length}건 (${onlyUnusable ? '정밀도 개선' : '신규 해결'})`);

  const byStrategy = new Map<string, number>();
  let usable = 0;
  let miss = 0;

  for (const [i, w] of pending.entries()) {
    const r = await resolveWorksite({
      companyName: w.company_name,
      rawAddress: w.raw_address,
      regionHint: w.raw_address,
    });

    if (!r) {
      miss += 1;
      // 실패를 기록해 다음 실행에서 무한 재시도하지 않도록 한다.
      await query(
        `UPDATE worksite
            SET geo_confidence = 0, commute_usable = false,
                geo_resolved_at = now(), updated_at = now()
          WHERE id = $1`,
        [w.id],
      );
      continue;
    }

    await query(
      `UPDATE worksite
          SET geom = ST_SetSRID(ST_MakePoint($2,$3),4326)::geography,
              address = coalesce($4, address),
              region_code = coalesce($5, region_code),
              sido = coalesce($6, sido),
              sigungu = coalesce($7, sigungu),
              geo_precision = $8,
              geo_confidence = $9,
              geo_strategy = $10,
              geo_query = $11,
              commute_usable = $12,
              geo_resolved_at = now(),
              updated_at = now()
        WHERE id = $1`,
      [
        w.id, r.lon, r.lat, r.address, r.regionCode, r.sido, r.sigungu,
        r.precision, r.confidence, r.strategy, r.query, r.commuteUsable,
      ],
    );

    byStrategy.set(r.strategy, (byStrategy.get(r.strategy) ?? 0) + 1);
    if (r.commuteUsable) usable += 1;

    if ((i + 1) % 200 === 0) {
      console.log(`  ${i + 1}/${pending.length} (통근계산 가능 ${usable}, 실패 ${miss})`);
    }
  }

  console.log('');
  console.log('── 전략별 결과 ─────────────────────────────');
  for (const [strategy, n] of [...byStrategy].sort((a, b) => b[1] - a[1])) {
    console.log(`${strategy.padEnd(16)} ${n}`);
  }
  console.log(`실패             ${miss}`);
  console.log('');

  const total = pending.length;
  if (total > 0) {
    const pct = ((usable / total) * 100).toFixed(1);
    console.log(`통근시간 계산 가능: ${usable}/${total} (${pct}%)`);
    console.log('이 비율이 곧 지도의 신뢰도다. 낮으면 --improve 로 재시도하거나');
    console.log('국민연금 사업장 데이터 조인으로 보강한다.');
  }
}

main()
  .catch((e) => {
    console.error('근무지 해결 실패:', e);
    process.exitCode = 1;
  })
  .finally(closeDb);
