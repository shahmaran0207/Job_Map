# 보안 정책 및 위협 모델

이 프로젝트는 **외부에서 들어온 데이터를 대량으로 수집해 저장하고, 사용자의 집 위치를 입력받아 처리하며, 자체 호스팅 연산 엔진을 인터넷에 노출한다.** 세 가지 모두 공격 표면이므로 보안은 부가 기능이 아니라 설계 제약으로 다룬다.

## 0. 절대 규칙

리뷰에서 예외 없이 반려하는 항목이다.

1. `rejectUnauthorized: false` 또는 그에 준하는 TLS 검증 우회 금지
2. SQL 문자열 보간 금지 — 모든 쿼리는 파라미터 바인딩 (`$1, $2 …`)
3. `dangerouslySetInnerHTML` 금지 — 공고 본문은 저장 시점에 태그를 제거한다
4. 라우팅 엔진 포트에 직접 요청 금지 — 반드시 인증 프록시 경유 (`src/lib/routing.ts`)
5. 사용자 원좌표를 저장·캐시·로깅 금지 — `snapToCell()` 로 격자 스냅 후에만 (`src/lib/grid.ts`)
6. `KAKAO_REST_KEY` 를 클라이언트로 전달 금지 — 서버 사이드 전용
7. 비밀값을 저장소에 커밋 금지 — `.env`, `secrets/`, `*.pem` 은 `.gitignore` 처리됨
8. `fetch()` 직접 호출 금지 — `safeFetch()` 사용 (`src/lib/security.ts`)

---

## 1. 위협: SSRF (서버측 요청 위조)

**시나리오** — 2차 수집기(JSON-LD)는 임의 기업의 채용 페이지 URL로 요청을 보낸다. URL이 DB나 외부 데이터에서 오므로, 공격자가 `http://169.254.169.254/latest/meta-data/iam/security-credentials/` 를 심으면 서버가 클라우드 자격증명을 대신 읽어 온다. 내부망 스캔, `localhost` 관리 포트 접근도 같은 경로다.

**방어** (`src/lib/security.ts`)

- `safeFetch()` 를 유일한 외부 요청 경로로 둔다
- **호스트 allowlist** — 워크넷·Kakao 등 알려진 API는 호스트를 고정한다. DNS rebinding이 통하지 않는 가장 강한 방어다
- 임의 URL에는 `assertPublicHost()` — DNS로 해석한 **모든** A/AAAA 레코드를 사설·예약 대역과 대조한다. IPv4-mapped IPv6(`::ffff:10.0.0.1`)와 NAT64(`64:ff9b::`)로 내부 주소를 감싸는 우회도 재귀 검사한다
- **리다이렉트 기본 차단** (`maxRedirects: 0`). 허용해도 매 홉에서 호스트를 재검증한다. 리다이렉트는 allowlist를 우회하는 고전적 경로다
- HTTPS 강제 (예외: `localhost` 라우팅 엔진)
- 응답 크기 상한 + 스트림 읽는 중에도 재검사 (`Content-Length` 는 위조 가능)

**남은 위험** — DNS 검사 시점과 연결 시점 사이에 응답이 바뀌는 TOCTOU는 이 방식으로 완전히 막히지 않는다. 완전 차단에는 해석한 IP로 직접 연결하고 `Host` 헤더를 붙이는 커스텀 dispatcher가 필요하다. 그래서 임의 URL 수집기는 **allowlist가 아닌 유일한 경로**로 두고, 별도 격리 환경(자격증명이 없는 컨테이너)에서 실행하는 것을 전제로 한다.

## 2. 위협: 라우팅 엔진 무인증 노출 ← 이 프로젝트에서 가장 위험

**시나리오** — Valhalla와 OTP2에는 **인증 기능이 전혀 없다.** 배포 계획은 개발 PC의 Docker 엔진을 Cloudflare Tunnel로 노출하는 것이다. 터널 URL이 유출되면(브라우저 개발자 도구, 로그, 스크린샷) 누구나 무제한으로 등시선 계산을 시킬 수 있다. 등시선 1회는 CPU를 크게 쓰므로 이것은 곧 **당신 PC를 태우는 무료 연산 서비스**이고, 동시에 개발 PC가 인터넷에 노출된 상태다.

**방어** (`docker/`)

3중 계층으로 둔다.

| 계층 | 수단 | 막는 것 |
|---|---|---|
| 1 | Cloudflare Access (Zero Trust) 서비스 토큰 | 터널 URL만 아는 외부인 |
| 2 | nginx 프록시 — Bearer 토큰 + 레이트리밋(5r/s) + 경로 allowlist + 바디 64KB 제한 | 토큰 없는 요청, 폭주, 엔진 관리 엔드포인트 접근 |
| 3 | 엔진 포트를 호스트에 바인딩하지 않음 (`expose` 만) | 프록시 우회 |

추가로

- 프록시는 `read_only`, `cap_drop: ALL`, `no-new-privileges` 로 실행
- 엔진 컨테이너에 메모리 상한을 걸어 폭주가 호스트를 죽이지 못하게 한다
- 클라이언트의 `Authorization` 헤더는 엔진으로 전달하지 않는다 (`proxy_set_header Authorization ''`)
- 애플리케이션 측에서도 시간 값을 열거형으로 제한한다 (`assertAllowedMinutes`) — 임의 값으로 초대형 등시선을 요청하는 것을 막는다
- 좌표는 대한민국 경계 검사를 통과해야 엔진에 도달한다 (`assertKoreanCoord`)

## 3. 위협: 사용자 위치 = 민감 개인정보

**시나리오** — 사용자가 입력하는 출발지는 사실상 집 주소다. 개인정보보호법상 위치정보이고, 유출 시 피해가 크다. 캐시·로그·에러 리포팅에 좌표가 남으면 그것만으로 사고다.

