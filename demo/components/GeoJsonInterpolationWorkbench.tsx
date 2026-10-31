import { useMemo, useState } from "react";

import { Button, NativeSelect } from "@moritzbrantner/ui";
import {
  GeoJsonLayer,
  MapView,
  createGeoJsonTransitionPlan,
  getBoundsFromGeoJson,
  getTemporalGeoJsonFeatureCollectionAtTime,
  interpolateGeoJsonTransitionPlan,
  type GeoJsonTopologyStrategy,
  type TemporalGeoJsonInterpolationStrategy,
} from "@moritzbrantner/maps";

import {
  createDemoInterpolationGeometryExamples,
  demoInterpolationExamples,
  demoInterpolationLandmassCollection,
  demoInterpolationLandmassConstraint,
  demoInterpolationStrategies,
  demoTopologyStrategies,
  getDemoInterpolationDefaultStrategy,
} from "../data/interpolation-examples";
import { demoMapStyle } from "../data/map-style";
import type { DemoE2ERegistration } from "../lib/e2e-probe";
import { countDemoGeometryParts, countDemoGeometryPositions } from "../lib/geojson-features";
import {
  constrainDemoInterpolationCollection,
  createDemoInterpolationFeatureCollection,
  getDemoInterpolationConstraintLayerStyle,
  getDemoInterpolationHandles,
  getDemoInterpolationLayerStyle,
  getDemoInterpolationPosition,
  getDemoInterpolationPreviewLayerStyle,
  isDemoPolygonLikeGeometryType,
  readDemoNumericProperty,
  readDemoTransitionKind,
  setDemoInterpolationPosition,
} from "../lib/interpolation-helpers";
import type { DemoInterpolationGeometryPair, DemoInterpolationKeyframeId } from "../types";

