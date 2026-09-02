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
 * ⚠️ URL 형식은 프로그램으로 검증하지 못했다(해당 도메인 fetch 차단).
 * 그래서 빌더를 여기 한 곳에 모았다. 형식이 바뀌거나 틀렸으면 이 파일만 고치면
 * 된다. `npm run check:deeplinks` 가 실제 URL 을 출력하므로 클릭해서 확인할 것.
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
  url: string;
  /** 이 URL 형식을 사람이 클릭해 확인했는가. check:deeplinks 로 검증 후 true 로 올린다. */
  verified: boolean;
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

/**
 * 서비스별 URL 빌더.
 *
 * 지도 상태(좌표·줌)를 URL 에 담는 방식은 서비스가 바뀔 때 가장 먼저 깨진다.
 * 그래서 **검색어 기반**을 택했다. 정밀도는 조금 낮지만 훨씬 오래 간다.
 */
const BUILDERS: Record<ListingProvider, (q: string) => string> = {
  naver: (q) => `https://m.land.naver.com/search/result/${encodeURIComponent(q)}`,
  zigbang: (q) => `https://www.zigbang.com/search?q=${encodeURIComponent(q)}`,
  dabang: (q) => `https://www.dabangapp.com/search?search=${encodeURIComponent(q)}`,
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
    url: BUILDERS[provider](q),
    // 클릭 확인 전까지 false. check:deeplinks 참고.
    verified: false,
  }));
}

/** 진단 스크립트가 쓰는 전체 목록. */
export function allProviders(): ListingProvider[] {
  return Object.keys(BUILDERS) as ListingProvider[];
}

export function buildFor(provider: ListingProvider, query: string): string {
  return BUILDERS[provider](query);
}

export function providerLabel(provider: ListingProvider): string {
  return PROVIDER_LABEL[provider];
}
