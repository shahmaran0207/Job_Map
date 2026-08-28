/** 주택 유형. 실거래가 API 가 유형별로 나뉘어 있다. */
export type HousingType = 'apt' | 'offi' | 'rh' | 'sh';

export const HOUSING_TYPES: HousingType[] = ['apt', 'offi', 'rh', 'sh'];

export const HOUSING_LABEL: Record<HousingType, string> = {
  apt: '아파트',
  offi: '오피스텔',
  rh: '연립다세대',
  sh: '단독다가구',
};

/**
 * 유형이 달라도 적재 코드는 하나만 유지하기 위한 공통 계약.
 * 채용 축의 NormalizedPosting 과 같은 역할이다.
 */
export interface NormalizedDeal {
  housingType: HousingType;

  // ── 건물 식별 ─────────────────────────────────────────────────────────────
  regionCode: string;          // sggCd (법정동코드 앞 5자리)
  legalDong: string | null;    // umdNm
  jibun: string | null;        // sh 는 없음
  name: string | null;         // aptNm / offiNm / mhouseNm. sh 는 없음
  /** apt 전용. "언주로30길 21" 처럼 번호까지 포함된 도로명. 지오코딩 1순위. */
  roadAddress: string | null;
  /** apt 전용. 단지명이 바뀌어도 유지되는 식별자. */
  aptSeq: string | null;
  builtYear: number | null;
  houseType: string | null;    // rh/sh 의 '다세대' / '다가구'

  // ── 거래 ─────────────────────────────────────────────────────────────────
  dealYm: string;              // YYYYMM
  dealDay: number | null;
  /** 원 단위. 응답은 만원 단위이므로 반드시 parseManwon 을 거친다. */
  deposit: number;
  /** 원 단위. 0 이면 전세. */
  monthlyRent: number;
  area: number | null;         // ㎡ (excluUseAr 또는 sh 의 totalFloorAr)
  floor: number | null;        // sh 는 없음
  contractType: string | null;
  contractTerm: string | null;
  renewalRight: string | null;

  raw: unknown;
}

/** 수집 슬롯. 실거래가 API 는 (주택유형, 시군구, 계약년월) 단위로만 조회된다. */
export interface Slot {
  housingType: HousingType;
  regionCode: string;
  dealYm: string;
}
