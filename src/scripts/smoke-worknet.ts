import { mapListItem, parseListXml } from '../collectors/worknet.ts';

/**
 * 워크넷 응답 파싱 회귀 테스트.
 *
 * API 키 없이 돌아간다. 목적은 두 가지다.
 *  1) XML 파서 라이브러리 업그레이드(예: fast-xml-parser 4.x -> 5.x)가
 *     파싱 동작을 바꿨는지 즉시 잡는다. 이 파싱이 조용히 깨지면 수집이
 *     0건이 되고 시계열에 회복 불가능한 결측이 생긴다.
 *  2) 필드 매핑과 값 파서(급여/날짜/경력)의 동작을 고정한다.
 *
 * 픽스처는 실제 응답 구조를 모사한 것이다. 실 API 로 확인되면 필드명을 교정한다.
 */
let failures = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : `\n    기대: ${JSON.stringify(expected)}\n    실제: ${JSON.stringify(actual)}`}`);
  if (!ok) failures += 1;
}

// 항목 2개 (배열로 파싱되어야 한다)
const LIST_XML = `<?xml version="1.0" encoding="UTF-8"?>
<wantedRoot>
  <total>1234</total>
  <wanted>
    <wantedAuthNo>K120051234567890</wantedAuthNo>
    <company>(주)테스트컴퍼니</company>
    <title>백엔드 개발자 모집</title>
    <salTpNm>연봉</salTpNm>
    <sal>4,000만원</sal>
    <region>서울 강남구</region>
    <basicAddr>서울특별시 강남구 테헤란로 152</basicAddr>
    <minEdubg>대졸(4년)이상</minEdubg>
    <career>경력 3년 이상</career>
    <empTpNm>기간의 정함이 없는 근로계약</empTpNm>
    <jobsCd>024</jobsCd>
    <regDt>2026-08-01</regDt>
    <closeDt>20260930</closeDt>
    <wantedInfoUrl>https://www.work24.go.kr/wk/a/b/1500/empDetail.do?id=1</wantedInfoUrl>
    <holidayTpNm>주5일근무</holidayTpNm>
  </wanted>
  <wanted>
    <wantedAuthNo>K120051234567891</wantedAuthNo>
    <company>둘째회사</company>
    <title>프론트엔드 개발자</title>
    <sal>면접 후 결정</sal>
    <region>부산 해운대구</region>
    <career>신입</career>
    <wantedInfoUrl>javascript:alert(1)</wantedInfoUrl>
  </wanted>
</wantedRoot>`;

// 항목 1개 (배열이 아니라 객체로 파싱된다 - 흔한 함정)
const SINGLE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<wantedRoot>
  <total>1</total>
  <wanted>
    <wantedAuthNo>SINGLE-1</wantedAuthNo>
    <company>홀로회사</company>
    <title>단건 공고</title>
    <region>대전 유성구</region>
  </wanted>
</wantedRoot>`;

const ERROR_XML = `<?xml version='1.0' encoding='UTF-8'?><GO24><error>개인회원은 사용할 수 없는 OPEN-API입니다.</error></GO24>`;
const EMPTY_XML = `<?xml version="1.0" encoding="UTF-8"?><wantedRoot><total>0</total></wantedRoot>`;

function main(): void {
  console.log('워크넷 파싱 회귀 테스트\n');

  // ── 목록 파싱 ─────────────────────────────────────────────────────────────
  const items = parseListXml(LIST_XML);
  check('항목 2개 파싱', items.length, 2);

  const first = items[0];
  check('중첩 태그가 객체 키로 노출', first?.wantedAuthNo, 'K120051234567890');

  // ── 단건 응답이 배열로 정규화되는지 (파서는 객체 하나로 준다) ─────────────
  check('단건 응답도 배열로', parseListXml(SINGLE_XML).length, 1);

  // ── 빈 응답 / 오류 응답 ───────────────────────────────────────────────────
  check('빈 응답은 0건', parseListXml(EMPTY_XML).length, 0);

  let threw = '';
  try {
    parseListXml(ERROR_XML);
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e);
  }
  check('오류 응답은 예외로', threw.includes('개인회원'), true);

  // ── 필드 매핑 ─────────────────────────────────────────────────────────────
  const p = first ? mapListItem(first) : null;
  if (!p) {
    console.log('✗ 첫 항목 매핑 실패');
    failures += 1;
  } else {
    check('sourceId', p.sourceId, 'K120051234567890');
    check('회사명', p.companyName, '(주)테스트컴퍼니');
    check('제목', p.title, '백엔드 개발자 모집');
    check('주소 (basicAddr 우선)', p.rawAddress, '서울특별시 강남구 테헤란로 152');
    check('지역 힌트', p.regionHint, '서울 강남구');
    check('급여 파싱 (4,000만원 -> 원)', p.salaryMin, 40_000_000);
    check('급여 형태', p.salaryType, '연봉');
    check('학력', p.education, '대졸(4년)이상');
    check('경력 연차 파싱', p.careerMinYear, 3);
    check('등록일 (하이픈 형식)', p.postedOn, '2026-08-01');
    check('마감일 (8자리 형식)', p.closesOn, '2026-09-30');
    check('직종코드', p.jobCode, '024');
    check('URL 통과', p.url, 'https://www.work24.go.kr/wk/a/b/1500/empDetail.do?id=1');
  }

  // ── 두 번째 항목: 방어 로직 ───────────────────────────────────────────────
  const second = items[1] ? mapListItem(items[1]!) : null;
  if (!second) {
    console.log('✗ 두 번째 항목 매핑 실패');
    failures += 1;
  } else {
    check('javascript: 스킴 URL 차단', second.url, null);
    check('급여 미상은 null', second.salaryMin, null);
    check('신입 -> 경력 0년', second.careerMinYear, 0);
    check('주소 없으면 지역으로 폴백', second.rawAddress, '부산 해운대구');
  }

  console.log('');
  if (failures > 0) {
    console.error(`${failures}개 항목 실패 — XML 파서 동작이 바뀌었거나 매핑이 깨졌습니다.`);
    process.exitCode = 1;
  } else {
    console.log('모든 항목 통과');
  }
}

main();
