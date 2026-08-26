import { XMLParser } from 'fast-xml-parser';
import { WORKNET_FLAVORS, buildListUrl, endpointOf } from '../collectors/worknet.ts';
import { closeDb } from '../lib/db.ts';
import { env } from '../lib/env.ts';
import { geocode } from '../lib/geocode.ts';
import { safeFetch, stripDangerousKeys } from '../lib/security.ts';

/**
 * 외부 API 키 검사.
 *
 * 실제로 한 번 호출해 본다. 키가 형식상 존재하는지가 아니라, 권한까지 붙어
 * 응답이 오는지가 중요하다. 워크넷은 인증키 발급과 개별 API 활용신청이
 * 분리되어 있어, 키는 유효한데 권한 오류가 나는 상태가 흔하다.
 *
 * 키 값은 절대 출력하지 않는다. 길이와 형태만 보고한다.
 */
let failures = 0;

function describeKey(label: string, value: string | undefined): void {
  if (!value) {
    console.log(`✗ ${label}: 비어 있음`);
    failures += 1;
    return;
  }
  const hints: string[] = [`길이 ${value.length}`];
  if (/\s/.test(value)) hints.push('공백 포함 (여러 키를 붙여넣었을 가능성)');
  if (value.includes(',')) hints.push('쉼표 포함 (여러 키를 붙여넣었을 가능성)');
  if (value !== value.trim()) hints.push('앞뒤 공백 있음');
  if (/^["']|["']$/.test(value)) hints.push('따옴표로 감싸져 있음 (제거 필요)');
  console.log(`  ${label}: ${hints.join(', ')}`);
}

const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false, trimValues: true });

/**
 * 채용정보 API 를 두 계열 모두 시도한다.
 *
 * 개인이 받을 수 있는 키(공공데이터포털)와 기업·기관 키(고용24)가 엔드포인트가
 * 다르고, 어느 쪽을 받았는지 사용자가 알기 어렵다. 그래서 둘 다 호출해 보고
 * 동작하는 쪽을 알려준다. 잘못된 조합에서 오는 오류 메시지가 서로 달라
 * 원인 판별에도 도움이 된다.
 */
async function checkWorknet(): Promise<void> {
  console.log('── 채용정보 오픈API ─────────────────────────');
  let key: string;
  try {
    key = env.worknetKey;
  } catch {
    console.log('✗ WORKNET_API_KEY 가 설정되지 않았습니다');
    failures += 1;
    return;
  }
  describeKey('WORKNET_API_KEY', key);
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key)) {
    console.log('  형태: UUID — 고용24 포털에서 발급된 키로 보입니다');
  }
  console.log('');

  let working: string | null = null;

  for (const flavor of WORKNET_FLAVORS) {
    const ep = endpointOf(flavor);
    console.log(`[${flavor}] ${ep.host}`);
    const result = await probe(flavor);
    if (result === 'ok') working = flavor;
  }

  console.log('');
  if (working) {
    console.log(`✓ 동작하는 계열: ${working}`);
    if (working !== env.worknetFlavor) {
      console.log(`  .env 에 WORKNET_API_FLAVOR=${working} 를 추가하세요.`);
      console.log(`  (현재 설정: ${env.worknetFlavor})`);
      failures += 1;
    }
  } else {
    console.log('✗ 두 계열 모두 실패했습니다.');
    console.log('  - "개인회원은 사용할 수 없는" 메시지가 보이면: 고용24 채용정보 API 는');
    console.log('    기업·기관회원 전용입니다. 공공데이터포털(data.go.kr)의');
    console.log('    "한국고용정보원_워크넷 채용정보" 를 자동승인으로 신청해 키를 받으세요.');
    console.log('    단 KOGL 제4유형(비상업적 이용만)이라는 제약이 붙습니다.');
    console.log('  - "유효하지 않은 인증키" 가 보이면: 키가 해당 API 용이 아니거나');
    console.log('    활용신청이 승인되지 않은 상태입니다.');
    failures += 1;
  }
}

