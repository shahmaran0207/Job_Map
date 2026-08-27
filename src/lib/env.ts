import 'dotenv/config';

function opt(name: string): string | undefined {
  const v = process.env[name];
  return v && v.length > 0 ? v : undefined;
}

function req(name: string): string {
  const v = opt(name);
  if (!v) throw new Error(`환경변수 ${name} 가 설정되지 않았습니다. .env 를 확인하세요.`);
  return v;
}

/**
 * 숫자 환경변수를 관대하게 읽는다.
 *
 * `.env` 에 `COLLECT_MAX_PAGES=0  # 0 = 무제한` 처럼 인라인 주석을 쓰면 dotenv
 * 버전에 따라 주석이 값에 섞여 들어오고, Number() 가 NaN 이 된다. 그러면 수집
 * 페이지 상한이 조용히 깨져 데이터가 누락된다. 첫 정수만 뽑아 쓰고, 못 찾으면
 * 기본값으로 떨어진다.
 */
function num(name: string, fallback: number): number {
  const raw = opt(name);
  if (!raw) return fallback;
  const m = raw.match(/-?\d+/);
  if (!m) return fallback;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : fallback;
}

/** DATABASE_URL 을 파싱한다. 실패 시에도 접속 문자열(비밀번호 포함)을 에러에 담지 않는다. */
function parseDbUrl(): URL {
  try {
    return new URL(req('DATABASE_URL'));
  } catch {
    throw new Error('DATABASE_URL 형식이 올바르지 않습니다. (값은 로그에 남기지 않습니다)');
  }
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export const env = {
  get databaseUrl() {
    return req('DATABASE_URL');
  },
  get databaseHost() {
    return parseDbUrl().hostname;
  },
  get databaseIsLocal() {
    return LOCAL_HOSTS.has(parseDbUrl().hostname);
  },
  /** 'require'(기본) | 'disable'(localhost 전용) */
  get databaseSslMode() {
    return opt('DATABASE_SSL') === 'disable' ? 'disable' : 'require';
  },

  // 고용24 오픈API 는 API 별로 인증키가 따로 발급된다. 하나의 계정 키로
  // 모든 API 를 호출할 수 없으므로 용도별로 분리해 보관한다.
  get worknetKey() {
    return req('WORKNET_API_KEY'); // '채용정보' API 키
  },
  /** '공통코드' API 키. 직종/지역 코드 마스터 적재에 쓴다. 없으면 해당 단계만 건너뛴다. */
  get worknetCodeKey() {
    return opt('WORKNET_CODE_API_KEY');
  },
  /**
   * 채용정보 API 엔드포인트 계열.
   *   'work24' — 고용24 신규 포털. 기업·기관회원 전용
   *   'legacy' — 구 워크넷 엔드포인트. 공공데이터포털 발급 키로 개인도 사용 가능
   * 기본값은 legacy 다. 개인 개발자가 실제로 받을 수 있는 키가 그쪽이기 때문이다.
   */
  get worknetFlavor(): 'work24' | 'legacy' {
    return opt('WORKNET_API_FLAVOR') === 'work24' ? 'work24' : 'legacy';
  },
  get kakaoRestKey() {
    return opt('KAKAO_REST_KEY');
  },

  /**
   * 공공데이터포털 인증키(일반 인증키 / Decoding).
   *
   * 고용24와 달리 공공데이터포털은 **계정당 키 1개를 모든 API 에 공용**으로 쓴다.
   * 국토부 실거래가 4종(아파트/오피스텔/연립다세대/단독다가구)이 이 키 하나로 동작한다.
   *
   * Encoding 키를 넣으면 URLSearchParams 가 다시 인코딩해 이중 인코딩이 되고
   * 인증이 실패한다. 반드시 Decoding 키를 넣어야 한다.
   */
  get molitKey() {
    return req('MOLIT_API_KEY');
  },

  // 자체 호스팅 라우팅 엔진. 엔진 자체에는 인증 기능이 없으므로
  // 반드시 인증 프록시 뒤에 두고 이 토큰을 붙여 호출한다. (docker/ 참고)
  routingUrl: opt('ROUTING_URL'),
  get routingToken() {
    return opt('ROUTING_TOKEN');
  },

  collectMaxPages: num('COLLECT_MAX_PAGES', 0),
  geocodeDailyLimit: num('GEOCODE_DAILY_LIMIT', 50_000),

  isProduction: process.env.NODE_ENV === 'production',
};

/** 수집 기준일(KST). 자정 근처 실행이 이틀에 걸쳐 갈라지지 않도록 한 번만 계산해 재사용한다. */
export function today(): string {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' }); // YYYY-MM-DD
}

/**
 * 로그·에러에 비밀값이 새지 않도록 마스킹한다.
 * 수집기는 예외 메시지에 URL 을 담는 경우가 많고, 그 URL 에 API 키가 들어 있다.
 */
const SECRET_KEYS = ['authKey', 'apiKey', 'key', 'token', 'password', 'secret', 'KakaoAK'];

export function redact(input: string): string {
  let out = input;
  for (const k of SECRET_KEYS) {
    out = out.replace(new RegExp(`(${k}[=:\\s"']{1,3})[^&\\s"'}]+`, 'gi'), `$1***`);
  }
  return out;
}
