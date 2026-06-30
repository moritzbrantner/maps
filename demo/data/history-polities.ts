import { intersection, type MultiPolygon as ClippingMultiPolygon } from "polygon-clipping";

import type {
  TemporalGeoJsonGeometryFeature,
  TemporalGeoJsonGeometryFeatureCollection,
  TemporalGeoJsonSupportedGeometry,
} from "@moritzbrantner/maps";

import cshapesEuropePolityScenesFixture from "./cshapes-europe-polity-scenes.json";

export type DemoHistoricalPolityRegion =
  | "atlantic"
  | "central"
  | "eastern"
  | "nordic"
  | "southern"
  | "ottoman";

export type DemoHistoricalPolityPrecision = "source-derived";

export type DemoHistoricalPolityProperties = {
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

export const demoHistoricalPolityScenes: DemoHistoricalPolityScene[] =
  cshapesEuropePolityScenes.scenes;

export function formatDemoHistoricalPolityYear(year: number) {
  return `${Math.round(year)} AD`;
}

export function getDemoHistoricalPolityFrame(
  year: number,
): TemporalGeoJsonGeometryFeatureCollection<DemoHistoricalPolityProperties> {
  return getDemoHistoricalPolityPlaybackFrame(year);
}

export function getDemoHistoricalPolityPlaybackFrame(
  year: number,
): TemporalGeoJsonGeometryFeatureCollection<DemoHistoricalPolityProperties> {
  return getDemoHistoricalPolitySceneForYear(year).collection;
}

export function getDemoHistoricalPolitySceneForYear(year: number) {
  const clampedYear = clamp(
    Math.floor(year),
    demoHistoricalPolityScenes[0]!.year,
    demoHistoricalPolityScenes.at(-1)!.year,
  );
  const nextSceneIndex = demoHistoricalPolityScenes.findIndex((scene) => scene.year > clampedYear);

  if (nextSceneIndex === -1) {
    return demoHistoricalPolityScenes.at(-1)!;
  }

  return demoHistoricalPolityScenes[Math.max(0, nextSceneIndex - 1)]!;
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
    isPolygonLikeGeometry(feature.geometry) ? [{ bounds: getGeometryBounds(feature.geometry), feature }] : [],
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
        .map((ring) => closeRing(ring.map((position) => [position[0], position[1]] as [number, number])))
        .filter((ring) => ring.length >= 4 && Math.abs(getRingArea(ring)) > historyOverlapAreaThreshold),
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
  return closeRing(ring.map((position) => [Number(position[0]), Number(position[1])] as [number, number])).map(
    (position) => [position[0], position[1]],
  );
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
  const positions = (geometry.type === "Polygon" ? geometry.coordinates : geometry.coordinates.flat())
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

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}
