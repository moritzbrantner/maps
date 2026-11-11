import { intersection, type MultiPolygon as ClippingMultiPolygon } from "polygon-clipping";

import type {
  HistoricalMapFeatureName,
  HistoricalMapFeaturePeriod,
  HistoricalMapFeatureRecord,
  TemporalGeoJsonGeometryFeature,
  TemporalGeoJsonGeometryFeatureCollection,
  TemporalGeoJsonSupportedGeometry,
} from "@moritzbrantner/maps";
import { interpolateTemporalGeoJsonGeometry } from "@moritzbrantner/maps";

import { isDemoSupportedGeometry } from "../lib/geojson-features";
import cshapesEuropePolityScenesFixture from "./cshapes-europe-polity-scenes.json";
import wwiiControlScenesFixture from "./wwii-control-scenes.json";
import {
  demoCompetingSourcesCaveat,
  demoCompetingSourcesReconstructions,
  demoCompetingSourcesRegions,
  demoCompetingSourcesScenes,
} from "./history-competing-sources";

export type DemoHistoricalPolityRegion =
  | "atlantic"
  | "central"
  | "eastern"
  | "nordic"
  | "southern"
  | "ottoman";

export type DemoHistoricalPolityPrecision = "source-derived" | "synthetic";

export type DemoHistoricalPolityProperties = {
  controlArea?: number;
  kind: "historical-polity";
  label: string;
  polityId: string;
  precision: DemoHistoricalPolityPrecision;
  region: DemoHistoricalPolityRegion;
  sceneYear: number;
  source: "CShapes-Europe" | "Synthetic fixture";
  sourceFrom: number;
  sourceId: number;
  sourceStatus: "independent";
  sourceTo: number;
};

export type DemoHistoricalPolitySceneValidationIssue = {
  code: "invalid-geometry" | "missing-source" | "overlapping-polities" | "unclosed-ring";
  message: string;
  polityId: string;
  sceneYear: number;
};

type DemoHistoricalPolityScene = {
  label: string;
  year: number;
  collection: TemporalGeoJsonGeometryFeatureCollection<DemoHistoricalPolityProperties>;
};

export type DemoHistoricalPolityScenarioId =
  | "european-states"
  | "wwii-control"
  | "synthetic-competing-sources";

export type DemoHistoricalPolityScenario = {
  caveat: string;
  id: DemoHistoricalPolityScenarioId;
  label: string;
  scenes: DemoHistoricalPolityScene[];
};

type HistoricalPolityRenderableFeature = {
  id?: string | number;
  properties?: Partial<DemoHistoricalPolityProperties> | null;
};

type PolygonLikeGeometry =
  | Extract<TemporalGeoJsonSupportedGeometry, { type: "Polygon" }>
  | Extract<TemporalGeoJsonSupportedGeometry, { type: "MultiPolygon" }>;

const historyOverlapAreaThreshold = 1e-9;
const cshapesEuropePolityScenes = cshapesEuropePolityScenesFixture as {
  scenes: DemoHistoricalPolityScene[];
};
const wwiiControlScenes = wwiiControlScenesFixture as {
  scenes: DemoHistoricalPolityScene[];
};

export const demoHistoricalPolityScenarios: DemoHistoricalPolityScenario[] = [
  {
    caveat:
      "Boundaries derived from CShapes-Europe. Demo snapshots are not an authoritative historical boundary source.",
    id: "european-states",
    label: "European states",
    scenes: cshapesEuropePolityScenes.scenes,
  },
  {
    caveat:
      "WWII control uses CShapes-Europe country outlines with illustrative campaign-phase control clipping; internal moving fronts are not authoritative.",
    id: "wwii-control",
    label: "WWII control",
    scenes: wwiiControlScenes.scenes,
  },
  {
    caveat: demoCompetingSourcesCaveat,
    id: "synthetic-competing-sources",
    label: "Competing sources (synthetic)",
    scenes: buildDemoCompetingSourcesScenes(),
  },
];

