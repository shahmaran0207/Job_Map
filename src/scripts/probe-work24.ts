import { env } from '../lib/env';
import { safeFetch } from '../lib/security';

/**
 * 고용24 채용정보 API 호출 변형 탐색.
 *
 * 인증키가 '채용정보' API 로 정상 승인됐는데도 "개인회원은 사용할 수 없는
 * OPEN-API입니다" 가 온다. 고용24 문서에는 회원 유형 제한이 명시되어 있지 않다.
 * 따라서 호출 형태 문제인지 계정 권한 문제인지 실제로 갈라야 한다.
 *
 * 검색으로 확인된 실제 동작 URL 에는 keyword / coNm / srchBgnDt / srchEndDt 가
 * 포함되어 있었다. 파라미터 누락이 원인일 가능성을 먼저 배제한다.
 *
 * 일회성 진단 도구다. 결론이 나면 삭제하거나 keys:check 로 흡수한다.
 */
const HOSTS = ['www.work24.go.kr', 'm.work24.go.kr'];
const PATH = '/cm/openApi/call/wk/callOpenApiSvcInfo210L01.do';

interface Variant {
  label: string;
  host: string;
  params: Record<string, string>;
}

function variants(key: string): Variant[] {
  const minimal = {
    authKey: key,
    callTp: 'L',
    returnType: 'XML',
    startPage: '1',
    display: '10',
  };

  // 검색으로 확인된 실제 호출 형태를 그대로 재현한다.
  const full = {
    ...minimal,
    keyword: '',
    coNm: '',
    srchBgnDt: '20260101',
    srchEndDt: '20261231',
  };

  const out: Variant[] = [];
  for (const host of HOSTS) {
    out.push({ label: `${host} 최소 파라미터`, host, params: minimal });
    out.push({ label: `${host} 전체 파라미터`, host, params: full });
  }
  // JSON 반환 요청도 시도한다. 오류 메시지가 더 구체적으로 오는 경우가 있다.
  out.push({
    label: `${HOSTS[0]} JSON 반환`,
    host: HOSTS[0]!,
    params: { ...full, returnType: 'JSON' },
  });
  return out;
}

async function probe(v: Variant): Promise<void> {
  const url = new URL(`https://${v.host}${PATH}`);
  for (const [k, val] of Object.entries(v.params)) url.searchParams.set(k, val);

  try {
    const res = await safeFetch(url, {
      allowHosts: [v.host],
      maxRedirects: 0,
      maxBytes: 2 * 1024 * 1024,
      timeoutMs: 20_000,
    });
    const body = res.text.replace(/\s+/g, ' ').trim().slice(0, 220);
    const looksOk = /<wanted>|"wanted"/.test(res.text);
    console.log(`${looksOk ? '✓' : '✗'} ${v.label}  [HTTP ${res.status}]`);
    console.log(`    ${body}`);
  } catch (e) {
    console.log(`✗ ${v.label}  요청 실패: ${String(e).slice(0, 140)}`);
  }
  console.log('');
}

async function main(): Promise<void> {
  const key = env.worknetKey;
  console.log(`인증키 ${key.slice(0, 8)}… (${key.length}자)\n`);

  for (const v of variants(key)) {
    await probe(v);
  }

  console.log('판정 기준:');
  console.log('  하나라도 <wanted> 가 나오면 호출 형태 문제였다 -> 수집기를 그 형태로 맞춘다.');
  console.log('  전부 "개인회원" 메시지면 계정 권한 제한이 확정이다 -> 공공데이터포털로 간다.');
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
