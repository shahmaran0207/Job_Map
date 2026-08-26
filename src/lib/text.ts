import { sanitizeText } from './security.ts';

/** 상호 정규화. 국민연금 사업장 데이터와 조인하기 위한 키를 만든다. */
export function normalizeCompanyName(raw: string): string {
  return raw
    .replace(/\(\s*(주|유|재|사|합|영)\s*\)/g, '')
    .replace(/주식회사|유한회사|유한책임회사|합자회사|합명회사|사단법인|재단법인|의료법인|학교법인/g, '')
    .replace(/[\s ]+/g, '')
    .replace(/[.,·・‧'"`~!@#$%^&*()\-_=+[\]{}|\\/:;<>?]/g, '')
    .toLowerCase()
    .trim();
}

/** '3,000만원' '30000000' '3000' 같은 잡다한 급여 표기를 원 단위 정수로 밀어넣는다. */
export function parseSalary(raw: string | undefined | null): number | null {
  if (!raw) return null;
  const s = String(raw).replace(/,/g, '').trim();
  const m = s.match(/(\d+(?:\.\d+)?)\s*(억|천만|만원|만|원)?/);
  if (!m?.[1]) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n === 0) return null;
  const won = (() => {
    switch (m[2]) {
      case '억':
        return n * 100_000_000;
      case '천만':
        return n * 10_000_000;
      case '만원':
      case '만':
        return n * 10_000;
      default:
        // 단위 없는 값: 워크넷은 보통 원 단위 연봉을 그대로 준다.
        // 4자리 이하면 '만원 단위 표기'로 보는 편이 오차가 적다 (예: 3000 -> 3000만원).
        return n < 100_000 ? n * 10_000 : n;
    }
  })();

  // salary_min/max 는 integer 컬럼이다. 이상값이 들어오면 INSERT 가 터지면서
  // 배치 전체가 실패하므로 여기서 잘라낸다. 20억 원 이상은 연봉으로 무의미하다.
  if (won <= 0) return null;
  return Math.round(Math.min(won, 2_000_000_000));
}

/** 'YYYYMMDD' | 'YYYY-MM-DD' | 'YYYY/MM/DD' -> 'YYYY-MM-DD' */
export function parseDate(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const s = String(raw).trim();
  const digits = s.replace(/\D/g, '');
  if (digits.length !== 8) return null;
  const y = digits.slice(0, 4);
  const m = digits.slice(4, 6);
  const d = digits.slice(6, 8);
  const month = Number(m);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${y}-${m}-${d}`;
}

/** 경력 요구사항 문자열에서 최소 연차를 뽑는다. '경력 3년 이상' -> 3, '신입' -> 0 */
export function parseCareerYears(raw: string | undefined | null): number | null {
  if (!raw) return null;
  const s = String(raw);
  if (/신입|무관|관계없음/.test(s) && !/\d/.test(s)) return 0;
  const m = s.match(/(\d+)\s*년/);
  return m?.[1] ? Number(m[1]) : null;
}

/**
 * 외부 입력 문자열의 단일 정규화 지점.
 *
 * 모든 수집기가 필드를 읽을 때 이 함수를 통과하므로, 여기서 정제하면
 * 새 수집기를 추가할 때 정제를 빼먹는 실수가 구조적으로 불가능해진다.
 * (태그 제거 + 제어/제로폭/양방향 문자 제거 + 길이 상한)
 */
export function clean(v: unknown, maxLen = 1000): string | null {
  if (v === null || v === undefined) return null;
  return sanitizeText(String(v), maxLen);
}