/** Synthetic scenes in the History scene shape; never CShapes-derived (ADR 0005). */
function buildDemoCompetingSourcesScenes(): DemoHistoricalPolityScene[] {
  const labels = new Map(
    demoCompetingSourcesRegions.map((region) => [region.polityId, region.label]),
  );

  return demoCompetingSourcesScenes.map((scene, sceneIndex) => {
    const nextYear = demoCompetingSourcesScenes[sceneIndex + 1]?.year ?? scene.year;

    return {
      collection: {
        features: scene.regions.map((region, regionIndex) => ({
          geometry: { coordinates: [region.ring], type: "Polygon" as const },
          id: `${region.polityId}-${scene.year}`,
          properties: {
            kind: "historical-polity" as const,
            label: labels.get(region.polityId) ?? region.polityId,
            polityId: region.polityId,
            precision: "synthetic" as const,
            region: regionIndex === 0 ? ("southern" as const) : ("central" as const),
            sceneYear: scene.year,
            source: "Synthetic fixture" as const,
            sourceFrom: scene.year,
            sourceId: 0,
            sourceStatus: "independent" as const,
            sourceTo: nextYear,
          },
          type: "Feature" as const,
        })),
        type: "FeatureCollection" as const,
      },
      label: scene.label,
      year: scene.year,
    };
  });
}

export const demoHistoricalPolityScenes: DemoHistoricalPolityScene[] =
  getDemoHistoricalPolityScenario("european-states").scenes;

export function formatDemoHistoricalPolityYear(year: number) {
  return `${Math.round(year)} AD`;
}

export function getDemoHistoricalPolityFrame(
  year: number,
  scenarioId: DemoHistoricalPolityScenarioId = "european-states",
): TemporalGeoJsonGeometryFeatureCollection<DemoHistoricalPolityProperties> {
  return getDemoHistoricalPolityPlaybackFrame(year, scenarioId);
}

export function getDemoHistoricalPolityPlaybackFrame(
  year: number,
  scenarioId: DemoHistoricalPolityScenarioId = "european-states",
): TemporalGeoJsonGeometryFeatureCollection<DemoHistoricalPolityProperties> {
  if (scenarioId === "wwii-control") {
    return getInterpolatedDemoHistoricalPolityScenarioFrame(year, scenarioId);
  }

  return getDemoHistoricalPolitySceneForYear(year, scenarioId).collection;
}

export function getDemoHistoricalPolitySceneForYear(
  year: number,
  scenarioId: DemoHistoricalPolityScenarioId = "european-states",
) {
  const scenes = getDemoHistoricalPolityScenario(scenarioId).scenes;
  const timelineYear = scenarioId === "wwii-control" ? year : Math.floor(year);
  const clampedYear = clamp(timelineYear, scenes[0]!.year, scenes.at(-1)!.year);
  const nextSceneIndex = scenes.findIndex((scene) => scene.year > clampedYear);

  if (nextSceneIndex === -1) {
    return scenes.at(-1)!;
  }

  return scenes[Math.max(0, nextSceneIndex - 1)]!;
}

export function getDemoHistoricalPolityScenario(scenarioId: DemoHistoricalPolityScenarioId) {
  return (
    demoHistoricalPolityScenarios.find((scenario) => scenario.id === scenarioId) ??
    demoHistoricalPolityScenarios[0]!
  );
}

