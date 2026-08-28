import { closeDb, one, query } from '../lib/db.ts';
import { today } from '../lib/env.ts';
import { ingestDeals } from './molit-ingest.ts';
import { fetchSlot, isHousingType } from './molit-rent.ts';
import { HOUSING_LABEL, HOUSING_TYPES, type HousingType, type Slot } from './molit-types.ts';

/**
 * 실거래가 수집 오케스트레이터.
 *
 * 실거래가 API 는 (주택유형 × 시군구 × 계약년월) 슬롯 단위로만 조회된다.
 * 269개 시군구 × 4종이므로 1개월분이 1,076슬롯이다. 일 10,000회 한도 안에서
 * 전국을 훑으려면 두 가지가 필요하다.
 *
 *   1) 이미 성공한 슬롯을 건너뛴다 (molit_run 기록)
 *   2) 호출 예산을 초과하기 전에 멈춘다 (다음 실행이 이어받는다)
 *
 * 그리고 **"그 달 거래 0건"과 "수집 실패"를 반드시 구별한다.** 실거래는 실제로
 * 0건인 슬롯이 많다(지방 소도시의 오피스텔 등). 실패를 0건으로 기록하면 시세가
 * 없는 지역처럼 보이고, 그 오염은 나중에 되돌릴 수 없다.
 *
 * 사용법
 *   npm run collect:rent                      최근 3개월, 예산 9000회
 *   npm run collect:rent -- --months=12       최근 12개월 백필
 *   npm run collect:rent -- --from=202401 --to=202412
 *   npm run collect:rent -- --types=apt,offi  유형 제한
 *   npm run collect:rent -- --regions=11680   특정 시군구만 (테스트용)
 *   npm run collect:rent -- --budget=500      호출 예산 제한
 *   npm run collect:rent -- --force           이미 성공한 슬롯도 다시 수집
 */
interface Options {
  months: number;
  from: string | null;
  to: string | null;
  types: HousingType[];
  regions: string[] | null;
  budget: number;
  force: boolean;
}

function parseArgs(): Options {
  const arg = (name: string): string | null => {
    const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : null;
  };

  const typesRaw = arg('types');
  const types = typesRaw
    ? typesRaw.split(',').map((s) => s.trim()).filter(isHousingType)
    : HOUSING_TYPES;
  if (types.length === 0) throw new Error(`--types 값이 올바르지 않습니다: ${typesRaw}`);

  const regionsRaw = arg('regions');

  return {
    months: Number(arg('months') ?? 3),
    from: arg('from'),
    to: arg('to'),
    types,
    regions: regionsRaw ? regionsRaw.split(',').map((s) => s.trim()).filter(Boolean) : null,
    // 개발계정 한도가 일 10,000회다. 다른 스크립트 몫을 남겨 기본값을 9,000 으로 둔다.
    budget: Number(arg('budget') ?? 9000),
    force: process.argv.includes('--force'),
  };
}

/**
 * 대상 계약년월 목록.
 *
 * 당월과 전월은 신고 기한(계약 후 30일) 때문에 데이터가 계속 늘어난다.
 * 그래서 최근 구간은 --force 없이도 다시 훑을 수 있도록 별도로 표시한다.
 */
function targetMonths(opts: Options): { ym: string; volatile: boolean }[] {
  const out: { ym: string; volatile: boolean }[] = [];
  const now = new Date(`${today()}T00:00:00+09:00`);

  if (opts.from) {
    const to = opts.to ?? ymOf(now);
    let cur = opts.from;
    while (cur <= to && out.length < 240) {
      out.push({ ym: cur, volatile: false });
      cur = addMonth(cur, 1);
    }
    return out;
  }

  for (let i = 0; i < opts.months; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    // 최근 2개월은 신고가 계속 들어오므로 재수집 대상으로 둔다.
    out.push({ ym: ymOf(d), volatile: i < 2 });
  }
  return out;
}

