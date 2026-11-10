import { useEffect, useMemo, useState } from "react";

import {
  createMapScopedTimelineClock,
  GeoJsonLayer,
  HistoricalMapFeatureContextPanel,
  MapScopedTimelineControls,
  MapView,
  useHistoricalMapFeatureSelection,
  type MapScopedTimelineClock,
} from "../src";
import {
  HISTORICAL_ACCEPTANCE_POSITIONS,
  HISTORICAL_ACCEPTANCE_RECORDS,
} from "./historical-acceptance-data";

const ACCEPTANCE_RASTER_TILE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

declare global {
  interface Window {
    mapsHistoricalAcceptance?: { clock: MapScopedTimelineClock };
  }
}

const LOCALES = ["en", "de", "es"] as const;

/**
 * Historical Map Feature selection (#170 phase D, Decisions 1.14/1.16/1.18/1.20) on
 * `flatRuntime="maps"`, driven by one Map-Scoped Timeline clock over synthetic places.
 */
export function MapsHistoricalRuntimeAcceptance() {
  const [clock] = useState(() =>
    createMapScopedTimelineClock({
      defaultTime: 1820,
      timeRange: { end: 1920, start: 1800 },
      timeStep: 1,
    }),
  );
  const [locale, setLocale] = useState<(typeof LOCALES)[number]>("en");
  const selection = useHistoricalMapFeatureSelection({
    features: HISTORICAL_ACCEPTANCE_RECORDS,
    locale,
    timeline: clock,
  });
  const { activeTime } = selection;
  const applicable = HISTORICAL_ACCEPTANCE_RECORDS.filter((record) =>
    selection.isFeatureApplicable(record.id),
  );
  const applicableKey = applicable.map((record) => record.id).join(",");
  // Geometry is derived from the same sampled time as the selection validity.
  const places = useMemo<GeoJSON.FeatureCollection<GeoJSON.Point>>(
    () => ({
      features: applicableKey
        .split(",")
        .filter(Boolean)
        .map((id) => ({
          geometry: { coordinates: HISTORICAL_ACCEPTANCE_POSITIONS[id]!, type: "Point" },
          id,
          properties: {},
          type: "Feature",
        })),
      type: "FeatureCollection",
    }),
    [applicableKey],
  );

  useEffect(() => {
    window.mapsHistoricalAcceptance = { clock };
    return () => {
      delete window.mapsHistoricalAcceptance;
      clock.dispose();
    };
  }, [clock]);

  return (
    <main style={{ margin: "0 auto", maxWidth: 1120, padding: 24 }}>
      <h1>Maps-owned historical selection acceptance</h1>
      <p>Illustrative synthetic places and names — not historical evidence.</p>
      <MapView
        fitToData={false}
        flatRuntime="maps"
        initialViewState={{ center: [13, 52], zoom: 7 }}
        mapLabel="Maps historical selection acceptance"
        mapStyle={{ maxZoom: 19, minZoom: 0, tileSize: 256, tiles: ACCEPTANCE_RASTER_TILE }}
        style={{ height: 480 }}
      >
        <GeoJsonLayer
          featureCollection={places}
          hoveredFeatureId={selection.hoveredFeatureId}
          isFeatureInteractive={(feature) => selection.isFeatureApplicable(feature.id)}
          onHoveredFeatureIdChange={selection.onHoveredFeatureIdChange}
          onSelectedFeatureIdChange={selection.onSelectedFeatureIdChange}
          pointColor="#b45309"
          pointRadius={12}
          renderFeaturePopup={(feature) => (
            <span data-testid="historical-popup">
              {selection.getFeatureName(feature.id)?.text}
            </span>
          )}
          renderFeatureTooltip={(feature) => (
            <span data-testid="historical-tooltip">
              {selection.getFeatureName(feature.id)?.text}
            </span>
          )}
          selectedFeatureId={selection.selectedFeatureId}
        />
      </MapView>
      <MapScopedTimelineControls timeline={clock} timelineLabel="Historical timeline" />
      <fieldset>
        <legend>Viewer language</legend>
        {LOCALES.map((candidate) => (
          <label key={candidate}>
            <input
              checked={locale === candidate}
              name="historical-locale"
              onChange={() => setLocale(candidate)}
              type="radio"
            />
            {candidate.toUpperCase()}
          </label>
        ))}
      </fieldset>
      <ul aria-label="Places at this date">
        {applicable.map((record) => (
          <li key={record.id}>
            <button
              aria-pressed={selection.selectedFeatureId === record.id}
              onClick={() => selection.selectFeature(record.id)}
              type="button"
            >
              {selection.getFeatureName(record.id)?.text ?? record.id}
            </button>
          </li>
        ))}
      </ul>
      <HistoricalMapFeatureContextPanel selection={selection} />
      <output data-testid="historical-time">{activeTime}</output>
      <output data-testid="historical-selection">{selection.selectedFeatureId ?? "none"}</output>
      <output data-testid="historical-selected-name">
        {selection.selectedFeatureId
          ? (selection.getFeatureName(selection.selectedFeatureId)?.text ?? selection.selectedFeatureId)
          : "none"}
      </output>
      <output data-testid="historical-hover">{selection.hoveredFeatureId ?? "none"}</output>
    </main>
  );
}
