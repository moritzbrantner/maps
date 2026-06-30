import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { difference } from "polygon-clipping";

const sourceUrl = "https://icr.ethz.ch/data/cshapes/CShapes-Europe.geojson";
const milestoneYears = [1816, 1886, 1914, 1939, 1945, 1989, 2019];
const outputPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../demo/data/cshapes-europe-polity-scenes.json",
);
const noticePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../demo/data/CShapes-Europe-NOTICE.md",
);

const inputPath = process.argv.find((argument) => argument.startsWith("--input="))?.slice(8);

const source = inputPath
  ? JSON.parse(await readFile(path.resolve(inputPath), "utf8"))
  : await fetch(sourceUrl).then((response) => {
      if (!response.ok) {
        throw new Error(`Unable to fetch CShapes-Europe: ${response.status} ${response.statusText}`);
      }

      return response.json();
    });

const scenes = milestoneYears.map((year) => buildScene(source.features ?? [], year));

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(
  outputPath,
  `${JSON.stringify({
    license: "CC BY-NC-SA 4.0",
    source: "CShapes-Europe",
    sourceUrl,
    years: milestoneYears,
    scenes,
  })}\n`,
);
await writeFile(
  noticePath,
  [
    "# CShapes-Europe Demo Data",
    "",
    "The History demo boundary snapshots in `cshapes-europe-polity-scenes.json` are derived from CShapes-Europe.",
    "",
    "- Source: https://icr.ethz.ch/data/cshapes/",
    "- Source file: https://icr.ethz.ch/data/cshapes/CShapes-Europe.geojson",
    "- License: Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International",
    "- Citation requested by the CShapes project: Weidmann, Nils B., Doreen Kuse, and Kristian Skrede Gleditsch. 2010. The Geography of the International System: The CShapes Dataset. International Interactions 36 (1).",
    "",
    "These files are demo-only data and are not part of the published `@moritzbrantner/maps` package files.",
    "The demo snapshots are not an authoritative historical boundary source.",
    "",
  ].join("\n"),
);

console.log(`Wrote ${scenes.length} CShapes-Europe Historical Polity Scenes to ${outputPath}`);

function buildScene(features, year) {
  const activeFeatures = features
    .filter((feature) => isIndependentFeatureActiveInYear(feature, year))
    .map((feature) => ({
      feature,
      geometry: normalizePolygonLikeGeometry(feature.geometry),
      sourceArea: getNumericProperty(feature, "Area"),
    }))
    .filter((entry) => entry.geometry)
    .sort((left, right) => left.sourceArea - right.sourceArea || getSourceName(left.feature).localeCompare(getSourceName(right.feature)));

  const accepted = [];

  for (const entry of activeFeatures) {
    const clippedGeometry = clipGeometryAgainstAcceptedFeatures(entry.geometry, accepted);

    if (!clippedGeometry || getPolygonLikeArea(clippedGeometry) <= 1e-9) {
      continue;
    }

    accepted.push({
      feature: entry.feature,
      bounds: getGeometryBounds(clippedGeometry),
      geometry: clippedGeometry,
      sourceArea: entry.sourceArea,
    });
  }

  accepted.sort((left, right) => getSourceName(left.feature).localeCompare(getSourceName(right.feature)));

  return {
    collection: {
      features: accepted.map(({ feature, geometry }) => toHistoricalPolityFeature(feature, geometry, year)),
      type: "FeatureCollection",
    },
    label: `${year} AD`,
    year,
  };
}

function isIndependentFeatureActiveInYear(feature, year) {
  const properties = feature.properties ?? {};

  return properties.Status === "independent" && properties.From <= year && year <= properties.To;
}

function toHistoricalPolityFeature(feature, geometry, year) {
  const sourceId = getNumericProperty(feature, "Id");
  const sourceName = getSourceName(feature);

  return {
    geometry,
    id: `${sourceId}-${slugify(sourceName)}`,
    properties: {
      kind: "historical-polity",
      label: sourceName,
      polityId: `${sourceId}-${slugify(sourceName)}`,
      precision: "source-derived",
      region: getRegion(feature, geometry),
      sceneYear: year,
      source: "CShapes-Europe",
      sourceFrom: getNumericProperty(feature, "From"),
      sourceId,
      sourceStatus: "independent",
      sourceTo: getNumericProperty(feature, "To"),
    },
    type: "Feature",
  };
}

function getRegion(feature, geometry) {
  const centroid = parsePointWkt(feature.properties?.centroid_geom) ?? getGeometryCentroid(geometry);
  const [longitude, latitude] = centroid;

  if (latitude >= 54) {
    return "nordic";
  }

  if (longitude < 2) {
    return "atlantic";
  }

  if (longitude < 13) {
    return "central";
  }

  if (latitude < 44) {
    return "southern";
  }

  if (longitude < 24) {
    return "central";
  }

  return "eastern";
}

function normalizePolygonLikeGeometry(geometry) {
  if (!geometry || (geometry.type !== "Polygon" && geometry.type !== "MultiPolygon")) {
    return null;
  }

  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  const normalizedPolygons = polygons
    .map(normalizePolygon)
    .filter((polygon) => polygon.length > 0 && Math.abs(getRingSignedArea(polygon[0])) > 1e-9);

  if (normalizedPolygons.length === 0) {
    return null;
  }

  return normalizedPolygons.length === 1
    ? { coordinates: normalizedPolygons[0], type: "Polygon" }
    : { coordinates: normalizedPolygons, type: "MultiPolygon" };
}

