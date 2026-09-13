import type { HousingType } from '../collectors/molit-types';

/**
 * 매물 검색 딥링크.
 *
 * 이 프로젝트는 개별 매물을 갖지 않는다. 실거래가는 **과거 거래 기록**이지
 * 현재 매물이 아니기 때문이다. 대신 통근권과 예산으로 지역·건물을 좁혀준 뒤
 * 실제 매물은 부동산 서비스로 넘긴다.
 *
 * 이 구조의 값:
 *   - 크롤링이 0이다. 판례 리스크를 파이프라인에 심지 않는다
 *   - 수익 모델(부동산 리드)과 같은 구조다. 사용자가 통근권과 예산을 확정한
 *     **직후**의 트래픽이 부동산 업계에서 가장 값이 높다
 *
 * ⚠️ 검색어를 URL에 실어 자동 검색시키는 방식은 안 쓴다. 2026-09-04, 2026-09-13
 * 두 번에 걸쳐 네이버부동산·직방·다방 3곳을 사람이 직접 열어서 확인했는데
 * 셋 다 검색어를 실제로 적용하지 못했다(네이버는 일반 지도만 뜸, 직방은
 * "결과 없음", 다방은 홈으로 튕김) — 세 사이트 다 검색어 기반 딥링크
 * 자체를 없앤 것으로 보인다. 그래서 대신 **검색어를 클립보드에 복사 + 홈
 * 링크를 새 탭으로 열기**로 축소했다. 사이트 내부 검색 API가 어떻게 바뀌든
 * "홈페이지가 있고 검색창이 있다"는 사실만 있으면 되므로 계속 동작한다.
 */
export type ListingProvider = 'naver' | 'zigbang' | 'dabang';

export interface ListingLinkInput {
  /** 단지·건물명. 없으면 법정동으로 검색한다(단독다가구 등). */
  name: string | null;
  sido: string | null;
  sigungu: string | null;
  legalDong: string | null;
  housingType: HousingType;
  mode: 'wolse' | 'jeonse';
}

export interface ListingLink {
  provider: ListingProvider;
  label: string;
  /** 새 탭으로 열 홈/앱 URL. 검색 결과 페이지가 아니라 홈이다. */
  homeUrl: string;
  /** 클립보드에 복사해서 사용자가 그 사이트 검색창에 직접 붙여넣을 검색어. */
  query: string;
}

const PROVIDER_LABEL: Record<ListingProvider, string> = {
  naver: '네이버부동산',
  zigbang: '직방',
  dabang: '다방',
};

/**
 * 검색어를 만든다.
 *
 * 건물명이 있으면 그것이 가장 정확하다. 다만 단독/다가구는 건물명이 없고,
 * 연립다세대는 건물명이 지번 숫자인 경우가 있어(실측 확인) 그럴 때는 지역명으로
 * 떨어뜨린다. 숫자만 있는 이름으로 검색하면 엉뚱한 결과가 나온다.
 */
export function buildSearchQuery(input: ListingLinkInput): string {
  const region = [input.sigungu, input.legalDong].filter(Boolean).join(' ');
  const name = input.name?.trim();

  const usableName = name && !/^\d+(-\d+)?$/.test(name) ? name : null;
  if (usableName) return `${region} ${usableName}`.trim();
  return region || [input.sido, input.sigungu].filter(Boolean).join(' ');
}

/** 서비스별 홈/앱 URL. 검색어를 안 실으므로 항상 유효하다. */
const HOME_URLS: Record<ListingProvider, string> = {
  naver: 'https://fin.land.naver.com/',
  zigbang: 'https://www.zigbang.com/',
  dabang: 'https://www.dabangapp.com/',
};

/**
 * 서비스별로 취급 매물이 다르다. 아파트를 직방에서 찾는 사람은 드물고,
 * 원룸을 네이버부동산에서 찾는 사람도 적다. 유형에 맞는 곳만 보여준다.
 */
const PROVIDERS_BY_TYPE: Record<HousingType, ListingProvider[]> = {
  apt: ['naver'],
  offi: ['naver', 'zigbang', 'dabang'],
  rh: ['naver', 'zigbang', 'dabang'],
  sh: ['zigbang', 'dabang'],
};

export function buildListingLinks(input: ListingLinkInput): ListingLink[] {
  const q = buildSearchQuery(input);
  if (!q) return [];

  return PROVIDERS_BY_TYPE[input.housingType].map((provider) => ({
    provider,
    label: PROVIDER_LABEL[provider],
    homeUrl: HOME_URLS[provider],
    query: q,
  }));
}

/** 진단 스크립트가 쓰는 전체 목록. */
export function allProviders(): ListingProvider[] {
  return Object.keys(HOME_URLS) as ListingProvider[];
}

export function homeUrlFor(provider: ListingProvider): string {
  return HOME_URLS[provider];
}

export function providerLabel(provider: ListingProvider): string {
  return PROVIDER_LABEL[provider];
}