export function GeoJsonInterpolationWorkbench({
  e2eRegistration,
}: {
  e2eRegistration: DemoE2ERegistration;
}) {
  const [exampleId, setExampleId] = useState(demoInterpolationExamples[0]!.id);
  const example =
    demoInterpolationExamples.find((item) => item.id === exampleId) ??
    demoInterpolationExamples[0]!;
  const isTopologyExample = example.kind === "topology";
  const geometryType = example.geometryType;
  const [strategy, setStrategy] = useState<TemporalGeoJsonInterpolationStrategy>(
    getDemoInterpolationDefaultStrategy(demoInterpolationExamples[0]!),
  );
  const [topologyStrategy, setTopologyStrategy] =
    useState<Exclude<GeoJsonTopologyStrategy, "bounds">>("area-overlap");
  const [progress, setProgress] = useState(50);
  const [constrainToLandmass, setConstrainToLandmass] = useState(false);
  const [selectedKeyframe, setSelectedKeyframe] = useState<DemoInterpolationKeyframeId>("end");
  const [selectedHandleIndex, setSelectedHandleIndex] = useState(0);
  const [geometries, setGeometries] = useState<Record<string, DemoInterpolationGeometryPair>>(() =>
    createDemoInterpolationGeometryExamples(),
  );
  const geometryPair = isTopologyExample ? null : (geometries[example.id] ?? example.pair);
  const topologyPair = isTopologyExample
    ? {
        end: example.endCollection,
        start: example.startCollection,
      }
    : null;
  const handles = geometryPair ? getDemoInterpolationHandles(geometryPair[selectedKeyframe]) : [];
  const selectedHandle = handles[Math.min(selectedHandleIndex, handles.length - 1)] ?? null;
  const selectedPosition =
    geometryPair && selectedHandle
      ? getDemoInterpolationPosition(geometryPair[selectedKeyframe], selectedHandle.path)
      : ([0, 0] as [number, number]);
  const progressTime = progress / 100;
  const canConstrainToLandmass = isDemoPolygonLikeGeometryType(geometryType);
  const rawInterpolatedCollection = useMemo(() => {
    if (topologyPair) {
      if (progressTime <= 0) {
        return topologyPair.start;
      }

      if (progressTime >= 1) {
        return topologyPair.end;
      }

      return interpolateGeoJsonTransitionPlan(
        createGeoJsonTransitionPlan(topologyPair.start, topologyPair.end, {
          algorithm: "topology-plan",
          topologyStrategy,
        }),
        progressTime,
      );
    }

    return getTemporalGeoJsonFeatureCollectionAtTime(
      [
        {
          id: "interpolation-preview",
          label: `${geometryType} preview`,
          frames: [
            {
              geometry: geometryPair!.start,
              time: 0,
            },
            {
              geometry: geometryPair!.end,
              time: 1,
            },
          ],
        },
      ],
      progressTime,
      {
        fallback: "hold",
        minResampleCoordinates: 24,
        strategy,
      },
    );
  }, [geometryPair, geometryType, progressTime, strategy, topologyPair, topologyStrategy]);
  const interpolatedCollection =
    constrainToLandmass && canConstrainToLandmass
      ? constrainDemoInterpolationCollection(
          rawInterpolatedCollection,
          demoInterpolationLandmassConstraint,
        )
      : rawInterpolatedCollection;
  const startCollection = topologyPair
    ? topologyPair.start
    : createDemoInterpolationFeatureCollection("start", "Start keyframe", geometryPair!.start);
  const endCollection = topologyPair
    ? topologyPair.end
    : createDemoInterpolationFeatureCollection("end", "End keyframe", geometryPair!.end);
  const previewFeature = interpolatedCollection.features[0] ?? null;
  const previewGeometry =
    previewFeature?.geometry ??
    geometryPair?.start ??
    topologyPair?.start.features[0]?.geometry ??
    ({ coordinates: [0, 0], type: "Point" } as const);
  const bounds = getBoundsFromGeoJson({
    features: [
      ...startCollection.features,
      ...endCollection.features,
      ...interpolatedCollection.features,
    ],
    type: "FeatureCollection",
  });
  const strategyDetails = demoInterpolationStrategies.find((item) => item.id === strategy);
  const setExampleFromControl = (nextExampleId: string) => {
    const nextExample =
      demoInterpolationExamples.find((item) => item.id === nextExampleId) ??
      demoInterpolationExamples[0]!;

    setExampleId(nextExample.id);
    setStrategy(getDemoInterpolationDefaultStrategy(nextExample));
    setTopologyStrategy("area-overlap");
    setSelectedHandleIndex(0);
  };
  const updateSelectedPosition = (axis: 0 | 1, value: number) => {
    if (!geometryPair || !selectedHandle || !Number.isFinite(value)) {
      return;
    }

    const nextPosition: [number, number] =
      axis === 0 ? [value, selectedPosition[1]] : [selectedPosition[0], value];

    setGeometries((current) => {
      const currentPair = current[example.id] ?? example.pair;

      return {
        ...current,
        [example.id]: {
          ...currentPair,
          [selectedKeyframe]: setDemoInterpolationPosition(
            currentPair[selectedKeyframe],
            selectedHandle.path,
            nextPosition,
          ),
        },
      };
    });
  };
  const resetCurrentGeometry = () => {
    if (isTopologyExample) {
      setProgress(50);
      setTopologyStrategy("area-overlap");
      setSelectedHandleIndex(0);
      return;
    }

    setGeometries((current) => ({
      ...current,
      [example.id]: example.pair,
    }));
    setStrategy(getDemoInterpolationDefaultStrategy(example));
    setProgress(50);
    setSelectedHandleIndex(0);
  };
  const transitionKinds = [
    ...new Set(
      interpolatedCollection.features.flatMap((feature) => {
        const kind = readDemoTransitionKind(feature.properties);

        return typeof kind === "string" ? [kind] : [];
      }),
    ),
  ];
  const totalFlowArea = interpolatedCollection.features.reduce(
    (sum, feature) => sum + readDemoNumericProperty(feature.properties, "flowArea"),
    0,
  );

  return (
    <section className="demo-interpolation-workbench" aria-label="GeoJSON interpolation workbench">
      <div className="demo-interpolation-workbench__map">
        <MapView
          dataBounds={bounds}
          defaultViewState={{ center: [6.5, 48.5], zoom: 4.2 }}
          fitBoundsPadding={72}
          mapLabel="GeoJSON interpolation preview"
          mapStyle={demoMapStyle}
          onMapControllerReady={e2eRegistration.onMapControllerReady}
          onMapReady={e2eRegistration.onMapReady}
          style={{ minHeight: 620 }}
        >
          <GeoJsonLayer
            featureCollection={startCollection}
            getFeatureStyle={() => getDemoInterpolationLayerStyle("start", geometryType)}
            layerId="interpolation-start"
            renderFeatureTooltip={() => "Start keyframe"}
          />
          <GeoJsonLayer
            featureCollection={endCollection}
            getFeatureStyle={() => getDemoInterpolationLayerStyle("end", geometryType)}
            layerId="interpolation-end"
            renderFeatureTooltip={() => "End keyframe"}
          />
          {constrainToLandmass && canConstrainToLandmass ? (
            <GeoJsonLayer
              featureCollection={demoInterpolationLandmassCollection}
              getFeatureStyle={() => getDemoInterpolationConstraintLayerStyle()}
              layerId="interpolation-constraint"
              renderFeatureTooltip={() => "Constraint polygon"}
            />
          ) : null}
          <GeoJsonLayer
            featureCollection={interpolatedCollection}
            getFeatureStyle={(feature) =>
              getDemoInterpolationPreviewLayerStyle(feature, geometryType)
            }
            layerId="interpolation-preview"
            renderFeaturePopup={(feature) => (
              <div className="demo-popup">
                <strong>{feature.geometry.type} interpolation</strong>
                <span>
                  {isTopologyExample ? "Topology plan" : (strategyDetails?.label ?? strategy)}
                </span>
                <span>{progress}% between keyframes</span>
                <span>{countDemoGeometryPositions(feature.geometry)} coordinates</span>
              </div>
            )}
            renderFeatureTooltip={() => `${geometryType} at ${progress}%`}
          />
        </MapView>
        <div className="demo-interpolation-legend" aria-label="Interpolation layers">
          <span>
            <i className="demo-interpolation-legend__start" /> Start
          </span>
          <span>
            <i className="demo-interpolation-legend__preview" /> Interpolated
          </span>
          <span>
            <i className="demo-interpolation-legend__end" /> End
          </span>
        </div>
      </div>

      <div className="demo-interpolation-panel">
        <div className="demo-layer-manager__header">
          <h2>Interpolation</h2>
          <Button size="sm" variant="secondary" type="button" onClick={resetCurrentGeometry}>
            Reset
          </Button>
        </div>

        <label className="grid gap-1 text-xs font-medium text-muted-foreground">
          <span>Example</span>
          <NativeSelect
            value={example.id}
            onChange={(event) => setExampleFromControl(event.target.value)}
          >
            {demoInterpolationExamples.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </NativeSelect>
        </label>

        {isTopologyExample ? (
          <label className="grid gap-1 text-xs font-medium text-muted-foreground">
            <span>Topology strategy</span>
            <NativeSelect
              value={topologyStrategy}
              onChange={(event) =>
                setTopologyStrategy(
                  event.target.value as Exclude<GeoJsonTopologyStrategy, "bounds">,
                )
              }
            >
              {demoTopologyStrategies.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </NativeSelect>
          </label>
        ) : (
          <label className="grid gap-1 text-xs font-medium text-muted-foreground">
            <span>Algorithm</span>
            <NativeSelect
              value={strategy}
              onChange={(event) =>
                setStrategy(event.target.value as TemporalGeoJsonInterpolationStrategy)
              }
            >
              {demoInterpolationStrategies.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </NativeSelect>
          </label>
        )}

        <div className="demo-interpolation-note">
          <strong>{geometryType}</strong>
          <span>{example.description}</span>
          <span>
            {isTopologyExample
              ? "Uses collection-level topology planning across all scene features."
              : (strategyDetails?.description ??
                "Uses the selected temporal GeoJSON interpolation mode.")}
          </span>
        </div>

        <label className="demo-interpolation-toggle" aria-disabled={!canConstrainToLandmass}>
          <input
            checked={constrainToLandmass && canConstrainToLandmass}
            disabled={!canConstrainToLandmass}
            type="checkbox"
            onChange={(event) => setConstrainToLandmass(event.target.checked)}
          />
          <span>Constrain to landmass</span>
        </label>

        <label className="demo-interpolation-range">
          <span>
            <strong>Progress</strong>
            <em>{progress}%</em>
          </span>
          <input
            aria-label="Interpolation progress"
            max={100}
            min={0}
            step={1}
            type="range"
            value={progress}
            onChange={(event) => setProgress(Number(event.target.value))}
          />
        </label>

        {!isTopologyExample ? (
          <>
            <div className="demo-interpolation-keyframes" aria-label="Keyframe selector">
              <Button
                size="sm"
                variant={selectedKeyframe === "start" ? "default" : "secondary"}
                type="button"
                onClick={() => setSelectedKeyframe("start")}
              >
                Start
              </Button>
              <Button
                size="sm"
                variant={selectedKeyframe === "end" ? "default" : "secondary"}
                type="button"
                onClick={() => setSelectedKeyframe("end")}
              >
                End
              </Button>
            </div>

            <label className="grid gap-1 text-xs font-medium text-muted-foreground">
              <span>Coordinate handle</span>
              <NativeSelect
                value={String(Math.min(selectedHandleIndex, handles.length - 1))}
                onChange={(event) => setSelectedHandleIndex(Number(event.target.value))}
              >
                {handles.map((handle, index) => (
                  <option key={handle.label} value={index}>
                    {handle.label}
                  </option>
                ))}
              </NativeSelect>
            </label>

            <div className="demo-coordinate-grid">
              <label>
                <span>Longitude</span>
                <input
                  step={0.1}
                  type="number"
                  value={Number(selectedPosition[0].toFixed(4))}
                  onChange={(event) => updateSelectedPosition(0, Number(event.target.value))}
                />
              </label>
              <label>
                <span>Latitude</span>
                <input
                  step={0.1}
                  type="number"
                  value={Number(selectedPosition[1].toFixed(4))}
                  onChange={(event) => updateSelectedPosition(1, Number(event.target.value))}
                />
              </label>
            </div>
          </>
        ) : null}

        <dl className="demo-interpolation-facts">
          <div>
            <dt>Preview type</dt>
            <dd>{previewGeometry.type}</dd>
          </div>
          <div>
            <dt>Preview coordinates</dt>
            <dd>{countDemoGeometryPositions(previewGeometry)}</dd>
          </div>
          <div>
            <dt>Parts</dt>
            <dd>{countDemoGeometryParts(previewGeometry)}</dd>
          </div>
          <div>
            <dt>{isTopologyExample ? "Start features" : "Start"}</dt>
            <dd>
              {isTopologyExample
                ? startCollection.features.length
                : `${geometryPair!.start.type} / ${countDemoGeometryPositions(geometryPair!.start)}`}
            </dd>
          </div>
          <div>
            <dt>{isTopologyExample ? "End features" : "End"}</dt>
            <dd>
              {isTopologyExample
                ? endCollection.features.length
                : `${geometryPair!.end.type} / ${countDemoGeometryPositions(geometryPair!.end)}`}
            </dd>
          </div>
          {isTopologyExample ? (
            <>
              <div>
                <dt>Strategy</dt>
                <dd>
                  {demoTopologyStrategies.find((item) => item.id === topologyStrategy)?.label}
                </dd>
              </div>
              <div>
                <dt>Preview features</dt>
                <dd>{interpolatedCollection.features.length}</dd>
              </div>
              <div>
                <dt>Kinds</dt>
                <dd>{transitionKinds.length > 0 ? transitionKinds.join(", ") : "scene"}</dd>
              </div>
              <div>
                <dt>Total flow area</dt>
                <dd>{totalFlowArea.toFixed(2)}</dd>
              </div>
            </>
          ) : null}
        </dl>
      </div>
    </section>
  );
}