function getInterpolatedDemoHistoricalPolityScenarioFrame(
  year: number,
  scenarioId: DemoHistoricalPolityScenarioId,
): TemporalGeoJsonGeometryFeatureCollection<DemoHistoricalPolityProperties> {
  const scenario = getDemoHistoricalPolityScenario(scenarioId);
  const scenes = scenario.scenes;
  const clampedYear = clamp(year, scenes[0]!.year, scenes.at(-1)!.year);
  const exactScene = scenes.find((scene) => scene.year === clampedYear);

  if (exactScene) {
    return exactScene.collection;
  }

  const nextSceneIndex = scenes.findIndex((scene) => scene.year > clampedYear);
  const previousScene = scenes[Math.max(0, nextSceneIndex - 1)]!;
  const nextScene = scenes[nextSceneIndex] ?? scenes.at(-1)!;
  const progress = (clampedYear - previousScene.year) / (nextScene.year - previousScene.year);
  const nextById = new Map(
    nextScene.collection.features.map((feature) => [feature.properties?.polityId, feature]),
  );

  return {
    features: previousScene.collection.features.map((previousFeature) => {
      const nextFeature = nextById.get(previousFeature.properties?.polityId);

      if (
        !isDemoSupportedGeometry(previousFeature.geometry) ||
        !isDemoSupportedGeometry(nextFeature?.geometry)
      ) {
        return {
          ...previousFeature,
          properties: {
            ...previousFeature.properties!,
            sceneYear: clampedYear,
          },
        };
      }

      const geometry =
        interpolateTemporalGeoJsonGeometry(
          previousFeature.geometry,
          nextFeature.geometry,
          progress,
          {
            fallback: "hold",
            minResampleCoordinates: 64,
            partMatchingStrategy: "auto",
            strategy: "vertex-union",
          },
        ) ?? previousFeature.geometry;

      return {
        geometry,
        id: previousFeature.id,
        properties: {
          ...previousFeature.properties!,
          controlArea: interpolateNumber(
            previousFeature.properties!.controlArea,
            nextFeature.properties!.controlArea,
            progress,
          ),
          sceneYear: clampedYear,
          sourceTo: nextFeature.properties!.sourceTo,
        },
        type: "Feature" as const,
      };
    }),
    type: "FeatureCollection",
  };
}

export type DemoHistoricalPolityBoundaryStatus = {
  /** `source-derived`: a dataset snapshot. `illustrative`: generated for explanation. */
  kind: "illustrative" | "source-derived";
  label: string;
  /** The limitation a viewer must read next to the boundary (Decision 1.3). */
  limitation: string;
  source: string;
};

/**
 * What a selected boundary of `scenarioId` is, as disclosed to the viewer (Decision 1.3).
 * It restates the scenario's existing ADR 0005 notice per feature; it adds no new claim.
 */
export function getDemoHistoricalPolityBoundaryStatus(
  properties: Pick<DemoHistoricalPolityProperties, "sourceFrom" | "sourceTo">,
  scenarioId: DemoHistoricalPolityScenarioId,
): DemoHistoricalPolityBoundaryStatus {
  if (scenarioId === "wwii-control") {
    return {
      kind: "illustrative",
      label: "Illustrative boundary",
      limitation:
        "Control area generated by campaign-phase clipping of CShapes-Europe outlines; moving fronts are not authoritative.",
      source: "CShapes-Europe country outlines, clipped for illustration",
    };
  }

  if (scenarioId === "synthetic-competing-sources") {
    return {
      kind: "illustrative",
      label: "Synthetic boundary fixture",
      limitation: "Invented to demonstrate source presentation; not historical evidence.",
      source: "Synthetic fixture",
    };
  }

  return {
    kind: "source-derived",
    label: "Source-derived boundary",
    limitation:
      "Demo snapshot held from its milestone year; not an authoritative historical boundary source.",
    source: `CShapes-Europe record ${properties.sourceFrom}–${properties.sourceTo}`,
  };
}

/**
 * Selection records for a scenario's polities, derived only from its scenes: a polity applies
 * from each milestone scene that contains it until the next milestone (ADR 0005 snap/hold),
 * and only its milestone years are offered as supported dates. Identity is the dataset's own
 * polity ID; nothing links polities with different IDs, however similar their names.
 */
