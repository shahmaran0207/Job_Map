import { readFile } from 'node:fs/promises';
import path from 'node:path';

/** maplibre-gl의 워커 산출물(`dist/*.mjs`)을 그대로 스트리밍한다. 서빙 경로별 route.ts가 공유한다. */
export async function serveMaplibreAsset(filename: string): Promise<Response> {
  const file = await readFile(
    path.join(process.cwd(), 'node_modules/maplibre-gl/dist', filename),
  );
  return new Response(file, {
    headers: {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
}
