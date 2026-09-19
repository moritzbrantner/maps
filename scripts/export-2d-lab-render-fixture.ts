import { e2eMapStyle } from "../demo/data/map-style";

const WIDTH = 1200;
const HEIGHT = 720;

type Coordinate = [longitude: number, latitude: number];
type LineFeature = {
  geometry: { coordinates: Coordinate[]; type: "LineString" };
};
type PolygonFeature = {
  geometry: { coordinates: Coordinate[][]; type: "Polygon" };
};

const style = e2eMapStyle as unknown as {
  layers: Array<{
    id: string;
    paint?: Record<string, number | string>;
  }>;
  sources: {
    "demo-graticule": { data: { features: LineFeature[] } };
    "demo-land": { data: { features: PolygonFeature[] } };
  };
};

const background = paintString("demo-ocean", "background-color");
const landFill = cssColorWithOpacity(
  paintString("demo-land-fill", "fill-color"),
  paintNumber("demo-land-fill", "fill-opacity"),
);
const landStroke = cssColorWithOpacity(
  paintString("demo-land-line", "line-color"),
  paintNumber("demo-land-line", "line-opacity"),
);
const landStrokeWidth = paintNumber("demo-land-line", "line-width");
const graticuleStroke = cssColorWithOpacity(
  paintString("demo-graticule", "line-color"),
  paintNumber("demo-graticule", "line-opacity"),
);
const graticuleStrokeWidth = paintNumber("demo-graticule", "line-width");

const snapshot = {
  schema: "maps-2d-lab-screen-frame/v1",
  provenance: {
    generatedBy: "scripts/export-2d-lab-render-fixture.ts",
    sourceFixture: "demo/data/map-style.ts#e2eMapStyle",
    sourceRepository: "moritzbrantner/maps",
  },
  width: WIDTH,
  height: HEIGHT,
  background,
  primitives: [
    ...style.sources["demo-land"].data.features.map((feature) => ({
      kind: "polygon" as const,
      rings: feature.geometry.coordinates.map((ring) => ring.map(project)),
      fill: landFill,
      stroke: landStroke,
      strokeWidth: landStrokeWidth,
    })),
    ...style.sources["demo-graticule"].data.features.map((feature) => ({
      kind: "line" as const,
      points: densify(feature.geometry.coordinates, 24).map(project),
      stroke: graticuleStroke,
      strokeWidth: graticuleStrokeWidth,
    })),
  ],
};

validateSnapshot(snapshot);
process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);

function layer(id: string) {
  const value = style.layers.find((candidate) => candidate.id === id);
  if (!value) throw new Error(`missing expected E2E style layer ${id}`);
  return value;
}

function paintString(layerId: string, key: string) {
  const value = layer(layerId).paint?.[key];
  if (typeof value !== "string") {
    throw new Error(`expected ${layerId}.${key} to be a string`);
  }
  return value;
}

function paintNumber(layerId: string, key: string) {
  const value = layer(layerId).paint?.[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`expected ${layerId}.${key} to be finite`);
  }
  return value;
}

function project([longitude, latitude]: Coordinate) {
  return {
    x: ((longitude + 180) / 360) * WIDTH,
    y: ((90 - latitude) / 180) * HEIGHT,
  };
}

function densify(coordinates: Coordinate[], segmentCount: number) {
  if (coordinates.length !== 2) {
    throw new Error("2d-lab E2E graticule export expects two-point lines");
  }
  const [start, end] = coordinates;
  if (!start || !end) throw new Error("graticule line is incomplete");

  return Array.from({ length: segmentCount + 1 }, (_, index) => {
    const progress = index / segmentCount;
    return [
      start[0] + (end[0] - start[0]) * progress,
      start[1] + (end[1] - start[1]) * progress,
    ] satisfies Coordinate;
  });
}

function cssColorWithOpacity(color: string, opacity: number) {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
  if (!match) throw new Error(`unsupported fixture color ${color}`);
  const [, red, green, blue] = match;
  return `rgba(${Number.parseInt(red!, 16)}, ${Number.parseInt(green!, 16)}, ${Number.parseInt(blue!, 16)}, ${opacity})`;
}

function validateSnapshot(value: typeof snapshot) {
  if (value.width <= 0 || value.height <= 0) throw new Error("snapshot extent must be positive");
  if (value.primitives.length === 0) throw new Error("snapshot must contain render primitives");

  for (const primitive of value.primitives) {
    const pointGroups = primitive.kind === "line" ? [primitive.points] : primitive.rings;
    for (const points of pointGroups) {
      if (points.length < 2 || points.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))) {
        throw new Error("snapshot contains invalid screen-space geometry");
      }
    }
  }
}
