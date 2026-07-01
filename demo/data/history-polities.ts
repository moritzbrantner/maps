import { intersection, type MultiPolygon as ClippingMultiPolygon } from "polygon-clipping";

import type {
  TemporalGeoJsonGeometryFeature,
  TemporalGeoJsonGeometryFeatureCollection,
  TemporalGeoJsonSupportedGeometry,
} from "@moritzbrantner/maps";
import { interpolateTemporalGeoJsonGeometry } from "@moritzbrantner/maps";

import cshapesEuropePolityScenesFixture from "./cshapes-europe-polity-scenes.json";
import wwiiControlScenesFixture from "./wwii-control-scenes.json";

export type DemoHistoricalPolityRegion =
  | "atlantic"
  | "central"
  | "eastern"
  | "nordic"
  | "southern"
  | "ottoman";

export type DemoHistoricalPolityPrecision = "source-derived";

export type DemoHistoricalPolityProperties = {
  controlArea?: number;
  kind: "historical-polity";
  label: string;
  polityId: string;
  precision: DemoHistoricalPolityPrecision;
  region: DemoHistoricalPolityRegion;
  sceneYear: number;
  source: "CShapes-Europe";
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

export type DemoHistoricalPolityScenarioId = "european-states" | "wwii-control";

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
];

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
  const timelineYear = scenarioId === "european-states" ? Math.floor(year) : year;
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

      if (!previousFeature.geometry || !nextFeature?.geometry) {
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

    if (feature.geometry?.type === "Polygon") {
      issues.push(
        ...validateDemoHistoricalPolityPolygon(feature.geometry.coordinates, polityId, sceneYear),
      );

      return issues;
    }

    if (feature.geometry?.type === "MultiPolygon") {
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
  ).map((position) => [position[0], position[1]]);
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