export function getDemoHistoricalPolityRecords(
  scenarioId: DemoHistoricalPolityScenarioId,
): HistoricalMapFeatureRecord[] {
  const scenario = getDemoHistoricalPolityScenario(scenarioId);
  const attribution =
    scenarioId === "wwii-control"
      ? "CShapes-Europe outlines with illustrative control clipping"
      : scenarioId === "synthetic-competing-sources"
        ? "Synthetic fixture (illustrative, not a source)"
        : "CShapes-Europe (demo snapshot)";
  const records = new Map<
    string,
    HistoricalMapFeatureRecord & {
      names: HistoricalMapFeatureName[];
      periods: HistoricalMapFeaturePeriod[];
      supportedDates: { label: string; time: number }[];
    }
  >();

  scenario.scenes.forEach((scene, sceneIndex) => {
    const nextScene = scenario.scenes[sceneIndex + 1];

    for (const feature of scene.collection.features) {
      const properties = feature.properties;

      if (!properties) {
        continue;
      }

      const id = properties.polityId;
      const record = records.get(id) ?? {
        attribution,
        id,
        names: [],
        periods: [],
        supportedDates: [],
      };
      const previousPeriod = record.periods.at(-1);
      const previousName = record.names.at(-1);

      records.set(id, record);
      record.supportedDates.push({ label: scene.label, time: scene.year });

      if (previousPeriod && previousPeriod.end === scene.year) {
        previousPeriod.end = nextScene?.year;
      } else {
        record.periods.push({ end: nextScene?.year, start: scene.year });
      }

      if (
        previousName &&
        previousName.end === scene.year &&
        previousName.original.text === properties.label
      ) {
        previousName.end = nextScene?.year;
      } else {
        record.names.push({
          attribution,
          end: nextScene?.year,
          // The dataset's English name. No German or Spanish forms are supplied, so those
          // viewers get the flagged source-form fallback rather than an invented translation.
          localized: { en: properties.label },
          original: { language: "en", text: properties.label },
          start: scene.year,
        });
      }
    }
  });

  const sceneLabels = new Map(scenario.scenes.map((scene) => [scene.year, scene.label]));

  return [...records.values()].map((record) => ({
    ...record,
    // Only the synthetic scenario supplies chosen reconstructions with alternatives (1.12);
    // the CShapes-derived scenarios keep their ADR 0005 status disclosure unchanged.
    ...(scenarioId === "synthetic-competing-sources"
      ? {
          reconstructions: demoCompetingSourcesReconstructions[record.id] ?? [],
        }
      : {}),
    periods: record.periods.map((period) => ({
      ...period,
      label:
        period.end === undefined
          ? `snapshot from ${sceneLabels.get(period.start)}`
          : `snapshot held ${sceneLabels.get(period.start)} until ${sceneLabels.get(period.end)}`,
    })),
  }));
}

export function isDemoHistoricalPolityVisibleFeature(feature: HistoricalPolityRenderableFeature) {
  return feature.properties?.kind === "historical-polity";
}

export function getDemoHistoricalPolityRenderFeatureId(
  feature: HistoricalPolityRenderableFeature,
  _year: number,
) {
  const properties = feature.properties;

  return String(feature.id ?? properties?.polityId ?? properties?.label ?? "historical-polity");
}

export function validateDemoHistoricalPolityScenes(
  scenes: readonly DemoHistoricalPolityScene[] = demoHistoricalPolityScenes,
): DemoHistoricalPolitySceneValidationIssue[] {
  return scenes.flatMap((scene) => [
    ...validateDemoHistoricalPolitySceneFeatures(scene),
    ...validateDemoHistoricalPolitySceneOverlaps(scene),
  ]);
}

