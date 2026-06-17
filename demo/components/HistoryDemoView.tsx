import { useEffect, useMemo, useRef, useState } from "react";
import type { Map as MapLibreMap } from "maplibre-gl";

import { Button } from "@moritzbrantner/ui";
import {
  GeoJsonLayer,
  MapView,
  getBoundsFromGeoJson,
  type GeoJsonLayerFeature,
  type GeoJsonTransitionPlan,
  type MapSurfaceController,
  type MapViewState,
} from "@moritzbrantner/maps";

import { demoMapStyle } from "../data/map-style";
import {
  demoHistoricalPolityScenes,
  formatDemoHistoricalPolityYear,
  getDemoHistoricalPolityFrameWithPlanCache,
  type DemoHistoricalPolityProperties,
  type DemoHistoricalPolityRegion,
} from "../data/history-polities";

type HistoryDemoViewProps = {
  onMapControllerReady?: (controller: MapSurfaceController) => void;
  onMapReady?: (map: MapLibreMap) => void;
  onViewStateChange?: (viewState: MapViewState) => void;
};

const historicalPolityRegionColors: Record<DemoHistoricalPolityRegion, string> = {
  atlantic: "#2563eb",
  central: "#0f766e",
  eastern: "#7c3aed",
  nordic: "#0891b2",
  ottoman: "#be123c",
  southern: "#b45309",
};

const historicalPolityRegionLabels: Record<DemoHistoricalPolityRegion, string> = {
  atlantic: "Atlantic",
  central: "Central",
  eastern: "Eastern",
  nordic: "Nordic",
  ottoman: "Ottoman",
  southern: "Southern",
};

const historyPlaybackRateYearsPerSecond = 80;
const historyStartYear = demoHistoricalPolityScenes[0]!.year;
const historyEndYear = demoHistoricalPolityScenes.at(-1)!.year;
const historySceneBounds = getBoundsFromGeoJson({
  features: demoHistoricalPolityScenes.flatMap((scene) => scene.collection.features),
  type: "FeatureCollection",
});

