"use client";

import { useCallback, useMemo, useState, type ReactNode } from "react";

import {
  getHistoricalMapFeatureDateOptions,
  getHistoricalMapFeaturePeriodAt,
  isHistoricalMapFeatureApplicable,
  resolveHistoricalMapFeatureName,
  type HistoricalMapFeatureDateOption,
  type HistoricalMapFeaturePeriod,
  type HistoricalMapFeatureRecord,
  type ResolvedHistoricalMapFeatureName,
} from "./historical-map-features";
import type { MapFeatureInteractionChange } from "./map-interaction";
import type { MapScopedTimelineClock } from "./map-scoped-timeline";
import { useMapScopedTimelineSnapshot } from "./map-scoped-timeline-react";

/**
 * Details a viewer opened on a historical Map Feature that the Map-Scoped Timeline has since
 * moved out of period (Decision 1.14). It refers to `contextTime`, the last map date at which
 * the feature applied, never to the current map date.
 */
export type HistoricalMapFeatureContext<TFeature = unknown> = {
  /** The last map date at which the feature applied and was selected. */
  contextTime: number;
  /** The layer's feature object as it was selected, for the consumer's details. */
  feature: TFeature | null;
  featureId: string;
  /** The date-appropriate name at `contextTime`, in the current locale. */
  name: ResolvedHistoricalMapFeatureName | null;
  /** The period `contextTime` falls in. */
  period: HistoricalMapFeaturePeriod | null;
  record: HistoricalMapFeatureRecord | undefined;
};

export type UseHistoricalMapFeatureSelectionOptions = {
  /** Consumer-supplied validity, names and dates. Features without a record always apply. */
  features: readonly HistoricalMapFeatureRecord[];
  /** The viewer's language for date-appropriate names (Decision 1.20). */
  locale?: string;
  /** The one authoritative Map-Scoped Timeline the Map Layers sample. */
  timeline: MapScopedTimelineClock;
};

export type HistoricalMapFeatureSelection<TFeature = unknown> = {
  /** The sampled map date every value here was derived from. */
  activeTime: number;
  /** Closes the retained out-of-period context. */
  dismissContext(): void;
  /** Mini-timeline options of the retained context's feature; empty without one. */
  getContextDateOptions(): HistoricalMapFeatureDateOption[];
  /** The date-appropriate name of a feature at the current map date. */
  getFeatureName(featureId: string): ResolvedHistoricalMapFeatureName | null;
  hoveredFeatureId: string | null;
  isFeatureApplicable(featureId: string): boolean;
  /**
   * Moves the authoritative timeline to a supported date of the retained context's feature
   * and reselects it once the map samples that date, if it applies there (Decision 1.16).
   * Returns `false`, changing nothing, for a date the mini-timeline does not offer.
   */
  navigateToContextDate(time: number): boolean;
  onHoveredFeatureIdChange(featureId: string | null, context?: MapFeatureInteractionChange<TFeature>): void;
  onSelectedFeatureIdChange(featureId: string | null, context?: MapFeatureInteractionChange<TFeature>): void;
  /** Retained details of a feature that went out of period, or `null`. */
  retainedContext: HistoricalMapFeatureContext<TFeature> | null;
  /** Selects a feature without a pointer, for keyboard or list selection. */
  selectFeature(featureId: string | null, feature?: TFeature | null): void;
  selectedFeature: TFeature | null;
  /** The selection to pass to the Map Layer; `null` whenever the feature is out of period. */
  selectedFeatureId: string | null;
};

type SelectedEntry<TFeature> = { feature: TFeature | null; id: string; lastApplicableTime: number };

type SelectionState<TFeature> = {
  hoveredId: string | null;
  pending: { feature: TFeature | null; fromTime: number; id: string; target: number } | null;
  retained: SelectedEntry<TFeature> | null;
  selected: SelectedEntry<TFeature> | null;
};

const EMPTY_STATE: SelectionState<never> = {
  hoveredId: null,
  pending: null,
  retained: null,
  selected: null,
};

/**
 * Map Feature selection for a Historical Map View, validated against the one authoritative
 * Map-Scoped Timeline (Decisions 1.14, 1.16, 1.18, 1.20).
 *
 * In the same render in which the sampled map date leaves a selected feature's period, the
 * selection, hover and any anchored popup are cleared and its details are retained as an
 * out-of-period context. Nothing reselects it automatically — not a successor, and not the
 * timeline returning into its period — except an explicit mini-timeline navigation.
 */
