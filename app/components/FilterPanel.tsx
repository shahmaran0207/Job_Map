'use client';

import type { HousingType } from '../../src/collectors/molit-types';
import {
  HOUSING_LABEL_SHORT,
  MINUTE_OPTIONS,
  TRAVEL_LABEL,
  formatManwon,
  type Filters,
  type TravelMode,
} from '../lib/types';

interface Props {
  filters: Filters;
  onChange: (next: Filters) => void;
  disabled: boolean;
  /** 라우팅 엔진을 못 써서 직선거리로 물러선 상태인지 */
  degraded: boolean;
}

const TRAVEL_MODES: TravelMode[] = ['walk', 'transit', 'drive'];
const TYPES: HousingType[] = ['apt', 'offi', 'rh', 'sh'];

/** 상한 슬라이더 값. 0 은 '제한 없음'. */
const DEPOSIT_STEPS = [0, 500, 1000, 2000, 3000, 5000, 10_000, 20_000, 50_000, 100_000];
const RENT_STEPS = [0, 30, 40, 50, 60, 70, 80, 100, 130, 200, 300];
/** 0 은 '제한 없음'. 나머지는 준공년도 하한. */
const BUILT_YEAR_STEPS = [0, 1990, 2000, 2005, 2010, 2015, 2020];

