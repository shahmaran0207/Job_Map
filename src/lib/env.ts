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

  get worknetKey() {
    return req('WORKNET_API_KEY');
  },
  get kakaoRestKey() {
    return opt('KAKAO_REST_KEY');
  },

  // 자체 호스팅 라우팅 엔진. 엔진 자체에는 인증 기능이 없으므로
  // 반드시 인증 프록시 뒤에 두고 이 토큰을 붙여 호출한다. (docker/ 참고)
  routingUrl: opt('ROUTING_URL'),
  get routingToken() {
    return opt('ROUTING_TOKEN');
  },

  collectMaxPages: Number(opt('COLLECT_MAX_PAGES') ?? 0),
  geocodeDailyLimit: Number(opt('GEOCODE_DAILY_LIMIT') ?? 50_000),

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