async function probe(flavor: (typeof WORKNET_FLAVORS)[number]): Promise<'ok' | 'fail'> {
  const ep = endpointOf(flavor);
  try {
    const res = await safeFetch(buildListUrl(1, 10, flavor), {
      allowHosts: [ep.host],
      maxRedirects: 0,
      maxBytes: 4 * 1024 * 1024,
      timeoutMs: 30_000,
    });

    if (res.status !== 200) {
      console.log(`  ✗ HTTP ${res.status}`);
      return 'fail';
    }

    const parsed = stripDangerousKeys(parser.parse(res.text)) as Record<string, any>;
    const root = parsed.wantedRoot ?? parsed.WantedRoot ?? parsed.GO24 ?? parsed.response ?? parsed;

    // 오류는 HTTP 200 본문에 메시지로 온다. 상태코드만 봐서는 알 수 없다.
    const errMsg =
      root?.error ?? root?.errorMsg ?? root?.message ?? root?.resultMsg ?? root?.returnAuthMsg;
    const wanted = root?.wanted;

    if (!wanted) {
      if (errMsg) console.log(`  ✗ ${String(errMsg).slice(0, 120)}`);
      else console.log(`  ✗ 공고 없음 — 응답: ${res.text.replace(/\s+/g, ' ').slice(0, 200)}`);
      return 'fail';
    }

    const items = Array.isArray(wanted) ? wanted : [wanted];
    console.log(`  ✓ ${items.length}건 수신 (전체 ${root?.total ?? '?'}건)`);

    // 필드 매핑 교정에 쓸 실제 키 목록. 문서와 다른 경우가 많다.
    const first = items[0] as Record<string, unknown> | undefined;
    if (first) {
      console.log(`    응답 필드: ${Object.keys(first).join(', ')}`);
      const addrKeys = Object.keys(first).filter((k) => /addr|region|place|loc/i.test(k));
      console.log(`    주소 관련: ${addrKeys.length ? addrKeys.join(', ') : '없음 (상세 API 필요)'}`);
    }
    return 'ok';
  } catch (e) {
    console.log(`  ✗ 호출 실패: ${String(e).slice(0, 160)}`);
    return 'fail';
  }
}

async function checkKakao(): Promise<void> {
  console.log('');
  console.log('── Kakao Local API (주소/키워드 검색) ───────');
  const key = env.kakaoRestKey;
  if (!key) {
    console.log('✗ KAKAO_REST_KEY 가 설정되지 않았습니다');
    failures += 1;
    return;
  }
  describeKey('KAKAO_REST_KEY', key);

  // geocode() 는 캐시를 쓰므로 DB 도 함께 검증된다.
  const probe = '서울특별시 강남구 테헤란로 152';
  try {
    const hit = await geocode(probe);
    if (!hit) {
      console.log(`✗ '${probe}' 좌표를 얻지 못했습니다.`);
      console.log('  REST API 키가 맞는지(JavaScript 키를 넣지 않았는지) 확인하세요.');
      failures += 1;
      return;
    }
    console.log(
      `✓ 주소 검색 정상 — ${hit.lon.toFixed(5)}, ${hit.lat.toFixed(5)} ` +
        `(${hit.sido} ${hit.sigungu}, 정밀도 ${hit.precision}, 경로 ${hit.provider})`,
    );

    // 지사·공장처럼 주소가 없고 상호만 있는 경우의 폴백 경로도 확인한다.
    const kw = await geocode('삼성전자 수원사업장');
    console.log(
      kw
        ? `✓ 키워드 검색 정상 — ${kw.sido} ${kw.sigungu} (${kw.provider})`
        : '  키워드 검색은 결과 없음 (치명적이지 않음)',
    );
  } catch (e) {
    console.log(`✗ 호출 실패: ${String(e)}`);
    failures += 1;
  }
}

async function main(): Promise<void> {
  await checkWorknet();
  await checkKakao();

  console.log('');
  if (failures > 0) {
    console.error(`${failures}개 항목 실패 — 위 안내를 확인하세요.`);
    process.exitCode = 1;
  } else {
    console.log('모든 키 정상. npm run collect 를 실행할 수 있습니다.');
  }
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(closeDb);
