import { XMLParser } from 'fast-xml-parser';
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

async function checkWorknet(): Promise<void> {
  console.log('── 고용24(워크넷) 채용정보 오픈API ──────────');
  let key: string;
  try {
    key = env.worknetKey;
  } catch {
    console.log('✗ WORKNET_API_KEY 가 설정되지 않았습니다');
    failures += 1;
    return;
  }
  describeKey('WORKNET_API_KEY', key);

  const url = new URL('https://openapi.work.go.kr/opi/opi/opia/wantedApi.do');
  url.searchParams.set('authKey', key);
  url.searchParams.set('callTp', 'L');
  url.searchParams.set('returnType', 'XML');
  url.searchParams.set('startPage', '1');
  url.searchParams.set('display', '10');

  try {
    const res = await safeFetch(url, {
      allowHosts: ['openapi.work.go.kr'],
      maxRedirects: 0,
      maxBytes: 4 * 1024 * 1024,
      timeoutMs: 30_000,
    });

    if (res.status !== 200) {
      console.log(`✗ HTTP ${res.status}`);
      failures += 1;
      return;
    }

    const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false, trimValues: true });
    const parsed = stripDangerousKeys(parser.parse(res.text)) as Record<string, any>;
    const root = parsed.wantedRoot ?? parsed.WantedRoot ?? parsed.response ?? parsed;

    // 오류 응답은 본문에 메시지로 온다. HTTP 200 이어도 실패일 수 있다.
    const errMsg =
      root?.error ?? root?.errorMsg ?? root?.message ?? root?.resultMsg ?? root?.returnAuthMsg;
    const wanted = root?.wanted;

    if (!wanted) {
      console.log('✗ 공고 데이터가 없습니다');
      if (errMsg) console.log(`  서버 메시지: ${String(errMsg).slice(0, 200)}`);
      console.log('  응답 앞부분:');
      console.log('  ' + res.text.replace(/\s+/g, ' ').slice(0, 400));
      console.log('');
      console.log('  가장 흔한 원인: 인증키는 발급됐지만 "채용정보" API 개별 활용신청이');
      console.log('  안 된 상태입니다. openapi.work.go.kr 의 오픈API 목록에서 신청하세요.');
      failures += 1;
      return;
    }

    const items = Array.isArray(wanted) ? wanted : [wanted];
    console.log(`✓ 응답 정상 — ${items.length}건 수신 (전체 ${root?.total ?? '?'}건)`);

    // 필드 매핑 검증용으로 실제 키 목록을 보여준다. 문서와 다른 경우가 많다.
    const first = items[0] as Record<string, unknown> | undefined;
    if (first) {
      console.log(`  응답 필드: ${Object.keys(first).join(', ')}`);
      const addrKeys = Object.keys(first).filter((k) => /addr|region|place|근무/i.test(k));
      console.log(`  주소 관련 필드: ${addrKeys.length ? addrKeys.join(', ') : '없음 (상세 API 필요)'}`);
    }
  } catch (e) {
    console.log(`✗ 호출 실패: ${String(e)}`);
    failures += 1;
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
