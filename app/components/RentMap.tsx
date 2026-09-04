'use client';

import { useEffect, useRef } from 'react';
import {
  Map as MlMap,
  NavigationControl,
  Popup,
  ScaleControl,
  setWorkerUrl,
  type GeoJSONSource,
  type MapLayerMouseEvent,
} from 'maplibre-gl';
import type { Point } from 'geojson';
import type { AreaInfo, BuildingPoint } from '../lib/types';
import { HOUSING_LABEL_SHORT, formatManwon, toPyeong } from '../lib/types';
import { buildListingLinks } from '../../src/lib/listing-links';

/**
 * 시세 지도.
 *
 * 렌더링 원칙 두 가지.
 *
 * 1) 색은 **금액 하나**에만 쓴다. 유형·거리·거래량까지 색으로 나누면 지도가
 *    읽히지 않는다. 유형은 필터로, 거리는 위치로 이미 표현된다.
 *
 * 2) **통근 계산 불가 건물은 회색 + 점선 테두리**로 분리한다. 단독·다가구는
 *    법정동 중심점이라 위치가 실제 건물이 아니다. 같은 모양으로 그리면 지도가
 *    조용히 거짓말을 한다. 사용자가 "이건 대략적인 값" 임을 보게 만든다.
 */
// 다크(관제센터 톤) 배경 타일. OpenFreeMap이 liberty/bright/positron 외에 dark도 제공한다.
const TILE_STYLE = 'https://tiles.openfreemap.org/styles/dark';
const SOURCE_ID = 'buildings';
const ORIGIN_SOURCE = 'origin';

// 매물 검색 딥링크 버튼. 3개 사이트 URL이 전부 깨져 있어 꺼둔 상태다.
// TODO.md 6장 참고 — 재조사 후 다시 켤 것.
const SHOW_LISTING_LINKS = false;

// MapLibre는 워커 스크립트 위치를 import.meta.url로 자동 계산하는데, webpack
// 번들 안에서는 그 값이 실제 URL이 아니라서 워커가 빈 URL로 뜬다 — 결국 현재
// 페이지 HTML을 모듈 스크립트로 읽으려다 죽는다(콘솔의 "non-JavaScript MIME
// type of text/html" 에러). /api/maplibre-worker 로 직접 지정해 우회한다.
setWorkerUrl('/api/maplibre-worker');

interface Props {
  origin: { lon: number; lat: number } | null;
  /** 검색에 사용된 통근권. 등시선이거나(정상) 직선 반경이다(엔진 미가동). */
  area: AreaInfo | null;
  buildings: BuildingPoint[];
  mode: 'wolse' | 'jeonse';
}

/** 색 구간 경계(만원). 월세와 전세는 자릿수가 달라 따로 둔다. */
const BREAKS = {
  wolse: [40, 70, 100, 150],
  jeonse: [10_000, 20_000, 35_000, 60_000],
} as const;

