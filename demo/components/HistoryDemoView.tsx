import { useEffect, useMemo, useRef, useState } from "react";
import type { Map as MapLibreMap } from "maplibre-gl";

import { Button } from "@moritzbrantner/ui";
import {
  GeoJsonLayer,
  MapView,
  getBoundsFromGeoJson,
  type GeoJsonLayerFeature,
  type MapSurfaceController,
  type MapViewState,
} from "@moritzbrantner/maps";

import { demoMapStyle } from "../data/map-style";
import {
  demoHistoricalPolityScenarios,
  formatDemoHistoricalPolityYear,
  getDemoHistoricalPolityPlaybackFrame,
  getDemoHistoricalPolityRenderFeatureId,
  getDemoHistoricalPolityScenario,
  getDemoHistoricalPolitySceneForYear,
  isDemoHistoricalPolityVisibleFeature,
  type DemoHistoricalPolityScenarioId,
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
const wwiiPlaybackRateYearsPerSecond = 0.45;

export function HistoryDemoView({
  onMapControllerReady,
  onMapReady,
  onViewStateChange,
}: HistoryDemoViewProps) {
  const [scenarioId, setScenarioId] = useState<DemoHistoricalPolityScenarioId>("european-states");
  const activeScenario = getDemoHistoricalPolityScenario(scenarioId);
  const historyStartYear = activeScenario.scenes[0]!.year;
  const historyEndYear = activeScenario.scenes.at(-1)!.year;
  const [year, setYear] = useState(historyStartYear);
  const [isPlaying, setIsPlaying] = useState(false);
  const animationFrameRef = useRef<number | null>(null);
  const previousTimestampRef = useRef<number | null>(null);
  const roundedYear = Math.round(year);
  const activeFrame = useMemo(
    () => getDemoHistoricalPolityPlaybackFrame(year, scenarioId),
    [scenarioId, year],
  );
  const activeScene = getDemoHistoricalPolitySceneForYear(year, scenarioId);
  const activeYearLabel =
    scenarioId === "wwii-control" ? activeScene.label : formatDemoHistoricalPolityYear(roundedYear);
  const activeSegment =
    scenarioId === "wwii-control" ? "German-controlled territory" : `${activeScene.label} snapshot`;
  const historySceneBounds = useMemo(
    () =>
      getBoundsFromGeoJson({
        features: activeScenario.scenes.flatMap((scene) => scene.collection.features),
        type: "FeatureCollection",
      }),
    [activeScenario],
  );
  const visiblePolityCount = activeFrame.features.filter(
    isDemoHistoricalPolityVisibleFeature,
  ).length;

  useEffect(() => {
    setIsPlaying(false);
    setYear(historyStartYear);
  }, [historyStartYear, scenarioId]);

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
        const playbackRate =
          scenarioId === "wwii-control"
            ? wwiiPlaybackRateYearsPerSecond
            : historyPlaybackRateYearsPerSecond;
        const nextYear = currentYear + elapsedSeconds * playbackRate;

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
  }, [historyEndYear, historyStartYear, isPlaying, scenarioId]);

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
            getFeatureId={(feature) => getDemoHistoricalPolityRenderFeatureId(feature, year)}
            isFeatureInteractive={isDemoHistoricalPolityVisibleFeature}
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

        <div className="demo-history-scenarios" aria-label="History scenarios">
          {demoHistoricalPolityScenarios.map((scenario) => (
            <Button
              aria-label={`Show ${scenario.label}`}
              key={scenario.id}
              size="sm"
              variant={scenario.id === scenarioId ? "default" : "secondary"}
              type="button"
              onClick={() => {
                setScenarioId(scenario.id);
              }}
            >
              {scenario.label}
            </Button>
          ))}
        </div>

        <dl className="demo-interpolation-facts">
          <div>
            <dt>Active year</dt>
            <dd>{activeYearLabel}</dd>
          </div>
          <div>
            <dt>Segment</dt>
            <dd>{activeSegment}</dd>
          </div>
          <div>
            <dt>Polities</dt>
            <dd>{visiblePolityCount}</dd>
          </div>
        </dl>

        <label className="demo-history-timeline">
          <span>
            <strong>{activeYearLabel}</strong>
            <em>{activeSegment}</em>
          </span>
          <input
            aria-label="Historical year"
            max={historyEndYear}
            min={historyStartYear}
            step={scenarioId === "wwii-control" ? 0.01 : 1}
            type="range"
            value={scenarioId === "wwii-control" ? year : roundedYear}
            onChange={(event) => {
              setIsPlaying(false);
              setYear(Number(event.currentTarget.value));
            }}
          />
        </label>

        <div className="demo-history-epoch-buttons" aria-label="Historical epochs">
          {activeScenario.scenes.map((scene) => (
            <Button
              aria-label={`Show ${scene.label}`}
              key={scene.year}
              size="sm"
              variant={activeScene.year === scene.year ? "default" : "secondary"}
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
          {activeScenario.caveat}
        </p>
      </div>
    </section>
  );
}

function getHistoricalPolityStyle(feature: GeoJsonLayerFeature<DemoHistoricalPolityProperties>) {
  const color = historicalPolityRegionColors[feature.properties.region] ?? "#475569";

  return {
    polygonFillColor: color,
    polygonFillOpacity: 0.3,
    polygonStrokeColor: color,
    polygonStrokeWidth: 1.4,
  };
}

function renderHistoricalPolityPopup(feature: GeoJsonLayerFeature<DemoHistoricalPolityProperties>) {
  const { label, precision, region, sceneYear, sourceFrom, sourceTo } = feature.properties;

  return (
    <div className="demo-popup">
      <strong>{label}</strong>
      <span>{formatDemoHistoricalPolityYear(sceneYear)}</span>
      <span>{historicalPolityRegionLabels[region]} region</span>
      <span>{precision}</span>
      <span>
        CShapes-Europe {sourceFrom}-{sourceTo}
      </span>
    </div>
  );
}