export function useHistoricalMapFeatureSelection<TFeature = unknown>({
  features,
  locale,
  timeline,
}: UseHistoricalMapFeatureSelectionOptions): HistoricalMapFeatureSelection<TFeature> {
  const snapshot = useMapScopedTimelineSnapshot(timeline);
  const activeTime = snapshot.activeTime;
  const records = useMemo(() => new Map(features.map((record) => [record.id, record])), [features]);
  const [state, setState] = useState<SelectionState<TFeature>>(EMPTY_STATE);

  const applies = useCallback(
    (featureId: string, time: number) => {
      const record = records.get(featureId);
      return !record || isHistoricalMapFeatureApplicable(record, time);
    },
    [records],
  );

  // Reconcile with the sampled time during render, so no committed frame shows a stale
  // selection, hover or popup for a feature that is out of period.
  const reconciled = reconcileSelection(state, activeTime, applies);

  if (reconciled !== state) {
    setState(reconciled);
  }

  const current = reconciled;

  const onSelectedFeatureIdChange = useCallback(
    (featureId: string | null, context?: MapFeatureInteractionChange<TFeature>) => {
      const time = timeline.getSnapshot().activeTime;

      setState((previous) => {
        if (featureId === null) {
          return previous.selected ? { ...previous, selected: null } : previous;
        }

        // A pick of a feature that does not apply at the sampled date is a stale target.
        if (!applies(featureId, time)) {
          return previous;
        }

        return {
          hoveredId: previous.hoveredId,
          pending: null,
          retained: null,
          selected: { feature: context?.feature ?? null, id: featureId, lastApplicableTime: time },
        };
      });
    },
    [applies, timeline],
  );

  const onHoveredFeatureIdChange = useCallback(
    (featureId: string | null) => {
      const time = timeline.getSnapshot().activeTime;

      setState((previous) => {
        const hoveredId = featureId !== null && applies(featureId, time) ? featureId : null;
        return previous.hoveredId === hoveredId ? previous : { ...previous, hoveredId };
      });
    },
    [applies, timeline],
  );

  const selectFeature = useCallback(
    (featureId: string | null, feature: TFeature | null = null) => {
      onSelectedFeatureIdChange(
        featureId,
        featureId === null
          ? undefined
          : { feature: feature as TFeature, featureId, source: "click" },
      );
    },
    [onSelectedFeatureIdChange],
  );

  const retainedRecord = current.retained ? records.get(current.retained.id) : undefined;
  const timeRange = snapshot.timeRange;
  const timeStep = snapshot.timeStep;

  const getContextDateOptions = useCallback(
    () => (retainedRecord ? getHistoricalMapFeatureDateOptions(retainedRecord, timeRange, timeStep) : []),
    [retainedRecord, timeRange, timeStep],
  );

  const navigateToContextDate = useCallback(
    (time: number) => {
      const option = getContextDateOptions().find((candidate) => candidate.time === time);
      const retained = current.retained;

      if (!retained || !option?.available) {
        return false;
      }

      setState((previous) => ({
        ...previous,
        pending: {
          feature: retained.feature,
          fromTime: timeline.getSnapshot().activeTime,
          id: retained.id,
          target: option.sampledTime,
        },
      }));
      timeline.pause();
      timeline.seek(option.time);
      return true;
    },
    [current.retained, getContextDateOptions, timeline],
  );

  const dismissContext = useCallback(() => {
    setState((previous) =>
      previous.retained || previous.pending ? { ...previous, pending: null, retained: null } : previous,
    );
  }, []);

  const retainedContext = useMemo<HistoricalMapFeatureContext<TFeature> | null>(() => {
    const retained = current.retained;

    if (!retained) {
      return null;
    }

    return {
      contextTime: retained.lastApplicableTime,
      feature: retained.feature,
      featureId: retained.id,
      name: retainedRecord
        ? resolveHistoricalMapFeatureName(retainedRecord, retained.lastApplicableTime, locale)
        : null,
      period: retainedRecord
        ? getHistoricalMapFeaturePeriodAt(retainedRecord, retained.lastApplicableTime)
        : null,
      record: retainedRecord,
    };
  }, [current.retained, locale, retainedRecord]);

  return {
    activeTime,
    dismissContext,
    getContextDateOptions,
    getFeatureName: (featureId) => {
      const record = records.get(featureId);
      return record ? resolveHistoricalMapFeatureName(record, activeTime, locale) : null;
    },
    hoveredFeatureId: current.hoveredId,
    isFeatureApplicable: (featureId) => applies(featureId, activeTime),
    navigateToContextDate,
    onHoveredFeatureIdChange,
    onSelectedFeatureIdChange,
    retainedContext,
    selectFeature,
    selectedFeature: current.selected?.feature ?? null,
    selectedFeatureId: current.selected?.id ?? null,
  };
}

