import { closeDb, query } from '../lib/db.ts';
import { env } from '../lib/env.ts';
import { confidenceOf, geocode } from '../lib/geocode.ts';

/**
 * 좌표가 없는 근무지를 배치로 지오코딩한다. 수집 루프와 분리한 이유는
 * Kakao 일일 쿼터에 수집이 발목 잡히면 시계열에 결측이 생기기 때문이다.
 *
 * 공고 수가 많은 근무지를 먼저 처리한다 (사용자가 실제로 볼 확률이 높은 순서).
 */
async function main(): Promise<void> {
  const limit = env.geocodeDailyLimit;

  const pending = await query<{
    id: number; company_name: string; raw_address: string | null; posting_count: number;
  }>(
    `SELECT w.id, c.name AS company_name, w.raw_address, count(p.id) AS posting_count
       FROM worksite w
       JOIN company c ON c.id = w.company_id
       LEFT JOIN posting p ON p.worksite_id = w.id AND p.is_open
      WHERE w.geom IS NULL
      GROUP BY w.id, c.name, w.raw_address
      ORDER BY count(p.id) DESC
      LIMIT $1`,
    [limit],
  );

  console.log(`지오코딩 대상 ${pending.length}건`);
  let ok = 0;
  let miss = 0;

  for (const [i, w] of pending.entries()) {
    // 주소 원문 -> 실패 시 '회사명 + 지역' 키워드 검색으로 폴백.
    // 지사·공장은 주소가 없어도 상호 검색으로 잡히는 경우가 많다.
    const candidates = [
      w.raw_address,
      w.raw_address ? `${w.company_name} ${firstTwoTokens(w.raw_address)}` : null,
      w.company_name,
    ].filter((v): v is string => !!v);

    let hit = null;
    for (const q of candidates) {
      hit = await geocode(q);
      if (hit && confidenceOf(hit.precision) >= 0.4) break;
    }

    if (!hit) {
      miss += 1;
      await query(`UPDATE worksite SET geo_confidence = 0, updated_at = now() WHERE id = $1`, [w.id]);
      continue;
    }

    await query(
      `UPDATE worksite
          SET geom = ST_SetSRID(ST_MakePoint($2,$3),4326)::geography,
              address = coalesce($4, address),
              region_code = coalesce($5, region_code),
              sido = coalesce($6, sido),
              sigungu = coalesce($7, sigungu),
              geo_source = $8,
              geo_precision = $9,
              geo_confidence = $10,
              updated_at = now()
        WHERE id = $1`,
      [
        w.id, hit.lon, hit.lat, hit.address, hit.regionCode, hit.sido, hit.sigungu,
        hit.provider === 'cache' ? 'kakao_address' : hit.provider,
        hit.precision, confidenceOf(hit.precision),
      ],
    );
    ok += 1;

    if ((i + 1) % 200 === 0) console.log(`  ${i + 1}/${pending.length} (성공 ${ok} / 실패 ${miss})`);
  }

  console.log(`지오코딩 완료: 성공 ${ok} / 실패 ${miss}`);
}

/** '서울특별시 강남구 테헤란로 123' -> '서울특별시 강남구' */
function firstTwoTokens(addr: string): string {
  return addr.trim().split(/\s+/).slice(0, 2).join(' ');
}

main()
  .catch((e) => {
    console.error('지오코딩 실패:', e);
    process.exitCode = 1;
  })
  .finally(closeDb);