function ymOf(d: Date): string {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function addMonth(ym: string, n: number): string {
  const y = Number(ym.slice(0, 4));
  const m = Number(ym.slice(4, 6));
  const d = new Date(y, m - 1 + n, 1);
  return ymOf(d);
}

async function main(): Promise<void> {
  const opts = parseArgs();
  const runDate = today();

  const regions = await query<{ code: string; sigungu: string }>(
    opts.regions
      ? `SELECT code, sigungu FROM region_code
          WHERE active AND code = ANY($1::text[]) ORDER BY priority, code`
      : `SELECT code, sigungu FROM region_code WHERE active ORDER BY priority, code`,
    opts.regions ? [opts.regions] : [],
  );

  if (regions.length === 0) {
    throw new Error('region_code 가 비어 있습니다. 먼저 npm run seed:regions 를 실행하세요.');
  }

  const months = targetMonths(opts);

  // 이미 성공한 슬롯을 미리 읽어 건너뛴다. 슬롯마다 조회하면 왕복이 폭증한다.
  const done = new Set<string>();
  if (!opts.force) {
    const rows = await query<{ housing_type: string; region_code: string; deal_ym: string }>(
      `SELECT DISTINCT housing_type, region_code, deal_ym
         FROM molit_run
        WHERE status IN ('ok','empty') AND deal_ym = ANY($1::text[])`,
      [months.map((m) => m.ym)],
    );
    for (const r of rows) done.add(slotKey(r.housing_type, r.region_code, r.deal_ym));
  }

  const volatile = new Set(months.filter((m) => m.volatile).map((m) => m.ym));

  // 슬롯 순서: 계약년월 최신순 → 지역 우선순위. 백필 중에도 최근 데이터가 먼저 쌓인다.
  const slots: Slot[] = [];
  for (const m of months) {
    for (const r of regions) {
      for (const t of opts.types) {
        const key = slotKey(t, r.code, m.ym);
        // 최근 2개월은 신고가 계속 들어오므로 완료 표시를 무시하고 다시 훑는다.
        if (done.has(key) && !volatile.has(m.ym)) continue;
        slots.push({ housingType: t, regionCode: r.code, dealYm: m.ym });
      }
    }
  }

  console.log(`대상 슬롯 ${slots.length}개 (시군구 ${regions.length} × 유형 ${opts.types.length} × 월 ${months.length})`);
  console.log(`건너뜀 ${done.size}개, 호출 예산 ${opts.budget}회`);
  console.log('');

  let calls = 0;
  let processed = 0;
  const totals = { deals: 0, newDeals: 0, buildings: 0, newBuildings: 0, skipped: 0, empty: 0, failed: 0 };

  for (const slot of slots) {
    if (calls >= opts.budget) {
      console.log('');
      console.log(`호출 예산(${opts.budget})에 도달해 중단합니다. 다음 실행이 이어받습니다.`);
      break;
    }

    const runId = await startRun(slot, runDate);
    try {
      const { deals, totalCount, calls: used } = await fetchSlot(slot);
      calls += used;
      processed += 1;

      if (deals.length === 0) {
        // 진짜 0건. 실패와 구별해 기록해야 "시세 없는 지역" 오염을 막는다.
        totals.empty += 1;
        await finishRun(runId, 'empty', { totalCount, newCount: 0 });
      } else {
        const stats = await ingestDeals(deals, runDate);
        totals.deals += stats.deals;
        totals.newDeals += stats.newDeals;
        totals.buildings += stats.buildings;
        totals.newBuildings += stats.newBuildings;
        totals.skipped += stats.skipped;
        await finishRun(runId, 'ok', { totalCount, newCount: stats.newDeals });
      }
    } catch (e) {
      totals.failed += 1;
      calls += 1; // 실패도 호출을 소비했다
      await finishRun(runId, 'failed', {}, String(e).slice(0, 500));
      console.error(`  ! ${slotLabel(slot)}: ${String(e).slice(0, 140)}`);
    }

    if (processed % 50 === 0) {
      console.log(
        `  ${processed}/${slots.length} 슬롯  호출 ${calls}  ` +
          `신규거래 ${totals.newDeals}  신규건물 ${totals.newBuildings}`,
      );
    }
  }

  console.log('');
  console.log('── 결과 ────────────────────────────────────');
  console.log(`처리 슬롯      ${processed}`);
  console.log(`API 호출       ${calls} / 예산 ${opts.budget}`);
  console.log(`거래 관측      ${totals.deals} (신규 ${totals.newDeals})`);
  console.log(`건물           ${totals.buildings} (신규 ${totals.newBuildings})`);
  console.log(`0건 슬롯       ${totals.empty}`);
  console.log(`실패 슬롯      ${totals.failed}`);
  console.log(`적재 실패 행   ${totals.skipped}`);

  if (totals.failed > 0) process.exitCode = 1;
}

function slotKey(t: string, region: string, ym: string): string {
  return `${t}|${region}|${ym}`;
}

function slotLabel(s: Slot): string {
  return `${HOUSING_LABEL[s.housingType]}/${s.regionCode}/${s.dealYm}`;
}

async function startRun(slot: Slot, runDate: string): Promise<number> {
  // 같은 날 같은 슬롯을 재실행하면 기존 행을 재사용한다(유니크 인덱스).
  const row = await one<{ id: string }>(
    `INSERT INTO molit_run (housing_type, region_code, deal_ym, run_date)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (housing_type, region_code, deal_ym, run_date)
     DO UPDATE SET status = 'running', started_at = now(), finished_at = NULL, error = NULL
     RETURNING id`,
    [slot.housingType, slot.regionCode, slot.dealYm, runDate],
  );
  return Number(row!.id);
}

async function finishRun(
  id: number,
  status: 'ok' | 'empty' | 'failed',
  counts: { totalCount?: number; newCount?: number },
  error?: string,
): Promise<void> {
  await query(
    `UPDATE molit_run
        SET status = $2, finished_at = now(),
            total_count = $3, new_count = $4, error = $5
      WHERE id = $1`,
    [id, status, counts.totalCount ?? 0, counts.newCount ?? 0, error ?? null],
  );
}

main()
  .catch((e) => {
    console.error('실거래가 수집 실패:', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(closeDb);