function reconcileSelection<TFeature>(
  state: SelectionState<TFeature>,
  activeTime: number,
  applies: (featureId: string, time: number) => boolean,
): SelectionState<TFeature> {
  let next = state;

  if (next.hoveredId !== null && !applies(next.hoveredId, activeTime)) {
    next = { ...next, hoveredId: null };
  }

  const selected = next.selected;

  if (selected) {
    if (!applies(selected.id, activeTime)) {
      next = { ...next, pending: null, retained: selected, selected: null };
    } else if (selected.lastApplicableTime !== activeTime) {
      next = { ...next, selected: { ...selected, lastApplicableTime: activeTime } };
    }
  }

  const pending = next.pending;

  if (pending) {
    if (activeTime === pending.target && applies(pending.id, activeTime)) {
      next = {
        hoveredId: next.hoveredId,
        pending: null,
        retained: null,
        selected: { feature: pending.feature, id: pending.id, lastApplicableTime: activeTime },
      };
    } else if (activeTime !== pending.fromTime) {
      // Only the navigated-to date may reselect; any other sampled date drops the request.
      next = { ...next, pending: null };
    }
  }

  return next;
}

export type HistoricalMapFeatureContextPanelProps<TFeature = unknown> = {
  /** Accessible label of the panel. Defaults to "Historical context". */
  ariaLabel?: string;
  formatTime?: (time: number) => string;
  /** Consumer content for the retained details: sources, explanation, translations. */
  renderDetails?: (context: HistoricalMapFeatureContext<TFeature>) => ReactNode;
  selection: HistoricalMapFeatureSelection<TFeature>;
};

const defaultFormatTime = (time: number) => String(time);

function formatPeriod(period: HistoricalMapFeaturePeriod, formatTime: (time: number) => string) {
  if (period.label) {
    return period.label;
  }

  return period.end === undefined
    ? `from ${formatTime(period.start)}`
    : `${formatTime(period.start)} – ${formatTime(period.end)}`;
}

/**
 * The detached out-of-period context surface (Decision 1.14) with its contextual
 * mini-timeline (Decision 1.16). It is not anchored to map geometry: the feature no longer
 * occupies the map at the current date. Renders nothing without a retained context.
 */
export function HistoricalMapFeatureContextPanel<TFeature = unknown>({
  ariaLabel = "Historical context",
  formatTime = defaultFormatTime,
  renderDetails,
  selection,
}: HistoricalMapFeatureContextPanelProps<TFeature>) {
  const context = selection.retainedContext;

  if (!context) {
    return null;
  }

  const inPeriodAgain = selection.isFeatureApplicable(context.featureId);
  const options = selection.getContextDateOptions();
  const name = context.name;

  return (
    <section aria-label={ariaLabel} className="maps-historical-context" data-historical-context={context.featureId}>
      <p className="maps-historical-context__status" data-historical-context-status={inPeriodAgain ? "in-period" : "out-of-period"}>
        {inPeriodAgain ? "Applies at the map date — not selected" : "Out of period"}
      </p>
      {name ? (
        <h3 className="maps-historical-context__name" lang={name.language}>
          {name.text}
        </h3>
      ) : null}
      <dl className="maps-historical-context__dates">
        <dt>Details refer to</dt>
        <dd data-historical-context-time>
          {formatTime(context.contextTime)}
          {context.period ? ` (${formatPeriod(context.period, formatTime)})` : null}
        </dd>
        <dt>Map date</dt>
        <dd data-historical-map-time>{formatTime(selection.activeTime)}</dd>
        {name?.sourceFormFallback ? (
          <>
            <dt>Name</dt>
            <dd>No established form in this language; showing the attested original form.</dd>
          </>
        ) : null}
        {name && (name.original.text !== name.text || name.original.script) ? (
          <>
            <dt>Original form</dt>
            <dd lang={name.original.language}>
              {name.original.text}
              {name.original.script ? ` (${name.original.script})` : null}
            </dd>
          </>
        ) : null}
        {context.record?.modernName ? (
          <>
            <dt>Modern equivalent</dt>
            <dd>{context.record.modernName}</dd>
          </>
        ) : null}
        {name?.attribution ?? context.record?.attribution ? (
          <>
            <dt>Source</dt>
            <dd>{name?.attribution ?? context.record?.attribution}</dd>
          </>
        ) : null}
      </dl>
      {renderDetails?.(context)}
      {options.length > 0 ? (
        <nav aria-label="Supported dates" className="maps-historical-context__mini-timeline">
          <ol>
            {options.map((option) => (
              <li key={option.time}>
                <button
                  aria-describedby={option.available ? undefined : `maps-historical-date-${context.featureId}-${option.time}`}
                  disabled={!option.available}
                  onClick={() => {
                    selection.navigateToContextDate(option.time);
                  }}
                  type="button"
                >
                  {option.label ?? formatTime(option.time)}
                </button>
                {option.available ? null : (
                  <span id={`maps-historical-date-${context.featureId}-${option.time}`}>
                    {option.reason === "outside-timeline"
                      ? "Outside this map's timeline"
                      : "Not applicable at the map's sampled date"}
                  </span>
                )}
              </li>
            ))}
          </ol>
        </nav>
      ) : null}
      <button className="maps-historical-context__dismiss" onClick={selection.dismissContext} type="button">
        Dismiss
      </button>
    </section>
  );
}
