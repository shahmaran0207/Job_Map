'use client';

import { useEffect, useRef } from 'react';
import {
  Map as MlMap,
  NavigationControl,
  Popup,
  ScaleControl,
  type GeoJSONSource,
  type MapLayerMouseEvent,
} from 'maplibre-gl';
import type { Point, Polygon } from 'geojson';
import type { BuildingPoint } from '../lib/types';
import { HOUSING_LABEL_SHORT, formatManwon, toPyeong } from '../lib/types';

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
const TILE_STYLE = 'https://tiles.openfreemap.org/styles/liberty';
const SOURCE_ID = 'buildings';
const ORIGIN_SOURCE = 'origin';

interface Props {
  origin: { lon: number; lat: number } | null;
  radius: number;
  buildings: BuildingPoint[];
  mode: 'wolse' | 'jeonse';
}

/** 색 구간 경계(만원). 월세와 전세는 자릿수가 달라 따로 둔다. */
const BREAKS = {
  wolse: [40, 70, 100, 150],
  jeonse: [10_000, 20_000, 35_000, 60_000],
} as const;

export default function RentMap({ origin, radius, buildings, mode }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const readyRef = useRef(false);

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

      // 검색 반경. 지금은 직선 반경이며 라우팅 엔진이 붙으면 등시선으로 교체된다.
      map.addLayer({
        id: 'origin-radius',
        type: 'fill',
        source: ORIGIN_SOURCE,
        filter: ['==', ['geometry-type'], 'Polygon'],
        paint: {
          'fill-color': 'oklch(0.55 0.18 265)',
          'fill-opacity': 0.07,
        },
      });
      map.addLayer({
        id: 'origin-radius-line',
        type: 'line',
        source: ORIGIN_SOURCE,
        filter: ['==', ['geometry-type'], 'Polygon'],
        paint: {
          'line-color': 'oklch(0.55 0.18 265)',
          'line-width': 1.5,
          'line-dasharray': [3, 2],
          'line-opacity': 0.5,
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
          'circle-color': 'oklch(0.65 0.02 260)',
          'circle-opacity': 0.5,
          'circle-stroke-width': 1.5,
          'circle-stroke-color': 'oklch(0.45 0.02 260)',
          'circle-stroke-opacity': 0.7,
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
          'circle-opacity': 0.85,
          'circle-stroke-width': 1,
          'circle-stroke-color': 'oklch(1 0 0 / 0.75)',
        },
      });

      map.addLayer({
        id: 'origin-marker',
        type: 'circle',
        source: ORIGIN_SOURCE,
        filter: ['==', ['geometry-type'], 'Point'],
        paint: {
          'circle-radius': 8,
          'circle-color': 'oklch(0.5 0.2 265)',
          'circle-stroke-width': 3,
          'circle-stroke-color': 'oklch(1 0 0)',
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
            .setHTML(popupHtml(f.properties as Record<string, unknown>))
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
        originSrc.setData({
          type: 'FeatureCollection',
          features: origin
            ? [
                {
                  type: 'Feature',
                  geometry: { type: 'Point', coordinates: [origin.lon, origin.lat] },
                  properties: {},
                },
                {
                  type: 'Feature',
                  geometry: circlePolygon(origin.lon, origin.lat, radius),
                  properties: {},
                },
              ]
            : [],
        });
      }
    };

    if (readyRef.current) apply();
    else map.once('load', apply);
  }, [buildings, origin, radius, mode]);

  // 검색 위치가 바뀌면 그 반경이 화면에 들어오게 한다.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !origin) return;
    const deg = radius / 111_000;
    map.fitBounds(
      [
        [origin.lon - deg * 1.4, origin.lat - deg],
        [origin.lon + deg * 1.4, origin.lat + deg],
      ],
      { padding: 48, duration: 700 },
    );
  }, [origin, radius]);

  return <div ref={containerRef} className="h-full w-full" />;
}

function colorFor(value: number | null, mode: 'wolse' | 'jeonse'): string {
  if (value === null) return 'oklch(0.65 0.02 260)';
  const breaks = BREAKS[mode];
  const palette = [
    'oklch(0.83 0.13 195)',
    'oklch(0.74 0.15 165)',
    'oklch(0.72 0.16 95)',
    'oklch(0.68 0.18 55)',
    'oklch(0.6 0.2 25)',
  ];
  let i = 0;
  while (i < breaks.length && value > breaks[i]!) i++;
  return palette[i]!;
}

/** 반경 원을 폴리곤으로. 위도에 따른 경도 축소를 반영한다. */
function circlePolygon(lon: number, lat: number, radiusM: number): Polygon {
  const steps = 72;
  const dLat = radiusM / 111_320;
  const dLon = radiusM / (111_320 * Math.cos((lat * Math.PI) / 180));
  const ring: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * 2 * Math.PI;
    ring.push([lon + dLon * Math.cos(a), lat + dLat * Math.sin(a)]);
  }
  return { type: 'Polygon', coordinates: [ring] };
}

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function popupHtml(p: Record<string, unknown>): string {
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
    : `<div class="mt-1.5 rounded bg-amber-50 px-1.5 py-1 text-[11px] leading-snug text-amber-900">
         정확한 위치가 공개되지 않는 유형입니다. <b>${esc(p.dong)} 일대</b>의 시세로 보세요.
       </div>`;

  return `
    <div class="min-w-44">
      <div class="text-[13px] font-semibold leading-tight">${name}</div>
      <div class="mt-0.5 text-[11px] text-neutral-500">${type} · ${esc(p.dong)} · ${dist}km</div>
      <div class="mt-2 text-[13px] font-medium">
        ${deposit}${rent ? ` / ${rent}` : ' <span class="text-neutral-500">전세</span>'}
      </div>
      <div class="mt-1 text-[11px] text-neutral-500">
        ${area ? `${area}㎡ (${toPyeong(area)}) · ` : ''}거래 ${esc(p.deals)}건
        ${p.builtYear ? ` · ${esc(p.builtYear)}년` : ''}
      </div>
      ${warn}
    </div>`;
}