export default function RentMap({ origin, area, buildings, mode }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const readyRef = useRef(false);
  // 클릭 핸들러는 지도 생성 시 한 번만 등록되므로, 최신 mode 값을 읽으려면 ref 가 필요하다.
  const modeRef = useRef(mode);
  modeRef.current = mode;

  // 지도 인스턴스는 한 번만 만든다. 필터가 바뀔 때마다 재생성하면 깜빡인다.
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = new MlMap({
      container: containerRef.current,
      style: TILE_STYLE,
      center: [126.978, 37.5665], // 서울시청. 첫 진입 화면
      zoom: 11,
      attributionControl: { compact: true },
      // 지도를 벗어난 회전은 방향 감각만 해친다.
      pitchWithRotate: false,
      dragRotate: false,
    });

    map.addControl(new NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(new ScaleControl({ unit: 'metric' }), 'bottom-left');

    map.on('load', () => {
      readyRef.current = true;

      map.addSource(ORIGIN_SOURCE, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      map.addSource(SOURCE_ID, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });

      // 통근권 영역. 등시선이면 실선, 직선 반경 폴백이면 점선으로 구분한다.
      // 사용자가 "이건 실제 통근시간이 아니라 근사" 임을 화면에서 알아야 한다.
      //
      // 색은 oklch()가 아니라 hex 다. MapLibre 의 paint 색상 파서는 CSS 브라우저
      // 파서가 아니라 자체 구현(csscolorparser 계열)이라 oklch() 를 못 읽는다
      // ("color expected, oklch(...) found" 로 레이어가 통째로 안 그려짐). 아래
      // hex 는 이 파일에 있던 oklch 값을 그대로 변환한 값이다.
      map.addLayer({
        id: 'area-fill',
        type: 'fill',
        source: ORIGIN_SOURCE,
        filter: ['!=', ['geometry-type'], 'Point'],
        paint: {
          'fill-color': '#22d3ee',
          'fill-opacity': ['case', ['get', 'degraded'], 0.06, 0.12],
        },
      });
      map.addLayer({
        id: 'area-line',
        type: 'line',
        source: ORIGIN_SOURCE,
        filter: ['!=', ['geometry-type'], 'Point'],
        paint: {
          'line-color': '#67e8f9',
          'line-width': ['case', ['get', 'degraded'], 1.5, 2],
          'line-dasharray': ['case', ['get', 'degraded'], ['literal', [3, 2]], ['literal', [1, 0]]],
          'line-opacity': ['case', ['get', 'degraded'], 0.6, 0.9],
        },
      });

      // 통근 계산 불가 건물을 먼저(아래에) 그려서 신뢰할 수 있는 값이 위로 오게 한다.
      map.addLayer({
        id: 'buildings-unreliable',
        type: 'circle',
        source: SOURCE_ID,
        filter: ['==', ['get', 'commuteUsable'], false],
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 5, 15, 9],
          'circle-color': '#8b96a3',
          'circle-opacity': 0.55,
          'circle-stroke-width': 1.5,
          'circle-stroke-color': '#4b5563',
          'circle-stroke-opacity': 0.8,
        },
      });

      map.addLayer({
        id: 'buildings-reliable',
        type: 'circle',
        source: SOURCE_ID,
        filter: ['==', ['get', 'commuteUsable'], true],
        paint: {
          // 거래가 많은 건물을 조금 크게. 표본 수가 신뢰도이므로 크기로 표현한다.
          'circle-radius': [
            'interpolate', ['linear'], ['zoom'],
            10, ['interpolate', ['linear'], ['get', 'deals'], 1, 4, 30, 7],
            15, ['interpolate', ['linear'], ['get', 'deals'], 1, 7, 30, 14],
          ],
          'circle-color': ['get', 'color'],
          'circle-opacity': 0.9,
          'circle-stroke-width': 1.25,
          // 어두운 지도 위라 옅은 시안 테두리로 도트에 halo 를 준다.
          'circle-stroke-color': 'rgba(207, 250, 254, 0.55)',
        },
      });

      map.addLayer({
        id: 'origin-marker',
        type: 'circle',
        source: ORIGIN_SOURCE,
        filter: ['==', ['geometry-type'], 'Point'],
        paint: {
          'circle-radius': 8,
          'circle-color': '#22d3ee',
          'circle-stroke-width': 3,
          'circle-stroke-color': '#083344',
        },
      });

      const popup = new Popup({ closeButton: false, offset: 12 });

      for (const layer of ['buildings-reliable', 'buildings-unreliable']) {
        map.on('mouseenter', layer, () => {
          map.getCanvas().style.cursor = 'pointer';
        });
        map.on('mouseleave', layer, () => {
          map.getCanvas().style.cursor = '';
          popup.remove();
        });
        map.on('click', layer, (e: MapLayerMouseEvent) => {
          const f = e.features?.[0];
          if (!f) return;
          popup
            .setLngLat((f.geometry as Point).coordinates as [number, number])
            .setHTML(popupHtml(f.properties as Record<string, unknown>, modeRef.current))
            .addTo(map);
        });
      }
    });

    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
      readyRef.current = false;
    };
  }, []);

  // 데이터 갱신
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const apply = () => {
      const src = map.getSource(SOURCE_ID) as GeoJSONSource | undefined;
      if (!src) return;
      src.setData({
        type: 'FeatureCollection',
        features: buildings.map((b) => ({
          type: 'Feature' as const,
          geometry: { type: 'Point' as const, coordinates: [b.lon, b.lat] },
          properties: {
            ...b,
            color: colorFor(mode === 'jeonse' ? b.deposit : b.rent, mode),
          },
        })),
      });

      const originSrc = map.getSource(ORIGIN_SOURCE) as GeoJSONSource | undefined;
      if (originSrc) {
        const features: GeoJSON.Feature[] = [];
        if (area) {
          features.push({
            type: 'Feature',
            geometry: area.geojson,
            properties: { degraded: area.kind === 'radius' },
          });
        }
        if (origin) {
          features.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [origin.lon, origin.lat] },
            properties: {},
          });
        }
        originSrc.setData({ type: 'FeatureCollection', features });
      }
    };

    if (readyRef.current) apply();
    else map.once('load', apply);
  }, [buildings, origin, area, mode]);

  // 통근권이 바뀌면 그 영역이 화면에 들어오게 한다.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !area) return;
    const b = boundsOf(area.geojson);
    if (!b) return;
    map.fitBounds(b, { padding: 56, duration: 700, maxZoom: 15 });
  }, [area]);

  return <div ref={containerRef} className="h-full w-full" />;
}