**방어** (`src/lib/grid.ts`)

- 사용자 좌표는 **격자 스냅 후에만** 저장·캐시된다. 등시선 캐시 키는 `g500:<격자>` 형태이며 원좌표를 복원할 수 없다
- 원좌표는 요청 처리 중 메모리에서만 사용하고 어디에도 기록하지 않는다
- 로깅이 필요하면 `logSafeLocation()` 으로 2km 격자 키만 남긴다
- 로그인·계정을 도입하기 전까지 검색 이력을 서버에 저장하지 않는다. 도입 시에도 위치는 격자 단위로만 보관한다

## 4. 위협: 저장/렌더 경로의 인젝션

**시나리오** — 공고 제목·회사명·URL이 전부 외부 입력이고 결국 브라우저에 렌더된다.

**방어**

- **SQL 인젝션** — 모든 쿼리 파라미터 바인딩. 문자열 보간 없음
- **XSS** — `clean()` 이 모든 외부 문자열의 단일 관문이다. 태그·HTML 엔티티를 제거하고 길이를 제한한다. 새 수집기를 추가할 때 정제를 빼먹는 것이 구조적으로 불가능하도록 `clean()` 안에 넣었다
- **링크 스킴 XSS** — 공고 URL은 `safeExternalUrl()` 로 http/https만 통과. `javascript:`, `data:`, `vbscript:` 차단
- **트로이 소스 / 시각적 위장** — 양방향 제어문자(U+202A~E)와 제로폭 문자를 `stripInvisible()` 로 제거한다. 이것 없이는 화면에 보이는 회사명과 저장된 회사명을 다르게 만들어 사용자를 속일 수 있다
- **프로토타입 오염** — 외부 XML/JSON 파싱 결과에서 `__proto__`, `constructor`, `prototype` 키를 즉시 제거한다 (`stripDangerousKeys`). 파싱 결과를 재귀 순회하고 `jsonb` 로 저장하기 때문에 입력 단계에서 잘라내는 것이 유일하게 안전하다
- **저장 폭탄** — `capRawPayload()` 로 `raw` jsonb를 64KB로 제한한다

## 5. 위협: 비밀값 유출

**방어**

- `.env`, `secrets/`, `*.pem`, `*.key` 는 `.gitignore` 처리
- **gitleaks** 가 CI에서 전체 히스토리를 검사한다 (과거 커밋에 남은 키까지)
- 예외 메시지에서 URL 전체를 찍지 않는다. 쿼리스트링에 `authKey` 가 들어 있다
- `redact()` 로 로그에서 키·토큰·비밀번호 패턴을 마스킹한다
- `DATABASE_URL` 파싱 실패 시에도 값을 에러에 담지 않는다
- Kakao **REST 키는 서버 전용**. 프론트에는 도메인 제한이 걸린 JavaScript 키만 두고, 주소 검색은 Next.js API Route를 프록시로 사용한다

## 6. 위협: 공급망 공격

**방어**

- `npm ci --ignore-scripts` — 설치 스크립트를 실행하지 않는다. 의존성 하나가 오염되면 CI 시크릿이 유출되는 직통 경로다
- lockfile 커밋 + `npm audit --audit-level=high` 를 CI 게이트로
- Dependabot 주간 스캔 (npm / GitHub Actions / Docker)
- CodeQL `security-extended` 정적 분석
- 의존성을 최소로 유지한다. 현재 런타임 의존성은 `pg`, `fast-xml-parser`, `dotenv` 3개다

## 7. 위협: DB 연결 및 권한

**방어**

- TLS 검증 필수. CA 인증서를 명시적으로 주입하고, 없으면 **연결을 거부한다**. 검증 우회 플래그는 제공하지 않는다 (`DATABASE_SSL=disable` 은 localhost 연결에서만 동작)
- `statement_timeout` / `query_timeout` 60초 — 매달린 쿼리가 커넥션 풀을 고갈시키는 것을 막는다
- 커넥션 풀 상한 4 — 무료 티어 연결 소진 방지
- **Supabase 를 프론트엔드에 직접 노출하지 않는다.** anon 키 + RLS 조합보다, 모든 접근을 Next.js API Route를 통과시키는 편이 공격 표면이 작다. 프론트는 Supabase 존재를 모른다
- 향후 읽기 전용 API용 DB 롤을 분리한다 (`SELECT` 만 가능한 롤)

## 8. 위협: API 남용 / 비용 공격

무료 티어로 운영하므로 쿼터 소진 자체가 서비스 중단이다.

**방어**

- 라우팅 프록시 레이트리밋 (계층 2)
- 등시선 영구 캐시 — 같은 격자 재요청은 엔진을 건드리지 않는다
- 지오코딩을 수집 루프에서 분리하고 일일 상한을 둔다. Kakao 쿼터가 소진되어도 수집(=시계열)은 멈추지 않는다
- 허용 시간 값 열거 제한으로 초대형 등시선 요청 차단
- 향후 공개 API에 IP 기준 레이트리밋 + 캐시 헤더 적용

## 9. 프론트엔드 (구현 예정 시 적용)

- CSP: `default-src 'self'`, `script-src` 에 `unsafe-inline`/`unsafe-eval` 금지, 지도 타일 도메인만 `img-src`/`connect-src` 허용
- `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`
- 상태 변경 요청에 CSRF 방어 (SameSite=Strict 쿠키 + Origin 검증)
- 외부 링크에 `rel="noopener noreferrer"`
- 소스맵을 프로덕션에 배포하지 않는다

## 10. 취약점 신고

보안 문제를 발견하면 공개 이슈를 열지 말고 저장소 소유자에게 직접 연락한다.
