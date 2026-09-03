import { serveMaplibreAsset } from '../../../src/lib/maplibre-asset';

/** `/api/maplibre-worker`가 상대 경로(`./maplibre-gl-shared.mjs`)로 import하는 공용 청크. */
export const runtime = 'nodejs';
export const dynamic = 'force-static';

export async function GET(): Promise<Response> {
  return serveMaplibreAsset('maplibre-gl-shared.mjs');
}
