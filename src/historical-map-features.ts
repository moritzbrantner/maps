import { snapTemporalMapTime, type TemporalMapTimeRange } from "./temporal-core";

/**
 * A period in which a historical Map Feature applies, in Map-Scoped Timeline time. `start`
 * is inclusive and `end` exclusive, so adjacent periods (a rename, a successor) never overlap.
 * Omit `end` for an open-ended period.
 */
export type HistoricalMapFeaturePeriod = {
  end?: number;
  /** The consumer's label for the period, such as "1816–1871". */
  label?: string;
  start: number;
};

/** A source-attested name of a historical Map Feature, valid for one period. */
export type HistoricalMapFeatureName = HistoricalMapFeaturePeriod & {
  /** The consumer's attribution for this name. */
  attribution?: string;
  /**
   * Established period-appropriate forms in viewer languages, keyed by language tag (such as
   * `"en"` or `"de"`). Supplied by the consumer; Maps never translates.
   */
  localized?: Readonly<Record<string, string>>;
  /** The attested original-language form. */
  original: { language?: string; script?: string; text: string };
};

/** A date to which a viewer may navigate to revisit a historical Map Feature. */
export type HistoricalMapFeatureDate = { label?: string; time: number };

/**
 * Consumer-supplied historical facts about one Map Feature. Maps uses them only to decide
 * selection validity and presentation; it never infers periods, names or successors.
 */
export type HistoricalMapFeatureRecord = {
  /** The consumer's attribution for the feature as a whole. */
  attribution?: string;
  /** The Map Feature ID the layer reports for this feature. */
  id: string;
  /** The recognizable modern equivalent, shown in details (Decision 1.18). */
  modernName?: string;
  names?: readonly HistoricalMapFeatureName[];
  /** Evidence-backed periods in which the feature applies. */
  periods: readonly HistoricalMapFeaturePeriod[];
  /** Evidence-backed dates offered on the out-of-period mini-timeline (Decision 1.16). */
  supportedDates?: readonly HistoricalMapFeatureDate[];
};

export type ResolvedHistoricalMapFeatureName = {
  attribution?: string;
  /** The language of `text`; `undefined` when the original form gives none. */
  language: string | undefined;
  modernName: string | undefined;
  original: HistoricalMapFeatureName["original"];
  /**
   * `true` when no established form exists for the requested language and `text` is the
   * attested original form instead (Decision 1.20).
   */
  sourceFormFallback: boolean;
  text: string;
};

export function isHistoricalMapFeaturePeriodActive(period: HistoricalMapFeaturePeriod, time: number) {
  return time >= period.start && (period.end === undefined || time < period.end);
}

/** The period of `record` containing `time`, or `null` when the feature is out of period. */
export function getHistoricalMapFeaturePeriodAt(
  record: HistoricalMapFeatureRecord,
  time: number,
): HistoricalMapFeaturePeriod | null {
  return record.periods.find((period) => isHistoricalMapFeaturePeriodActive(period, time)) ?? null;
}

export function isHistoricalMapFeatureApplicable(record: HistoricalMapFeatureRecord, time: number) {
  return getHistoricalMapFeaturePeriodAt(record, time) !== null;
}

/**
 * The date-appropriate historical name of `record` at `time` in the viewer's `locale`
 * (Decisions 1.18 and 1.20). Falls back to the attested original form, flagged as such, when
 * the consumer supplies no established form for the locale. `null` when no name applies.
 */
export function resolveHistoricalMapFeatureName(
  record: HistoricalMapFeatureRecord,
  time: number,
  locale?: string,
): ResolvedHistoricalMapFeatureName | null {
  const name = record.names?.find((candidate) => isHistoricalMapFeaturePeriodActive(candidate, time));

  if (!name) {
    return null;
  }

  const localized = locale ? findLocalizedName(name.localized, locale) : undefined;

  return {
    attribution: name.attribution,
    language: localized ? localized.language : name.original.language,
    modernName: record.modernName,
    original: name.original,
    sourceFormFallback: Boolean(locale) && !localized,
    text: localized ? localized.text : name.original.text,
  };
}

function findLocalizedName(localized: HistoricalMapFeatureName["localized"], locale: string) {
  if (!localized) {
    return undefined;
  }

  const exact = localized[locale];

  if (exact !== undefined) {
    return { language: locale, text: exact };
  }

  const base = locale.split("-")[0]!;
  const baseForm = localized[base];

  return baseForm === undefined ? undefined : { language: base, text: baseForm };
}

export type HistoricalMapFeatureDateOption = HistoricalMapFeatureDate & {
  available: boolean;
  /** Why an option is unavailable; `undefined` when it is available. */
  reason?: "outside-timeline" | "out-of-period-at-snapped-time";
  /** The Map-Scoped Timeline time a navigation would sample after snapping. */
  sampledTime: number;
};

/**
 * The mini-timeline options of `record`: its supported dates, each marked unavailable when the
 * map's timeline cannot reach it or when snapping would sample a time outside the feature's
 * periods. Unavailable dates stay listed so the viewer can see why.
 */
export function getHistoricalMapFeatureDateOptions(
  record: HistoricalMapFeatureRecord,
  timeRange: TemporalMapTimeRange | null,
  timeStep: number | "any" = "any",
): HistoricalMapFeatureDateOption[] {
  return [...(record.supportedDates ?? [])]
    .sort((left, right) => left.time - right.time)
    .map((date) => {
      if (!timeRange || date.time < timeRange.start || date.time > timeRange.end) {
        return { ...date, available: false, reason: "outside-timeline", sampledTime: date.time };
      }

      const sampledTime = snapTemporalMapTime(date.time, timeRange, timeStep);

      return isHistoricalMapFeatureApplicable(record, sampledTime)
        ? { ...date, available: true, sampledTime }
        : { ...date, available: false, reason: "out-of-period-at-snapped-time", sampledTime };
    });
}