function validateDemoHistoricalPolitySceneFeatures(
  scene: DemoHistoricalPolityScene,
): DemoHistoricalPolitySceneValidationIssue[] {
  return scene.collection.features.flatMap((feature) => {
    const polityId = feature.properties?.polityId ?? String(feature.id ?? "historical-polity");
    const sceneYear = feature.properties?.sceneYear ?? scene.year;
    const issues: DemoHistoricalPolitySceneValidationIssue[] = [];

    if (
      feature.properties?.source !== "CShapes-Europe" ||
      typeof feature.properties.sourceId !== "number" ||
      typeof feature.properties.sourceFrom !== "number" ||
      typeof feature.properties.sourceTo !== "number" ||
      feature.properties.sourceStatus !== "independent"
    ) {
      issues.push({
        code: "missing-source",
        message: "Historical Polity Scenes must include CShapes-Europe source metadata.",
        polityId,
        sceneYear,
      });
    }

    if (isPolygonLikeGeometry(feature.geometry) && feature.geometry.type === "Polygon") {
      issues.push(
        ...validateDemoHistoricalPolityPolygon(feature.geometry.coordinates, polityId, sceneYear),
      );

      return issues;
    }

    if (isPolygonLikeGeometry(feature.geometry) && feature.geometry.type === "MultiPolygon") {
      issues.push(
        ...feature.geometry.coordinates.flatMap((polygon) =>
          validateDemoHistoricalPolityPolygon(polygon, polityId, sceneYear),
        ),
      );

      return issues;
    }

    issues.push({
      code: "invalid-geometry",
      message: "Historical Polity Scenes must use Polygon or MultiPolygon geometries.",
      polityId,
      sceneYear,
    });

    return issues;
  });
}

function validateDemoHistoricalPolitySceneOverlaps(
  scene: DemoHistoricalPolityScene,
): DemoHistoricalPolitySceneValidationIssue[] {
  const polygonFeatures = scene.collection.features.flatMap((feature) =>
    isPolygonLikeGeometry(feature.geometry)
      ? [{ bounds: getGeometryBounds(feature.geometry), feature }]
      : [],
  );
  const issues: DemoHistoricalPolitySceneValidationIssue[] = [];

  for (let leftIndex = 0; leftIndex < polygonFeatures.length; leftIndex += 1) {
    const left = polygonFeatures[leftIndex]!;

    for (let rightIndex = leftIndex + 1; rightIndex < polygonFeatures.length; rightIndex += 1) {
      const right = polygonFeatures[rightIndex]!;

      if (!boundsIntersect(left.bounds, right.bounds)) {
        continue;
      }

      const overlap = fromClippingMultiPolygon(
        intersection(
          toClippingMultiPolygon(left.feature.geometry as PolygonLikeGeometry),
          toClippingMultiPolygon(right.feature.geometry as PolygonLikeGeometry),
        ),
      );

      if (overlap && getPolygonLikeArea(overlap) > historyOverlapAreaThreshold) {
        issues.push({
          code: "overlapping-polities",
          message: "Historical Polity Scene features must not overlap each other.",
          polityId: `${left.feature.properties?.polityId ?? left.feature.id} / ${
            right.feature.properties?.polityId ?? right.feature.id
          }`,
          sceneYear: scene.year,
        });
      }
    }
  }

  return issues;
}

function validateDemoHistoricalPolityPolygon(
  polygon: readonly (readonly (readonly number[])[])[],
  polityId: string,
  sceneYear: number,
): DemoHistoricalPolitySceneValidationIssue[] {
  return polygon.flatMap((ring) => validateDemoHistoricalPolityRing(ring, polityId, sceneYear));
}

function validateDemoHistoricalPolityRing(
  ring: readonly (readonly number[])[],
  polityId: string,
  sceneYear: number,
): DemoHistoricalPolitySceneValidationIssue[] {
  const first = ring[0];
  const last = ring.at(-1);

  if (!first || !last || first[0] !== last[0] || first[1] !== last[1]) {
    return [
      {
        code: "unclosed-ring",
        message: "Historical Polity polygon rings must be closed.",
        polityId,
        sceneYear,
      },
    ];
  }

  return [];
}

function isPolygonLikeGeometry(
  geometry: TemporalGeoJsonGeometryFeature<DemoHistoricalPolityProperties>["geometry"],
): geometry is PolygonLikeGeometry {
  return geometry?.type === "Polygon" || geometry?.type === "MultiPolygon";
}