// hex 다. MapLibre paint 색상 파서는 oklch() 를 못 읽는다 — 위 addLayer 주석 참고.
// 이 색은 GeoJSON feature property 로 들어가 'circle-color': ['get', 'color'] 로
// 쓰이므로(buildings-reliable 레이어) 여기서도 hex 여야 한다.
function colorFor(value: number | null, mode: 'wolse' | 'jeonse'): string {
  if (value === null) return '#8b96a3';
  const breaks = BREAKS[mode];
  const palette = [
    '#3be1e1', // oklch(0.83 0.13 195)
    '#1fc893', // oklch(0.74 0.15 165)
    '#c4a200', // oklch(0.72 0.16 95)
    '#e97300', // oklch(0.68 0.18 55)
    '#de3b3d', // oklch(0.6 0.2 25)
  ];
  let i = 0;
  while (i < breaks.length && value > breaks[i]!) i++;
  return palette[i]!;
}

/**
 * 폴리곤의 경계 상자.
 *
 * 등시선은 원이 아니라 도로망을 따라 불규칙하게 뻗은 모양이라 반경으로는
 * 화면을 맞출 수 없다. 좌표를 직접 훑는다.
 */
function boundsOf(
  g: GeoJSON.Polygon | GeoJSON.MultiPolygon,
): [[number, number], [number, number]] | null {
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;

  const rings = g.type === 'Polygon' ? g.coordinates : g.coordinates.flat();
  for (const ring of rings) {
    for (const [lon, lat] of ring as [number, number][]) {
      if (lon < minLon) minLon = lon;
      if (lat < minLat) minLat = lat;
      if (lon > maxLon) maxLon = lon;
      if (lat > maxLat) maxLat = lat;
    }
  }

  if (!Number.isFinite(minLon)) return null;
  return [
    [minLon, minLat],
    [maxLon, maxLat],
  ];
}

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function popupHtml(p: Record<string, unknown>, mode: 'wolse' | 'jeonse'): string {
  const type = HOUSING_LABEL_SHORT[p.type as keyof typeof HOUSING_LABEL_SHORT] ?? String(p.type);
  const name = p.name ? esc(p.name) : `${esc(p.dong)} ${type}`;
  const deposit = formatManwon(p.deposit as number | null);
  const rent = p.rent ? formatManwon(p.rent as number | null) : null;
  const area = p.area as number | null;
  const dist = Math.round((p.distM as number) / 100) / 10;

  // 정확도 낮은 좌표는 그 사실을 팝업에도 명시한다. 화면에서만 회색으로
  // 구분하면 사용자가 이유를 모른다.
  const warn = p.commuteUsable
    ? ''
    : `<div class="mt-1.5 rounded bg-amber-400/10 px-1.5 py-1 text-[11px] leading-snug text-amber-300 border border-amber-400/20">
         정확한 위치가 공개되지 않는 유형입니다. <b>${esc(p.dong)} 일대</b>의 시세로 보세요.
       </div>`;

  // 실거래가는 과거 거래 기록이지 지금 나와 있는 매물이 아니다. 지역·건물을
  // 좁혀준 뒤 실제 매물 검색은 부동산 서비스로 넘긴다 — 다만 지금은 꺼져 있다.
  // 2026-09-04에 실제 브라우저로 확인해보니 네이버부동산·직방·다방 URL 빌더
  // 3개가 전부 깨져 있었다(사이트들이 검색어 기반 딥링크에서 자체 지도앱/
  // 자동완성 흐름으로 바뀐 걸로 보임). listing-links.ts는 그대로 두고 버튼만
  // 숨긴다 — TODO.md 6장에 원인과 재조사 항목을 남겨뒀다.
  const links = SHOW_LISTING_LINKS
    ? buildListingLinks({
        name: p.name as string | null,
        sido: p.sido as string | null,
        sigungu: p.sigungu as string | null,
        legalDong: p.dong as string | null,
        housingType: p.type as BuildingPoint['type'],
        mode,
      })
    : [];
  const linkButtons = links.length
    ? `<div class="mt-2 flex flex-wrap gap-1 border-t border-cyan-400/15 pt-1.5">
         ${links
           .map(
             (l) =>
               `<a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer"
                   class="rounded bg-cyan-400/10 px-1.5 py-0.5 text-[11px] text-cyan-200 hover:bg-cyan-400/20">
                  ${esc(l.label)}
                </a>`,
           )
           .join('')}
       </div>`
    : '';

  return `
    <div class="min-w-44">
      <div class="text-[13px] font-semibold leading-tight text-neutral-50">${name}</div>
      <div class="mt-0.5 text-[11px] text-neutral-400">${type} · ${esc(p.dong)} · ${dist}km</div>
      <div class="mt-2 text-[13px] font-medium text-cyan-100">
        ${deposit}${rent ? ` / ${rent}` : ' <span class="text-neutral-400">전세</span>'}
      </div>
      <div class="mt-1 text-[11px] text-neutral-400">
        ${area ? `${area}㎡ (${toPyeong(area)}) · ` : ''}거래 ${esc(p.deals)}건
        ${p.builtYear ? ` · ${esc(p.builtYear)}년` : ''}
      </div>
      ${warn}
      ${linkButtons}
    </div>`;
}
