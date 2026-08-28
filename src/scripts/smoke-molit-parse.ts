import { mapItem } from '../collectors/molit-rent';
import type { Slot } from '../collectors/molit-types';
import { buildDealYm, parseArea, parseInt0, parseManwon } from '../lib/text';

/**
 * 실거래가 파싱 회귀 테스트. 네트워크·DB 없이 돌아간다.
 *
 * 가장 중요한 검증은 **금액 단위**다. 응답은 만원 단위 + 쉼표 포함 문자열이고,
 * 단위를 틀려도 예외가 나지 않고 시세만 1만배 어긋난다. 이 프로젝트에서 가장
 * 조용하게 치명적인 오류 유형이므로 여기에 고정한다.
 *
 * 픽스처는 2026-06 강남구 실제 응답에서 가져왔다.
 */
let failures = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : `  기대=${JSON.stringify(expected)} 실제=${JSON.stringify(actual)}`}`);
  if (!ok) failures += 1;
}

function testMoney(): void {
  console.log('── 금액 (만원 → 원) ─────────────────────────');
  check('"70,000" = 7억', parseManwon('70,000'), 700_000_000);
  check('"140,000" = 14억', parseManwon('140,000'), 1_400_000_000);
  check('"1,000" = 1천만', parseManwon('1,000'), 10_000_000);
  check('"230" = 230만', parseManwon('230'), 2_300_000);
  check('"67" = 67만', parseManwon('67'), 670_000);
  check('"0" = 0 (전세)', parseManwon('0'), 0);
  check('빈 문자열 = null', parseManwon(''), null);
  check('null = null', parseManwon(null), null);
  check('공백만 = null', parseManwon('   '), null);
  check('음수 = null', parseManwon('-100'), null);
  check('숫자 아님 = null', parseManwon('협의'), null);

  console.log('');
  console.log('── 면적 / 정수 / 계약년월 ───────────────────');
  check('면적 "122.07"', parseArea('122.07'), 122.07);
  check('면적 "148.8017" 소수 2자리로', parseArea('148.8017'), 148.8);
  check('면적 빈 값', parseArea(''), null);
  check('면적 0 이하 배제', parseArea('0'), null);
  check('층 "7"', parseInt0('7'), 7);
  check('층 "-1" (지하)', parseInt0('-1'), -1);
  check('층 빈 값', parseInt0(''), null);
  check('건축년도 빈 값', parseInt0(''), null);
  check('계약년월 조립 (0 패딩 없음)', buildDealYm('2026', '6'), '202606');
  check('계약년월 두 자리 월', buildDealYm('2026', '12'), '202612');
  check('계약년월 이상값', buildDealYm('2026', '13'), null);
}

// ── 실제 응답 픽스처 (2026-06 강남구) ────────────────────────────────────────
const APT_ITEM = {
  aptNm: '아카데미스위트1', aptSeq: '11680-566', buildYear: '2004',
  contractTerm: '', contractType: '', dealDay: '25', dealMonth: '6', dealYear: '2026',
  deposit: '70,000', excluUseAr: '122.07', floor: '7', jibun: '467-7', monthlyRent: '230',
  preDeposit: '', preMonthlyRent: '', roadnm: '언주로30길 21', roadnmbcd: '',
  roadnmbonbun: '00021', roadnmbubun: '00000', roadnmcd: '4166604', roadnmseq: '0',
  roadnmsggcd: '11680', sggCd: '11680', umdNm: '도곡동', useRRRight: '',
};

const OFFI_ITEM = {
  buildYear: '2014', contractTerm: '', contractType: '', dealDay: '9', dealMonth: '6',
  dealYear: '2026', deposit: '1,000', excluUseAr: '21.52', floor: '10', jibun: '662',
  monthlyRent: '67', offiNm: '강남 지웰홈스', preDeposit: '', preMonthlyRent: '',
  sggCd: '11680', sggNm: '강남구', umdNm: '자곡동', useRRRight: '',
};

const RH_ITEM = {
  buildYear: '2018', contractTerm: '', contractType: '', dealDay: '20', dealMonth: '6',
  dealYear: '2026', deposit: '4,000', excluUseAr: '43.845', floor: '4', houseType: '다세대',
  jibun: '1180-1', mhouseNm: '신양빌라', monthlyRent: '94', preDeposit: '',
  preMonthlyRent: '', sggCd: '11680', umdNm: '개포동', useRRRight: '',
};

const SH_ITEM = {
  buildYear: '', contractTerm: '', contractType: '', dealDay: '28', dealMonth: '6',
  dealYear: '2026', deposit: '18,000', houseType: '다가구', monthlyRent: '40',
  preDeposit: '', preMonthlyRent: '', sggCd: '11680', totalFloorAr: '52',
  umdNm: '논현동', useRRRight: '',
};

const JEONSE_ITEM = { ...APT_ITEM, deposit: '95,000', monthlyRent: '0' };

function slot(t: Slot['housingType']): Slot {
  return { housingType: t, regionCode: '11680', dealYm: '202606' };
}

function testMapping(): void {
  console.log('');
  console.log('── 아파트 매핑 ──────────────────────────────');
  const apt = mapItem(APT_ITEM, slot('apt'));
  if (!apt) {
    console.log('✗ 아파트 매핑 실패');
    failures += 1;
  } else {
    check('건물명', apt.name, '아카데미스위트1');
    check('aptSeq', apt.aptSeq, '11680-566');
    check('도로명 (지오코딩 1순위)', apt.roadAddress, '언주로30길 21');
    check('지번', apt.jibun, '467-7');
    check('법정동', apt.legalDong, '도곡동');
    check('시군구코드', apt.regionCode, '11680');
    check('보증금 (원)', apt.deposit, 700_000_000);
    check('월세 (원)', apt.monthlyRent, 2_300_000);
    check('면적', apt.area, 122.07);
    check('층', apt.floor, 7);
    check('건축년도', apt.builtYear, 2004);
    check('계약년월', apt.dealYm, '202606');
    check('계약일', apt.dealDay, 25);
  }

  console.log('');
  console.log('── 유형별 필드명 차이 흡수 ──────────────────');
  const offi = mapItem(OFFI_ITEM, slot('offi'));
  check('오피스텔 건물명 (offiNm)', offi?.name, '강남 지웰홈스');
  check('오피스텔 도로명 없음', offi?.roadAddress, null);
  check('오피스텔 보증금', offi?.deposit, 10_000_000);
  check('오피스텔 월세', offi?.monthlyRent, 670_000);

  const rh = mapItem(RH_ITEM, slot('rh'));
  check('연립다세대 건물명 (mhouseNm)', rh?.name, '신양빌라');
  check('연립다세대 주택유형', rh?.houseType, '다세대');
  check('연립다세대 면적', rh?.area, 43.85);

  const sh = mapItem(SH_ITEM, slot('sh'));
  check('단독다가구 건물명 없음', sh?.name, null);
  check('단독다가구 지번 없음', sh?.jibun, null);
  check('단독다가구 법정동만', sh?.legalDong, '논현동');
  check('단독다가구 면적 (totalFloorAr)', sh?.area, 52);
  check('단독다가구 층 없음', sh?.floor, null);
  check('단독다가구 건축년도 빈 값', sh?.builtYear, null);

  console.log('');
  console.log('── 전세 / 이상값 ────────────────────────────');
  const jeonse = mapItem(JEONSE_ITEM, slot('apt'));
  check('전세는 월세 0', jeonse?.monthlyRent, 0);
  check('전세 보증금', jeonse?.deposit, 950_000_000);

  // 보증금이 없는 임대차는 성립하지 않는다. 파싱 실패로 보고 버려야 한다.
  check('보증금 없으면 버림', mapItem({ ...APT_ITEM, deposit: '' }, slot('apt')), null);
}

function main(): void {
  console.log('실거래가 파싱 회귀 테스트\n');
  testMoney();
  testMapping();

  console.log('');
  if (failures > 0) {
    console.error(`${failures}개 항목 실패`);
    process.exitCode = 1;
  } else {
    console.log('모든 항목 통과');
  }
}

main();
