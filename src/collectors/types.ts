/** 모든 수집기가 이 형태로 정규화해서 내놓는다. 소스가 늘어도 적재 코드는 하나뿐이다. */
export interface NormalizedPosting {
  source: string;
  sourceId: string;
  url: string | null;
  title: string;

  companyName: string;

  /** 공고에 적혀 있던 근무지 주소 원문. 없으면 null (지오코딩 보강 대상이 된다) */
  rawAddress: string | null;
  /** '서울 강남구' 처럼 시군구까지만 있는 경우를 위한 폴백 */
  regionHint: string | null;

  jobCategory: string | null;
  jobCode: string | null;
  employmentType: string | null;
  careerType: string | null;
  careerMinYear: number | null;
  education: string | null;
  salaryType: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  workHours: string | null;

  postedOn: string | null;
  closesOn: string | null;

  /** 원본 payload 전량. 마감되면 원본이 사라지므로 반드시 보존한다. */
  raw: unknown;
}

export interface CollectorResult {
  postings: NormalizedPosting[];
  pagesRead: number;
  /** 소스를 끝까지 다 읽었는가. false 면 미관측 공고를 마감 처리하면 안 된다. */
  complete: boolean;
}

export interface Collector {
  readonly source: string;
  collect(opts: { maxPages: number }): Promise<CollectorResult>;
}