function normalizePolygon(polygon) {
  return polygon
    .map((ring, ringIndex) => normalizeRing(ring, ringIndex === 0))
    .filter((ring) => ring.length >= 4 && Math.abs(getRingSignedArea(ring)) > 1e-9);
}

function normalizeRing(ring, isShell) {
  const openRing = removeClosingPosition(
    ring
      .map((position) => [Number(position[0]), Number(position[1])])
      .filter((position) => Number.isFinite(position[0]) && Number.isFinite(position[1])),
  );

  if (openRing.length < 3) {
    return [];
  }

  const closedRing = closeRing(openRing);
  const shouldReverse = isShell
    ? getRingSignedArea(closedRing) < 0
    : getRingSignedArea(closedRing) > 0;

  return shouldReverse ? [...closedRing].reverse() : closedRing;
}

function clipGeometryAgainstAcceptedFeatures(geometry, accepted) {
  let currentGeometry = geometry;
  let currentBounds = getGeometryBounds(currentGeometry);

  for (const acceptedFeature of accepted) {
    if (!boundsIntersect(currentBounds, acceptedFeature.bounds)) {
      continue;
    }

    currentGeometry = fromClippingMultiPolygon(
      difference(
        toClippingMultiPolygon(currentGeometry),
        toClippingMultiPolygon(acceptedFeature.geometry),
      ),
    );

    if (!currentGeometry) {
      return null;
    }

    currentBounds = getGeometryBounds(currentGeometry);
  }

  return currentGeometry;
}

function toClippingMultiPolygon(geometry) {
  if (geometry.type === "Polygon") {
    return [geometry.coordinates.map(toClippingRing)];
  }

  return geometry.coordinates.map((polygon) => polygon.map(toClippingRing));
}

function fromClippingMultiPolygon(output) {
  const polygons = output
    .map((polygon) =>
      polygon
        .map((ring, ringIndex) => normalizeRing(ring, ringIndex === 0))
        .filter((ring) => ring.length >= 4 && Math.abs(getRingSignedArea(ring)) > 1e-9),
    )
    .filter((polygon) => polygon.length > 0 && Math.abs(getRingSignedArea(polygon[0])) > 1e-9);

  if (polygons.length === 0) {
    return null;
  }

  return polygons.length === 1
    ? { coordinates: polygons[0], type: "Polygon" }
    : { coordinates: polygons, type: "MultiPolygon" };
}

function toClippingRing(ring) {
  return closeRing(ring).map((position) => [position[0], position[1]]);
}

function closeRing(ring) {
  if (ring.length === 0) {
    return [];
  }

  const openRing = removeClosingPosition(ring);
  const first = openRing[0];

  return [...openRing.map(clonePosition), clonePosition(first)];
}

function removeClosingPosition(ring) {
  if (ring.length >= 2 && ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1]) {
    return ring.slice(0, -1).map(clonePosition);
  }

  return ring.map(clonePosition);
}

function clonePosition(position) {
  return [position[0], position[1]];
}

function getPolygonLikeArea(geometry) {
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;

  return Math.abs(
    polygons.reduce(
      (total, polygon) =>
        total +
        polygon.reduce((polygonArea, ring, ringIndex) => {
          const ringArea = Math.abs(getRingSignedArea(ring));

          return ringIndex === 0 ? polygonArea + ringArea : polygonArea - ringArea;
        }, 0),
      0,
    ),
  );
}

function getRingSignedArea(ring) {
  return (
    ring.slice(0, -1).reduce((sum, position, index) => {
      const next = ring[index + 1];

      return sum + position[0] * next[1] - next[0] * position[1];
    }, 0) / 2
  );
}

function getGeometryCentroid(geometry) {
  const positions = (geometry.type === "Polygon" ? geometry.coordinates : geometry.coordinates.flat())
    .flat()
    .filter((position) => Array.isArray(position) && position.length >= 2);

  if (positions.length === 0) {
    return [0, 0];
  }

  const total = positions.reduce(
    (sum, position) => [sum[0] + position[0], sum[1] + position[1]],
    [0, 0],
  );

  return [total[0] / positions.length, total[1] / positions.length];
}

function getGeometryBounds(geometry) {
  const positions = (geometry.type === "Polygon" ? geometry.coordinates : geometry.coordinates.flat())
    .flat()
    .filter((position) => Array.isArray(position) && position.length >= 2);

  return positions.reduce(
    (bounds, position) => ({
      east: Math.max(bounds.east, position[0]),
      north: Math.max(bounds.north, position[1]),
      south: Math.min(bounds.south, position[1]),
      west: Math.min(bounds.west, position[0]),
    }),
    {
      east: Number.NEGATIVE_INFINITY,
      north: Number.NEGATIVE_INFINITY,
      south: Number.POSITIVE_INFINITY,
      west: Number.POSITIVE_INFINITY,
    },
  );
}

function boundsIntersect(left, right) {
  return (
    left.west <= right.east &&
    left.east >= right.west &&
    left.south <= right.north &&
    left.north >= right.south
  );
}

function parsePointWkt(value) {
  if (typeof value !== "string") {
    return null;
  }

  const match = /^POINT \(([-\d.]+) ([-\d.]+)\)$/.exec(value);

  return match ? [Number(match[1]), Number(match[2])] : null;
}

function getSourceName(feature) {
  return String(feature.properties?.Name ?? "Historical polity");
}

function getNumericProperty(feature, key) {
  const value = Number(feature.properties?.[key]);

  return Number.isFinite(value) ? value : 0;
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
