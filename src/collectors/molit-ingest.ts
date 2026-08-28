import { query } from '../lib/db';
import { normalizeCompanyName } from '../lib/text';
import type { NormalizedDeal } from './molit-types';

/**
 * 실거래 적재.
 *
 * 채용 축에서 검증된 패턴을 그대로 쓴다. 건물을 먼저 배치 upsert 해 좌표를
 * 한 번만 확정하고, 거래는 내용 기반 유니크 키로 중복을 막는다.
 *
 * 실거래 레코드에는 고유 ID 가 없다. 같은 슬롯을 재수집하면 전부 중복이 되므로
 * (건물, 계약년월, 일, 보증금, 월세, 면적, 층, 계약구분) 조합을 동일 거래로 본다.
 */
const CHUNK = 500;

export interface DealIngestStats {
  deals: number;
  newDeals: number;
  buildings: number;
  newBuildings: number;
  skipped: number;
}

export async function ingestDeals(
  deals: NormalizedDeal[],
  runDate: string,
): Promise<DealIngestStats> {
  const stats: DealIngestStats = {
    deals: 0, newDeals: 0, buildings: 0, newBuildings: 0, skipped: 0,
  };

  for (let i = 0; i < deals.length; i += CHUNK) {
    const chunk = deals.slice(i, i + CHUNK);
    try {
      await ingestChunk(chunk, runDate, stats);
    } catch (e) {
      // 배치 하나가 실패해도 전체를 버리지 않는다. 원인 행을 격리한다.
      console.error(`  ! 배치 실패 (${chunk.length}건), 개별 재시도: ${String(e).slice(0, 160)}`);
      for (const d of chunk) {
        try {
          await ingestChunk([d], runDate, stats);
        } catch (inner) {
          stats.skipped += 1;
          console.error(`  ! 적재 실패 ${d.housingType}/${d.regionCode}/${d.dealYm}: ${String(inner).slice(0, 120)}`);
        }
      }
    }
  }

  return stats;
}

async function ingestChunk(
  chunk: NormalizedDeal[],
  runDate: string,
  stats: DealIngestStats,
): Promise<void> {
  if (chunk.length === 0) return;

  const buildingIds = await upsertBuildings(chunk, stats);

  const payload: unknown[] = [];
  for (const d of chunk) {
    const id = buildingIds.get(buildingKey(d));
    if (id === undefined) {
      stats.skipped += 1;
      continue;
    }
    payload.push({
      building_id: id,
      deal_ym: d.dealYm,
      deal_day: d.dealDay,
      deposit: d.deposit,
      monthly_rent: d.monthlyRent,
      area: d.area,
      floor: d.floor,
      contract_type: d.contractType,
      contract_term: d.contractTerm,
      renewal_right: d.renewalRight,
      raw: d.raw ?? null,
    });
  }

  if (payload.length === 0) return;

  // 중복은 조용히 무시한다. 재수집 시 같은 거래가 다시 들어오는 것이 정상이다.
  const inserted = await query<{ id: string }>(
    `INSERT INTO rent_deal (
       building_id, deal_ym, deal_day, deposit, monthly_rent, area, floor,
       contract_type, contract_term, renewal_right, first_seen_on, raw
     )
     SELECT building_id, deal_ym, deal_day, deposit, monthly_rent, area, floor,
            contract_type, contract_term, renewal_right, $2::date, raw
       FROM jsonb_to_recordset($1::jsonb) AS x(
              building_id bigint, deal_ym text, deal_day int,
              deposit bigint, monthly_rent bigint, area numeric, floor int,
              contract_type text, contract_term text, renewal_right text, raw jsonb
            )
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [JSON.stringify(payload), runDate],
  );

  stats.deals += payload.length;
  stats.newDeals += inserted.length;
}

/** 건물 식별 키. 배치 내 중복 제거와 id 매핑에 쓴다. */
function buildingKey(d: NormalizedDeal): string {
  return [
    d.housingType,
    d.regionCode,
    d.legalDong ?? '',
    d.jibun ?? '',
    nameNorm(d.name),
  ].join('|');
}

function nameNorm(name: string | null): string {
  if (!name) return '';
  return normalizeCompanyName(name);
}

async function upsertBuildings(
  chunk: NormalizedDeal[],
  stats: DealIngestStats,
): Promise<Map<string, number>> {
  // ON CONFLICT DO UPDATE 는 한 문장에서 같은 키를 두 번 건드리면 실패한다.
  // 실거래는 같은 건물이 수십 건 반복되므로 중복 제거가 필수다.
  const byKey = new Map<string, NormalizedDeal>();
  for (const d of chunk) {
    const k = buildingKey(d);
    const prev = byKey.get(k);
    // 같은 건물이면 정보가 더 많은 레코드를 대표로 둔다(도로명·건축년도 등).
    if (!prev || score(d) > score(prev)) byKey.set(k, d);
  }

  const payload = [...byKey.values()].map((d) => ({
    housing_type: d.housingType,
    region_code: d.regionCode,
    legal_dong: d.legalDong,
    jibun: d.jibun,
    name: d.name,
    name_norm: nameNorm(d.name) || null,
    road_address: d.roadAddress,
    apt_seq: d.aptSeq,
    built_year: d.builtYear,
  }));

  const rows = await query<{
    id: string; housing_type: string; region_code: string;
    legal_dong: string | null; jibun: string | null; name_norm: string | null;
    inserted: boolean;
  }>(
    `INSERT INTO building (
       housing_type, region_code, legal_dong, jibun, name, name_norm,
       road_address, apt_seq, built_year
     )
     SELECT housing_type, region_code, legal_dong, jibun, name, name_norm,
            road_address, apt_seq, built_year
       FROM jsonb_to_recordset($1::jsonb) AS x(
              housing_type text, region_code text, legal_dong text, jibun text,
              name text, name_norm text, road_address text, apt_seq text, built_year int
            )
     ON CONFLICT (housing_type, region_code, coalesce(legal_dong,''),
                  coalesce(jibun,''), coalesce(name_norm,''))
     DO UPDATE SET
       -- 나중 응답이 더 많은 정보를 담고 있으면 채운다. 있는 값을 지우지는 않는다.
       name         = coalesce(building.name, EXCLUDED.name),
       road_address = coalesce(building.road_address, EXCLUDED.road_address),
       apt_seq      = coalesce(building.apt_seq, EXCLUDED.apt_seq),
       built_year   = coalesce(building.built_year, EXCLUDED.built_year),
       updated_at   = now()
     RETURNING id, housing_type, region_code, legal_dong, jibun, name_norm,
               (xmax = 0) AS inserted`,
    [JSON.stringify(payload)],
  );

  const out = new Map<string, number>();
  for (const r of rows) {
    const key = [
      r.housing_type, r.region_code, r.legal_dong ?? '', r.jibun ?? '', r.name_norm ?? '',
    ].join('|');
    out.set(key, Number(r.id));
    if (r.inserted) stats.newBuildings += 1;
  }
  stats.buildings += rows.length;
  return out;
}

/** 정보량 점수. 같은 건물의 여러 레코드 중 대표를 고를 때 쓴다. */
function score(d: NormalizedDeal): number {
  let s = 0;
  if (d.roadAddress) s += 4; // 도로명이 있으면 지오코딩 정밀도가 가장 높다
  if (d.aptSeq) s += 2;
  if (d.builtYear) s += 1;
  if (d.name) s += 1;
  return s;
}
