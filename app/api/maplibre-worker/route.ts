import { serveMaplibreAsset } from '../../../src/lib/maplibre-asset';

/**
 * MapLibre GL 워커 스크립트를 그대로 내려준다.
 *
 * MapLibre는 자신의 워커 URL을 `import.meta.url` 기준으로 자동 계산한다
 * (`maplibre-gl-dev.mjs`의 `defaultWorkerUrl()`). 이 값은 webpack 번들
 * 안에서는 실제 fetch 가능한 URL이 아니어서 빈 문자열이 되고, 그 결과
 * `new Worker('')`가 **현재 페이지 HTML을 모듈 스크립트로 로드**하려다
 * "non-JavaScript MIME type of text/html" 에러로 죽는다 — 지도가 컨트롤만
 * 뜨고 타일은 하나도 안 그려지던 증상의 원인이다.
 *
 * `maplibregl.setWorkerUrl()`로 이 라우트를 직접 가리키면 우회된다.
 * node_modules 파일을 빌드 시점에 public/ 로 복사하는 대신 여기서 그대로
 * 스트리밍한다 — 패키지 버전이 바뀌어도 복사본이 안 낡는다.
 *
 * 이 워커 스크립트는 내부에서 `./maplibre-gl-shared.mjs`를 상대 경로로
 * import한다. 이 라우트의 URL(`/api/maplibre-worker`)을 기준으로 그 경로가
 * `/api/maplibre-gl-shared.mjs`로 풀리므로, 그 이름 그대로 라우트를
 * 하나 더 두었다(`app/api/maplibre-gl-shared.mjs/route.ts`).
 */
export const runtime = 'nodejs';
export const dynamic = 'force-static';

export async function GET(): Promise<Response> {
  return serveMaplibreAsset('maplibre-gl-worker.mjs');
}