export default function FilterPanel({ filters, onChange, disabled, degraded }: Props) {
  const set = <K extends keyof Filters>(key: K, value: Filters[K]) =>
    onChange({ ...filters, [key]: value });

  const toggleType = (t: HousingType) => {
    const has = filters.types.includes(t);
    // 전부 끄면 결과가 사라져 사용자가 고장이라고 느낀다. 최소 1개는 유지한다.
    if (has && filters.types.length === 1) return;
    set('types', has ? filters.types.filter((x) => x !== t) : [...filters.types, t]);
  };

  return (
    <div className="space-y-5 text-[13px]">
      {/* 전세/월세는 금액 체계가 완전히 달라 가장 위에서 먼저 고르게 한다. */}
      <Field label="거래 방식">
        <div className="flex gap-1 rounded-lg bg-neutral-100 p-1">
          {(['wolse', 'jeonse'] as const).map((m) => (
            <button
              key={m}
              type="button"
              disabled={disabled}
              onClick={() => set('mode', m)}
              className={`flex-1 rounded-md px-3 py-1.5 font-medium transition ${
                filters.mode === m
                  ? 'bg-white text-neutral-900 shadow-sm'
                  : 'text-neutral-500 hover:text-neutral-700'
              }`}
            >
              {m === 'wolse' ? '월세' : '전세'}
            </button>
          ))}
        </div>
      </Field>

      <Field label="이동수단">
        <div className="flex gap-1 rounded-lg bg-neutral-100 p-1">
          {TRAVEL_MODES.map((t) => (
            <button
              key={t}
              type="button"
              disabled={disabled}
              onClick={() => set('travel', t)}
              className={`flex-1 rounded-md px-2 py-1.5 font-medium transition ${
                filters.travel === t
                  ? 'bg-white text-neutral-900 shadow-sm'
                  : 'text-neutral-500 hover:text-neutral-700'
              }`}
            >
              {TRAVEL_LABEL[t]}
            </button>
          ))}
        </div>
      </Field>

      <Field
        label="통근 시간"
        hint={degraded ? '엔진 미가동 — 직선거리 근사' : undefined}
      >
        <div className="flex flex-wrap gap-1.5">
          {MINUTE_OPTIONS.map((m) => (
            <button
              key={m}
              type="button"
              disabled={disabled}
              onClick={() => set('minutes', m)}
              className={`rounded-md border px-2.5 py-1 tabular-nums transition ${
                filters.minutes === m
                  ? 'border-indigo-500 bg-indigo-50 font-medium text-indigo-700'
                  : 'border-neutral-200 text-neutral-600 hover:border-neutral-300'
              }`}
            >
              {m}분
            </button>
          ))}
        </div>
      </Field>

      <Field label="주택 유형">
        <div className="grid grid-cols-2 gap-1.5">
          {TYPES.map((t) => {
            const on = filters.types.includes(t);
            return (
              <button
                key={t}
                type="button"
                disabled={disabled}
                onClick={() => toggleType(t)}
                className={`rounded-md border px-2.5 py-1.5 text-left transition ${
                  on
                    ? 'border-indigo-500 bg-indigo-50 font-medium text-indigo-700'
                    : 'border-neutral-200 text-neutral-500 hover:border-neutral-300'
                }`}
              >
                {HOUSING_LABEL_SHORT[t]}
              </button>
            );
          })}
        </div>
      </Field>

      <StepSlider
        label="보증금 상한"
        steps={DEPOSIT_STEPS}
        value={filters.maxDeposit}
        disabled={disabled}
        onChange={(v) => set('maxDeposit', v)}
      />

      {filters.mode === 'wolse' && (
        <StepSlider
          label="월세 상한"
          steps={RENT_STEPS}
          value={filters.maxRent}
          disabled={disabled}
          onChange={(v) => set('maxRent', v)}
        />
      )}

      <Field label="최소 면적">
        <div className="flex items-center gap-3">
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={filters.minArea}
            disabled={disabled}
            onChange={(e) => set('minArea', Number(e.target.value))}
            className="flex-1 accent-indigo-600"
          />
          <span className="w-20 text-right tabular-nums text-neutral-600">
            {filters.minArea === 0 ? '제한 없음' : `${filters.minArea}㎡↑`}
          </span>
        </div>
      </Field>

      <Field label="건축년도">
        <div className="flex items-center gap-3">
          <input
            type="range"
            min={0}
            max={BUILT_YEAR_STEPS.length - 1}
            step={1}
            value={BUILT_YEAR_STEPS.indexOf(filters.minBuiltYear)}
            disabled={disabled}
            onChange={(e) => set('minBuiltYear', BUILT_YEAR_STEPS[Number(e.target.value)]!)}
            className="flex-1 accent-indigo-600"
          />
          <span className="w-20 text-right tabular-nums text-neutral-600">
            {filters.minBuiltYear === 0 ? '제한 없음' : `${filters.minBuiltYear}년↑`}
          </span>
        </div>
      </Field>

      {/*
        정확도 낮은 데이터를 숨길 수 있게 하되 기본은 표시한다. 숨기는 것이
        기본이면 단독·다가구가 통째로 사라져 사용자가 데이터가 없다고 오해한다.
      */}
      <label className="flex cursor-pointer items-start gap-2.5 rounded-lg bg-neutral-50 p-3">
        <input
          type="checkbox"
          checked={filters.includeUnreliable}
          disabled={disabled}
          onChange={(e) => set('includeUnreliable', e.target.checked)}
          className="mt-0.5 accent-indigo-600"
        />
        <span className="text-neutral-600">
          <span className="font-medium text-neutral-800">위치 부정확 유형 포함</span>
          <span className="mt-0.5 block text-[11px] leading-snug">
            단독·다가구는 정부가 지번을 공개하지 않아 법정동 중심점으로 표시됩니다.
            지도에서 회색 점선으로 구분됩니다.
          </span>
        </span>
      </label>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline gap-2">
        <span className="font-medium text-neutral-800">{label}</span>
        {hint && <span className="text-[11px] text-neutral-400">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

/**
 * 비선형 구간 슬라이더.
 *
 * 보증금은 0~10억 범위인데 실제 관심 구간은 아래쪽에 몰려 있다. 선형 슬라이더면
 * 1,000만~5,000만 구간이 손가락 한 칸에 뭉친다. 구간 배열의 인덱스를 조작하게
 * 해서 관심 구간의 해상도를 확보한다.
 */
function StepSlider({
  label,
  steps,
  value,
  disabled,
  onChange,
}: {
  label: string;
  steps: number[];
  value: number;
  disabled: boolean;
  onChange: (v: number) => void;
}) {
  const idx = Math.max(0, steps.indexOf(value));
  return (
    <Field label={label}>
      <div className="flex items-center gap-3">
        <input
          type="range"
          min={0}
          max={steps.length - 1}
          step={1}
          value={idx}
          disabled={disabled}
          onChange={(e) => onChange(steps[Number(e.target.value)]!)}
          className="flex-1 accent-indigo-600"
        />
        <span className="w-20 text-right tabular-nums text-neutral-600">
          {value === 0 ? '제한 없음' : `${formatManwon(value)} 이하`}
        </span>
      </div>
    </Field>
  );
}
