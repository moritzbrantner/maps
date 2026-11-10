import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { Map as MapLibreMap } from "maplibre-gl";

import { Button } from "@moritzbrantner/ui";
import {
  GeoJsonLayer,
  HistoricalMapFeatureContextPanel,
  MapView,
  PointLayer,
  createMapScopedTimelineClock,
  getBoundsFromGeoJson,
  useHistoricalMapFeatureSelection,
  useMapScopedTimelineSnapshot,
  type GeoJsonLayerFeature,
  type HistoricalMapFeatureSelection,
  type MapPoint,
  type MapSurfaceController,
  type MapViewState,
  type PointLayerFeature,
} from "@moritzbrantner/maps";

import { demoMapStyle } from "../data/map-style";
import {
  demoHistoricalPlaceAttribution,
  demoHistoricalPlaceLocales,
  demoHistoricalPlaceRecords,
  getDemoHistoricalPlacesAt,
  isDemoHistoricalPlaceId,
  type DemoHistoricalPlaceLocale,
} from "../data/history-places";
import {
  demoHistoricalPolityScenarios,
  formatDemoHistoricalPolityYear,
  getDemoHistoricalPolityBoundaryStatus,
  getDemoHistoricalPolityPlaybackFrame,
  getDemoHistoricalPolityRecords,
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
const historyLocaleLabels: Record<DemoHistoricalPlaceLocale, string> = {
  de: "Deutsch",
  en: "English",
  es: "Español",
};
const monthLabels = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

type HistoryPolityFeature = { properties: DemoHistoricalPolityProperties };

type HistoryDetails = {
  formatTime: (time: number) => string;
  /** The polity as drawn at the map year, for live popup and selection details. */
  getPolityFeature: (featureId: string) => HistoryPolityFeature | null;
  scenarioId: DemoHistoricalPolityScenarioId;
  selection: HistoricalMapFeatureSelection<unknown>;
  sourceSnapshotLabel: string;
};

/**
 * Popups and tooltips render through this context, so an open one follows the map year and the
 * viewer language instead of the values captured when it was opened.
 */
const HistoryDetailsContext = createContext<HistoryDetails | null>(null);

/** The one Map-Scoped Timeline configuration of a History scenario (ADR 0005 snap/hold). */
function getHistoryTimelineOptions(scenarioId: DemoHistoricalPolityScenarioId) {
  const scenes = getDemoHistoricalPolityScenario(scenarioId).scenes;

  return scenarioId === "wwii-control"
    ? {
        playbackRate: wwiiPlaybackRateYearsPerSecond,
        timeRange: { end: scenes.at(-1)!.year, start: scenes[0]!.year },
        timeStep: "any" as const,
      }
    : {
        playbackRate: historyPlaybackRateYearsPerSecond,
        timeRange: { end: scenes.at(-1)!.year, start: scenes[0]!.year },
        timeStep: 1,
      };
}

function formatHistoryTime(time: number, scenarioId: DemoHistoricalPolityScenarioId) {
  if (scenarioId !== "wwii-control") {
    return formatDemoHistoricalPolityYear(time);
  }

  const year = Math.floor(time);
  const month = Math.min(12, Math.max(1, Math.round((time - year) * 12)));

  return `${monthLabels[month - 1]} ${year}`;
}

const getPolityFeatureId = (feature: GeoJsonLayerFeature<DemoHistoricalPolityProperties>) =>
  feature.properties.polityId;
const getPlaceFeatureId = (feature: PointLayerFeature) => feature.point.id;

export function HistoryDemoView({
  onMapControllerReady,
  onMapReady,
  onViewStateChange,
}: HistoryDemoViewProps) {
  const [scenarioId, setScenarioId] = useState<DemoHistoricalPolityScenarioId>("european-states");
  const [locale, setLocale] = useState<DemoHistoricalPlaceLocale>("en");
  const activeScenario = getDemoHistoricalPolityScenario(scenarioId);
  const historyStartYear = activeScenario.scenes[0]!.year;
  const historyEndYear = activeScenario.scenes.at(-1)!.year;
  // The single time authority of this Map View: boundaries, place pins, selection validity,
  // the slider, the epoch buttons and the mini-timeline all read or seek this one clock.
  const [clock] = useState(() =>
    createMapScopedTimelineClock(getHistoryTimelineOptions("european-states")),
  );
  const { isPlaying } = useMapScopedTimelineSnapshot(clock);
  const showsPlaces = scenarioId === "european-states";
  const historicalRecords = useMemo(
    () => [
      ...getDemoHistoricalPolityRecords(scenarioId),
      ...(scenarioId === "european-states" ? demoHistoricalPlaceRecords : []),
    ],
    [scenarioId],
  );
  const selection = useHistoricalMapFeatureSelection<unknown>({
    features: historicalRecords,
    locale,
    timeline: clock,
  });
  const year = selection.activeTime;
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
  const visiblePolities = useMemo(
    () =>
      activeFrame.features
        .filter(isDemoHistoricalPolityVisibleFeature)
        .map((feature) => ({ properties: feature.properties! }))
        .sort((left, right) => left.properties.label.localeCompare(right.properties.label)),
    [activeFrame],
  );
  const visiblePolityCount = visiblePolities.length;
  const applicablePlaces = useMemo(
    () => (showsPlaces ? getDemoHistoricalPlacesAt(year) : []),
    [showsPlaces, year],
  );
  const placePoints = useMemo<MapPoint[]>(
    () =>
      applicablePlaces.map((place) => ({
        id: place.record.id,
        latitude: place.coordinates[1],
        longitude: place.coordinates[0],
      })),
    [applicablePlaces],
  );
  const details = useMemo<HistoryDetails>(
    () => ({
      formatTime: (time) => formatHistoryTime(time, scenarioId),
      getPolityFeature: (featureId) =>
        visiblePolities.find((polity) => polity.properties.polityId === featureId) ?? null,
      scenarioId,
      selection,
      sourceSnapshotLabel: activeScene.label,
    }),
    [activeScene.label, scenarioId, selection, visiblePolities],
  );
  const selectedPolityId =
    selection.selectedFeatureId && !isDemoHistoricalPlaceId(selection.selectedFeatureId)
      ? selection.selectedFeatureId
      : "";

  useEffect(() => () => clock.dispose(), [clock]);

  const seek = (time: number) => {
    clock.pause();
    clock.seek(time);
  };
  const showScenario = (nextScenarioId: DemoHistoricalPolityScenarioId) => {
    if (nextScenarioId === scenarioId) {
      return;
    }

    const options = getHistoryTimelineOptions(nextScenarioId);

    // Selections never carry across scenarios: their Map Features belong to another dataset.
    selection.selectFeature(null);
    selection.dismissContext();
    clock.pause();
    clock.setOptions(options);
    clock.seek(options.timeRange.start);
    setScenarioId(nextScenarioId);
  };

  return (
    <HistoryDetailsContext.Provider value={details}>
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
              getFeatureId={getPolityFeatureId}
              hoveredFeatureId={selection.hoveredFeatureId}
              isFeatureInteractive={isDemoHistoricalPolityVisibleFeature}
              layerId="history-polities"
              onHoveredFeatureIdChange={selection.onHoveredFeatureIdChange}
              onSelectedFeatureIdChange={selection.onSelectedFeatureIdChange}
              renderFeaturePopup={renderHistoryPolityPopup}
              renderFeatureTooltip={renderHistoryPolityTooltip}
              selectedFeatureId={selection.selectedFeatureId}
            />
            <PointLayer
              getFeatureId={getPlaceFeatureId}
              getPointLabel={(feature) => selection.getFeatureName(feature.point.id)?.text ?? null}
              hoveredFeatureId={selection.hoveredFeatureId}
              layerId="history-places"
              onHoveredFeatureIdChange={selection.onHoveredFeatureIdChange}
              onSelectedFeatureIdChange={selection.onSelectedFeatureIdChange}
              pointColor="#b45309"
              pointRadius={7}
              points={placePoints}
              renderFeaturePopup={renderHistoryPlacePopup}
              renderFeatureTooltip={renderHistoryPlaceTooltip}
              selectedFeatureId={selection.selectedFeatureId}
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
              onClick={() => clock.togglePlayback()}
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
                  showScenario(scenario.id);
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
                seek(Number(event.currentTarget.value));
              }}
            />
          </label>

          <HistoricalMapFeatureContextPanel
            formatTime={details.formatTime}
            renderDetails={(context) => (
              <HistoryRetainedDetails
                contextTime={context.contextTime}
                featureId={context.featureId}
              />
            )}
            selection={selection}
          />

          <section aria-label="Selected feature" className="demo-history-selected">
            <h3>Selected feature</h3>
            {selection.selectedFeatureId ? (
              <>
                <HistoryFeatureDetails featureId={selection.selectedFeatureId} />
                <Button
                  size="sm"
                  type="button"
                  variant="secondary"
                  onClick={() => selection.selectFeature(null)}
                >
                  Clear selection
                </Button>
              </>
            ) : (
              <p>Select a polity or an illustrative place on the map or from the lists below.</p>
            )}
          </section>

          <div className="demo-history-epoch-buttons" aria-label="Historical epochs">
            {activeScenario.scenes.map((scene) => (
              <Button
                aria-label={`Show ${scene.label}`}
                key={scene.year}
                size="sm"
                variant={activeScene.year === scene.year ? "default" : "secondary"}
                type="button"
                onClick={() => {
                  seek(scene.year);
                }}
              >
                {scene.label}
              </Button>
            ))}
          </div>

          <fieldset className="demo-history-locales">
            <legend>Viewer language</legend>
            {demoHistoricalPlaceLocales.map((candidate) => (
              <label key={candidate}>
                <input
                  checked={locale === candidate}
                  name="history-viewer-language"
                  type="radio"
                  onChange={() => setLocale(candidate)}
                />
                <span lang={candidate}>{historyLocaleLabels[candidate]}</span>
              </label>
            ))}
            <small>
              Place names and their translations are illustrative fixtures. Polity names have no
              supplied translations, so they stay in the dataset&apos;s form.
            </small>
          </fieldset>

          <div className="demo-history-selectors">
            <label>
              <span>Select a polity at this date</span>
              <select
                aria-label="Select a polity at this date"
                value={selectedPolityId}
                onChange={(event) => {
                  const polity = details.getPolityFeature(event.currentTarget.value);

                  selection.selectFeature(polity ? polity.properties.polityId : null, polity);
                }}
              >
                <option value="">None</option>
                {visiblePolities.map((polity) => (
                  <option key={polity.properties.polityId} value={polity.properties.polityId}>
                    {scenarioId === "wwii-control"
                      ? `${polity.properties.label} (${polity.properties.polityId.replace(/^control-/, "")})`
                      : polity.properties.label}
                  </option>
                ))}
              </select>
            </label>
            {showsPlaces ? (
              <div>
                <span id="demo-history-places-label">Illustrative places at this date</span>
                <ul aria-labelledby="demo-history-places-label">
                  {applicablePlaces.map((place) => {
                    const name = selection.getFeatureName(place.record.id);

                    return (
                      <li key={place.record.id}>
                        <Button
                          aria-pressed={selection.selectedFeatureId === place.record.id}
                          lang={name?.language}
                          size="sm"
                          type="button"
                          variant={
                            selection.selectedFeatureId === place.record.id
                              ? "default"
                              : "secondary"
                          }
                          onClick={() => selection.selectFeature(place.record.id)}
                        >
                          {name?.text ?? place.record.id}
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : null}
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

          <p className="demo-history-caveat">{activeScenario.caveat}</p>
          {showsPlaces ? (
            <p className="demo-history-caveat">
              Place pins are illustrative fixtures: their names, translations, dates and positions
              are invented to demonstrate time-valid selection and are not historical evidence.
            </p>
          ) : null}
        </div>
      </section>
    </HistoryDetailsContext.Provider>
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

function renderHistoryPolityPopup(feature: GeoJsonLayerFeature<DemoHistoricalPolityProperties>) {
  return <HistoryFeatureDetails featureId={feature.properties.polityId} testId="history-popup" />;
}

function renderHistoryPolityTooltip(feature: GeoJsonLayerFeature<DemoHistoricalPolityProperties>) {
  return <HistoryFeatureName featureId={feature.properties.polityId} />;
}

function renderHistoryPlacePopup(feature: PointLayerFeature) {
  return <HistoryFeatureDetails featureId={feature.point.id} testId="history-popup" />;
}

function renderHistoryPlaceTooltip(feature: PointLayerFeature) {
  return <HistoryFeatureName featureId={feature.point.id} />;
}

/** The date-appropriate name at the map year, in the viewer language (Decisions 1.18, 1.20). */
function HistoryFeatureName({ featureId }: { featureId: string }) {
  const details = useContext(HistoryDetailsContext);
  const name = details?.selection.getFeatureName(featureId);

  return name ? (
    <span data-testid="history-tooltip" lang={name.language}>
      {name.text}
    </span>
  ) : null;
}

/**
 * Live details of a Map Feature that applies at the map year. Renders nothing once the
 * feature is out of period: its details then belong to the detached context panel.
 */
function HistoryFeatureDetails({ featureId, testId }: { featureId: string; testId?: string }) {
  const details = useContext(HistoryDetailsContext);

  if (!details || !details.selection.isFeatureApplicable(featureId)) {
    return null;
  }

  const { formatTime, scenarioId, selection, sourceSnapshotLabel } = details;
  const name = selection.getFeatureName(featureId);
  const mapDate = formatTime(selection.activeTime);

  if (isDemoHistoricalPlaceId(featureId)) {
    const record = demoHistoricalPlaceRecords.find((candidate) => candidate.id === featureId)!;

    return (
      <div className="demo-popup" data-history-feature={featureId} data-testid={testId}>
        <strong lang={name?.language}>{name?.text ?? featureId}</strong>
        <span data-history-status="illustrative">Illustrative place — not historical evidence</span>
        <span>Map date {mapDate}</span>
        {name?.sourceFormFallback ? (
          <span>No established form in this language; showing the attested original form.</span>
        ) : null}
        {name ? (
          <span lang={name.original.language}>
            Original form: {name.original.text}
            {name.original.script ? ` (${name.original.script})` : ""}
          </span>
        ) : null}
        <span>Modern equivalent: {record.modernName}</span>
        <span>Source: {demoHistoricalPlaceAttribution}</span>
      </div>
    );
  }

  const polity = details.getPolityFeature(featureId);

  if (!polity) {
    return null;
  }

  return (
    <div className="demo-popup" data-history-feature={featureId} data-testid={testId}>
      <strong lang={name?.language}>{name?.text ?? polity.properties.label}</strong>
      <span>
        Map date {mapDate} · source snapshot {sourceSnapshotLabel}
      </span>
      {name?.sourceFormFallback ? (
        <span>No established form in this language; showing the dataset&apos;s form.</span>
      ) : null}
      <HistoryPolityProvenance properties={polity.properties} scenarioId={scenarioId} />
    </div>
  );
}

/** Documentary-versus-illustrative disclosure of a selected boundary (Decision 1.3). */
function HistoryPolityProvenance({
  properties,
  scenarioId,
}: {
  properties: DemoHistoricalPolityProperties;
  scenarioId: DemoHistoricalPolityScenarioId;
}) {
  const status = getDemoHistoricalPolityBoundaryStatus(properties, scenarioId);

  return (
    <>
      <span>{historicalPolityRegionLabels[properties.region]} region</span>
      <span data-history-status={status.kind}>{status.label}</span>
      <span>Source: {status.source}</span>
      <span>{status.limitation}</span>
    </>
  );
}

/**
 * Consumer details of a retained out-of-period context: the feature as it was drawn at the
 * last map date at which it applied, not as it was when first clicked.
 */
function HistoryRetainedDetails({
  contextTime,
  featureId,
}: {
  contextTime: number;
  featureId: string;
}) {
  const details = useContext(HistoryDetailsContext);

  if (isDemoHistoricalPlaceId(featureId)) {
    return (
      <p className="demo-history-context-note" data-history-status="illustrative">
        Illustrative place — not historical evidence.
      </p>
    );
  }

  const properties = details
    ? getDemoHistoricalPolityPlaybackFrame(contextTime, details.scenarioId).features.find(
        (feature) => feature.properties?.polityId === featureId,
      )?.properties
    : null;

  if (!details || !properties) {
    return null;
  }

  return (
    <p className="demo-history-context-note demo-popup">
      <span>
        Source snapshot {getDemoHistoricalPolitySceneForYear(contextTime, details.scenarioId).label}
      </span>
      <HistoryPolityProvenance properties={properties} scenarioId={details.scenarioId} />
    </p>
  );
}