export function HistoryDemoView({
  onMapControllerReady,
  onMapReady,
  onViewStateChange,
}: HistoryDemoViewProps) {
  const [year, setYear] = useState(historyStartYear);
  const [isPlaying, setIsPlaying] = useState(false);
  const animationFrameRef = useRef<number | null>(null);
  const previousTimestampRef = useRef<number | null>(null);
  const transitionPlanCacheRef = useRef<
    Map<string, GeoJsonTransitionPlan<DemoHistoricalPolityProperties>>
  >(new Map());
  const roundedYear = Math.round(year);
  const activeFrame = useMemo(
    () => getDemoHistoricalPolityFrameWithPlanCache(roundedYear, transitionPlanCacheRef.current),
    [roundedYear],
  );
  const activeSegment = getDemoHistoricalPolitySegmentLabel(roundedYear);

  useEffect(() => {
    if (!isPlaying) {
      previousTimestampRef.current = null;
      return;
    }

    const tick = (timestamp: number) => {
      const previousTimestamp = previousTimestampRef.current ?? timestamp;
      const elapsedSeconds = (timestamp - previousTimestamp) / 1000;

      previousTimestampRef.current = timestamp;
      setYear((currentYear) => {
        const nextYear = currentYear + elapsedSeconds * historyPlaybackRateYearsPerSecond;

        return nextYear >= historyEndYear ? historyStartYear : nextYear;
      });
      animationFrameRef.current = window.requestAnimationFrame(tick);
    };

    animationFrameRef.current = window.requestAnimationFrame(tick);

    return () => {
      if (animationFrameRef.current !== null) {
        window.cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, [isPlaying]);

  return (
    <section className="demo-history-workbench" aria-label="History demo">
      <div className="demo-history-map">
        <MapView
          dataBounds={historySceneBounds}
          defaultViewState={{ center: [13, 51], zoom: 3.4 }}
          fitBoundsPadding={52}
          mapLabel="European polity history"
          mapStyle={demoMapStyle}
          onMapControllerReady={onMapControllerReady}
          onMapReady={onMapReady}
          onViewStateChange={onViewStateChange}
          style={{ minHeight: 620 }}
        >
          <GeoJsonLayer
            featureCollection={activeFrame}
            getFeatureStyle={getHistoricalPolityStyle}
            getFeatureId={(feature) => feature.id}
            layerId="history-polities"
            renderFeaturePopup={renderHistoricalPolityPopup}
            renderFeatureTooltip={(feature) => feature.properties.label}
          />
        </MapView>
      </div>

      <div className="demo-history-panel">
        <div className="demo-layer-manager__header">
          <h2>Polities</h2>
          <Button
            aria-pressed={isPlaying}
            size="sm"
            variant={isPlaying ? "default" : "secondary"}
            type="button"
            onClick={() => setIsPlaying((value) => !value)}
          >
            {isPlaying ? "Pause" : "Play"}
          </Button>
        </div>

        <dl className="demo-interpolation-facts">
          <div>
            <dt>Active year</dt>
            <dd>{formatDemoHistoricalPolityYear(roundedYear)}</dd>
          </div>
          <div>
            <dt>Segment</dt>
            <dd>{activeSegment}</dd>
          </div>
          <div>
            <dt>Polities</dt>
            <dd>{activeFrame.features.length}</dd>
          </div>
        </dl>

        <label className="demo-history-timeline">
          <span>
            <strong>{formatDemoHistoricalPolityYear(roundedYear)}</strong>
            <em>{activeSegment}</em>
          </span>
          <input
            aria-label="Historical year"
            max={historyEndYear}
            min={historyStartYear}
            step={1}
            type="range"
            value={roundedYear}
            onChange={(event) => {
              setIsPlaying(false);
              setYear(Number(event.currentTarget.value));
            }}
          />
        </label>

        <div className="demo-history-epoch-buttons" aria-label="Historical epochs">
          {demoHistoricalPolityScenes.map((scene) => (
            <Button
              aria-label={`Show ${scene.label}`}
              key={scene.year}
              size="sm"
              variant={roundedYear === scene.year ? "default" : "secondary"}
              type="button"
              onClick={() => {
                setIsPlaying(false);
                setYear(scene.year);
              }}
            >
              {scene.label}
            </Button>
          ))}
        </div>

        <div className="demo-history-legend" aria-label="Historical polity regions">
          {Object.entries(historicalPolityRegionLabels).map(([region, label]) => (
            <span key={region}>
              <i
                style={{
                  background: historicalPolityRegionColors[region as DemoHistoricalPolityRegion],
                }}
              />
              {label}
            </span>
          ))}
        </div>

        <p className="demo-history-caveat">
          Illustrative, simplified borders for demonstrating polygon timeline transitions.
        </p>
      </div>
    </section>
  );
}

function getHistoricalPolityStyle(feature: GeoJsonLayerFeature<DemoHistoricalPolityProperties>) {
  const color = historicalPolityRegionColors[feature.properties.region] ?? "#475569";
  const approximate = feature.properties.precision === "approximate";

  return {
    polygonFillColor: color,
    polygonFillOpacity: approximate ? 0.22 : 0.32,
    polygonStrokeColor: color,
    polygonStrokeWidth: approximate ? 1.2 : 1.6,
  };
}

function renderHistoricalPolityPopup(feature: GeoJsonLayerFeature<DemoHistoricalPolityProperties>) {
  const { label, note, precision, region, sceneYear } = feature.properties;

  return (
    <div className="demo-popup">
      <strong>{label}</strong>
      <span>{formatDemoHistoricalPolityYear(sceneYear)}</span>
      <span>{historicalPolityRegionLabels[region]} region</span>
      <span>{precision}</span>
      {note ? <span>{note}</span> : null}
    </div>
  );
}

function getDemoHistoricalPolitySegmentLabel(year: number) {
  const exactScene = demoHistoricalPolityScenes.find((scene) => scene.year === year);

  if (exactScene) {
    return exactScene.label;
  }

  const nextSceneIndex = demoHistoricalPolityScenes.findIndex((scene) => scene.year > year);
  const previousScene =
    demoHistoricalPolityScenes[nextSceneIndex - 1] ?? demoHistoricalPolityScenes[0]!;
  const nextScene =
    demoHistoricalPolityScenes[nextSceneIndex] ?? demoHistoricalPolityScenes.at(-1)!;

  return `${previousScene.label} -> ${nextScene.label}`;
}