function toClippingMultiPolygon(geometry: PolygonLikeGeometry): ClippingMultiPolygon {
  if (geometry.type === "Polygon") {
    return [geometry.coordinates.map(normalizeClippingRing)];
  }

  return geometry.coordinates.map((polygon) => polygon.map(normalizeClippingRing));
}

function fromClippingMultiPolygon(output: ClippingMultiPolygon): PolygonLikeGeometry | null {
  const polygons = output
    .map((polygon) =>
      polygon
        .map((ring) =>
          closeRing(ring.map((position) => [position[0], position[1]] as [number, number])),
        )
        .filter(
          (ring) => ring.length >= 4 && Math.abs(getRingArea(ring)) > historyOverlapAreaThreshold,
        ),
    )
    .filter(
      (polygon) =>
        polygon.length > 0 && Math.abs(getRingArea(polygon[0]!)) > historyOverlapAreaThreshold,
    );

  if (polygons.length === 0) {
    return null;
  }

  return polygons.length === 1
    ? { coordinates: polygons[0]!, type: "Polygon" }
    : { coordinates: polygons, type: "MultiPolygon" };
}

function normalizeClippingRing(ring: readonly (readonly number[])[]) {
  return closeRing(
    ring.map((position) => [Number(position[0]), Number(position[1])] as [number, number]),
  ).map((position): [number, number] => [position[0], position[1]]);
}

function closeRing(ring: readonly [number, number][]) {
  if (ring.length === 0) {
    return [];
  }

  const openRing =
    ring.length >= 2 && ring[0]![0] === ring.at(-1)![0] && ring[0]![1] === ring.at(-1)![1]
      ? ring.slice(0, -1)
      : ring;
  const first = openRing[0]!;

  return [
    ...openRing.map((position) => [position[0], position[1]] as [number, number]),
    [first[0], first[1]] as [number, number],
  ];
}

function getPolygonLikeArea(geometry: PolygonLikeGeometry) {
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;

  return Math.abs(
    polygons.reduce(
      (sum, polygon) =>
        sum +
        polygon.reduce((polygonSum, ring, ringIndex) => {
          const area = Math.abs(getRingArea(ring));

          return ringIndex === 0 ? polygonSum + area : polygonSum - area;
        }, 0),
      0,
    ),
  );
}

function getRingArea(ring: readonly (readonly number[])[]) {
  return (
    ring.slice(0, -1).reduce((sum, position, index) => {
      const nextPosition = ring[index + 1]!;

      return sum + position[0]! * nextPosition[1]! - nextPosition[0]! * position[1]!;
    }, 0) / 2
  );
}

function getGeometryBounds(geometry: PolygonLikeGeometry) {
  const positions = (
    geometry.type === "Polygon" ? geometry.coordinates : geometry.coordinates.flat()
  )
    .flat()
    .filter((position) => Array.isArray(position) && position.length >= 2);

  return positions.reduce(
    (bounds, position) => ({
      east: Math.max(bounds.east, position[0]!),
      north: Math.max(bounds.north, position[1]!),
      south: Math.min(bounds.south, position[1]!),
      west: Math.min(bounds.west, position[0]!),
    }),
    {
      east: Number.NEGATIVE_INFINITY,
      north: Number.NEGATIVE_INFINITY,
      south: Number.POSITIVE_INFINITY,
      west: Number.POSITIVE_INFINITY,
    },
  );
}

function boundsIntersect(
  left: ReturnType<typeof getGeometryBounds>,
  right: ReturnType<typeof getGeometryBounds>,
) {
  return (
    left.west <= right.east &&
    left.east >= right.west &&
    left.south <= right.north &&
    left.north >= right.south
  );
}

function interpolateNumber(left: number | undefined, right: number | undefined, progress: number) {
  if (typeof left !== "number" || typeof right !== "number") {
    return left ?? right;
  }

  return left + (right - left) * progress;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}
