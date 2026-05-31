import { createHeatMapDensityIndex } from "../src/heat-map.tsx";
import {
  createHeatLayerDataSurfaceDataUrl,
  createHeatLayerInterpolatedSurfaceDataUrl,
  prepareHeatLayerColorRamp,
} from "../src/heat-surface.ts";

const CENTER = [13.405, 52.52];
const POINT_COUNTS = [1_000, 5_000, 10_000, 25_000];
const VIEWPORTS = [
  { height: 600, width: 800, zoom: 5 },
  { height: 720, width: 1280, zoom: 8 },
];
const HEATMAP_RADIUS = { meters: 50_000 };
const HEATMAP_INTENSITY = 1;
const HEATMAP_AGGREGATION_RADIUS = 56;
const HEATMAP_MAX_ZOOM = 16;
const WEIGHT_METRIC = "demand";
const METERS_PER_DEGREE_AT_EQUATOR = 111_320;
const TILE_SIZE = 256;
const MAX_WEB_MERCATOR_LATITUDE = 85.05112878;
const LARGE_SURFACE_PAYLOAD_KIB = 512;
const MAX_STABLE_RASTER_PIXELS = 512_000;
const COLOR_RAMP = prepareHeatLayerColorRamp([
  [0, "rgba(15, 23, 42, 0)"],
  [0.15, "#67e8f9"],
  [0.35, "#22c55e"],
  [0.58, "#fde047"],
  [0.78, "#fb923c"],
  [1, "#dc2626"],
]);

let sink = 0;
const rows = [];

console.log("\nHeat map full pipeline");
console.log("Times are mean/min/p95 in ms.");
console.log("Surface data URLs use the browser canvas path when available and the SVG fallback here.");

for (const viewportOptions of VIEWPORTS) {
  const viewport = createViewport(viewportOptions);
  const query = {
    bounds: getPaddedViewportBounds(viewport, HEATMAP_RADIUS, HEATMAP_INTENSITY),
    zoom: viewportOptions.zoom,
  };
  const stableCoverageBounds = getStableCoverageBounds(
    viewport,
    HEATMAP_RADIUS,
    HEATMAP_INTENSITY,
    1,
  );

  console.log(`\nViewport ${viewportOptions.width}x${viewportOptions.height} zoom=${viewportOptions.zoom}`);

  for (const pointCount of POINT_COUNTS) {
    const points = createMapPoints(pointCount);
    const iterations = getIterationCount(pointCount);
    const index = createBenchmarkDensityIndex(points);
    const data = index.getFeatureCollection(query);
    const sources = createSurfaceSources(data, viewport);
    const maxInfluenceRadius = Math.max(0, ...sources.map((source) => source.influenceRadius));
    const stableData = index.getFeatureCollection({
      bounds: stableCoverageBounds,
      zoom: viewportOptions.zoom,
    });
    const stablePlan = createStableSurfacePlan(stableData, stableCoverageBounds, viewport);
    const dataSurfaceUrl =
      maxInfluenceRadius > 0
        ? createHeatLayerDataSurfaceDataUrl({
            colorRamp: COLOR_RAMP,
            height: viewport.height,
            sources,
            width: viewport.width,
          })
        : "";
    const stableSurfaceUrl =
      stablePlan.maxInfluenceRadius > 0
        ? createHeatLayerInterpolatedSurfaceDataUrl({
            colorRamp: COLOR_RAMP,
            height: stablePlan.height,
            maxInfluenceRadius: stablePlan.maxInfluenceRadius,
            metricProjection: stablePlan.metricProjection,
            sources: stablePlan.sources,
            width: stablePlan.width,
          })
        : "";
    const interpolatedSurfaceUrl =
      maxInfluenceRadius > 0
        ? createHeatLayerInterpolatedSurfaceDataUrl({
            colorRamp: COLOR_RAMP,
            height: viewport.height,
            maxInfluenceRadius,
            metricProjection: createMetricProjection(viewport),
            sources,
            width: viewport.width,
          })
        : "";

    const indexRebuildMs = measureStats(() => {
      const measuredIndex = createBenchmarkDensityIndex(points);
      sink += measuredIndex.pointCount;
    }, iterations);
    const viewportQueryMs = measureStats(() => {
      const measuredData = index.getFeatureCollection(query);
      sink += measuredData.features.length;
    }, iterations);
    const projectSourcesMs = measureStats(() => {
      const measuredSources = createSurfaceSources(data, viewport);
      sink += measuredSources.length;
    }, iterations);
    const dataSurfaceMs = measureStats(() => {
      const url = createHeatLayerDataSurfaceDataUrl({
        colorRamp: COLOR_RAMP,
        height: viewport.height,
        sources,
        width: viewport.width,
      });
      sink += url.length;
    }, iterations);
    const interpolatedSurfaceMs = measureStats(() => {
      const url = createHeatLayerInterpolatedSurfaceDataUrl({
        colorRamp: COLOR_RAMP,
        height: viewport.height,
        maxInfluenceRadius,
        metricProjection: createMetricProjection(viewport),
        sources,
        width: viewport.width,
      });
      sink += url.length;
    }, iterations);
    const stableSurfaceMs = measureStats(() => {
      const measuredStablePlan = createStableSurfacePlan(stableData, stableCoverageBounds, viewport);
      const url = createHeatLayerInterpolatedSurfaceDataUrl({
        colorRamp: COLOR_RAMP,
        height: measuredStablePlan.height,
        maxInfluenceRadius: measuredStablePlan.maxInfluenceRadius,
        metricProjection: measuredStablePlan.metricProjection,
        sources: measuredStablePlan.sources,
        width: measuredStablePlan.width,
      });
      sink += url.length;
    }, iterations);
    const stableCacheHitMs = measureStats(() => {
      const cacheReusable =
        containsBounds(stableCoverageBounds, query.bounds) && stableSurfaceUrl.length > 0;
      sink += cacheReusable ? 1 : 0;
    }, iterations);
    const moveUpdateMs = measureStats(() => {
      const measuredData = index.getFeatureCollection(query);
      const measuredSources = createSurfaceSources(measuredData, viewport);
      const measuredMaxInfluenceRadius = Math.max(
        0,
        ...measuredSources.map((source) => source.influenceRadius),
      );
      const url = createHeatLayerInterpolatedSurfaceDataUrl({
        colorRamp: COLOR_RAMP,
        height: viewport.height,
        maxInfluenceRadius: measuredMaxInfluenceRadius,
        metricProjection: createMetricProjection(viewport),
        sources: measuredSources,
        width: viewport.width,
      });
      sink += url.length;
    }, iterations);
    const coldUpdateMs = measureStats(() => {
      const measuredIndex = createBenchmarkDensityIndex(points);
      const measuredData = measuredIndex.getFeatureCollection(query);
      const measuredSources = createSurfaceSources(measuredData, viewport);
      const measuredMaxInfluenceRadius = Math.max(
        0,
        ...measuredSources.map((source) => source.influenceRadius),
      );
      const url = createHeatLayerInterpolatedSurfaceDataUrl({
        colorRamp: COLOR_RAMP,
        height: viewport.height,
        maxInfluenceRadius: measuredMaxInfluenceRadius,
        metricProjection: createMetricProjection(viewport),
        sources: measuredSources,
        width: viewport.width,
      });
      sink += url.length;
    }, iterations);
    const dataPayloadKiB = getKiB(dataSurfaceUrl);
    const interpolatedPayloadKiB = getKiB(interpolatedSurfaceUrl);
    const row = {
      coldUpdateMs,
      dataSurfaceMs,
      dataPayloadKiB,
      featureCount: data.features.length,
      indexRebuildMs,
      interpolatedSurfaceMs,
      interpolatedPayloadKiB,
      moveUpdateMs,
      pointCount,
      projectSourcesMs,
      sourceCount: sources.length,
      stableCacheHitMs,
      stableSurfaceMs,
      viewport: viewportOptions,
      viewportQueryMs,
    };

    rows.push(row);

    console.log(
      [
        `${String(pointCount).padStart(6)} points`,
        `features=${String(data.features.length).padStart(5)}`,
        `sources=${String(sources.length).padStart(5)}`,
        `index=${formatStats(indexRebuildMs)}`,
        `query=${formatStats(viewportQueryMs)}`,
        `project=${formatStats(projectSourcesMs)}`,
        `dataSurface=${formatStats(dataSurfaceMs)}`,
        `interpolatedSurface=${formatStats(interpolatedSurfaceMs)}`,
        `stableSurface=${formatStats(stableSurfaceMs)}`,
        `stableHit=${formatStats(stableCacheHitMs)}`,
        `moveUpdate=${formatStats(moveUpdateMs)}`,
        `coldUpdate=${formatStats(coldUpdateMs)}`,
        `payloadKiB=${dataPayloadKiB.toFixed(1)}/${interpolatedPayloadKiB.toFixed(1)}`,
      ].join("  "),
    );
  }
}

printHotPathSummary(rows);

if (sink === Number.MIN_SAFE_INTEGER) {
  console.log("unreachable", sink);
}

function createBenchmarkDensityIndex(points) {
  return createHeatMapDensityIndex(points, {
    maxZoom: HEATMAP_MAX_ZOOM,
    radius: HEATMAP_AGGREGATION_RADIUS,
    weightMetric: WEIGHT_METRIC,
  });
}

function createMapPoints(pointCount) {
  const hotspots = [
    { demand: 40, latitude: CENTER[1], longitude: CENTER[0], spread: 0.09 },
    { demand: 31, latitude: 52.39, longitude: 13.06, spread: 0.12 },
    { demand: 26, latitude: 52.66, longitude: 13.29, spread: 0.1 },
    { demand: 19, latitude: 52.47, longitude: 13.62, spread: 0.14 },
  ];

  return Array.from({ length: pointCount }, (_, index) => {
    const isClustered = index % 10 < 7;

    if (isClustered) {
      const hotspot = hotspots[index % hotspots.length];
      const angle = index * 2.399963229728653;
      const ring = 0.15 + ((index * 37) % 1000) / 1000;
      const spread = hotspot.spread * (0.45 + ring);

      return {
        id: `heat-point-${index}`,
        label: `Heat point ${index}`,
        latitude: hotspot.latitude + Math.sin(angle) * spread,
        longitude: hotspot.longitude + Math.cos(angle) * spread * 1.45,
        metrics: {
          demand: hotspot.demand + (index % 17) * 1.8,
        },
        properties: {},
      };
    }

    const backgroundIndex = Math.floor(index / 10);
    const longitudeProgress = ((backgroundIndex * 53) % 1000) / 1000;
    const latitudeProgress = ((backgroundIndex * 97) % 1000) / 1000;

    return {
      id: `heat-point-${index}`,
      label: `Heat point ${index}`,
      latitude: CENTER[1] - 1.85 + latitudeProgress * 3.7,
      longitude: CENTER[0] - 3.1 + longitudeProgress * 6.2,
      metrics: {
        demand: 4 + (index % 23) * 0.9,
      },
      properties: {},
    };
  });
}

function createSurfaceSources(data, viewport) {
  return data.features
    .map((feature) => {
      const [longitude, latitude] = feature.geometry.coordinates;
      const point = viewport.coordinateToPoint([longitude, latitude]);
      const baseRadius =
        getProjectedMetersRadius(HEATMAP_RADIUS.meters, [longitude, latitude], (coordinate) =>
          viewport.coordinateToPoint(coordinate),
        ) * Math.max(0, HEATMAP_INTENSITY);
      const dataInfluenceRadius = HEATMAP_RADIUS.meters * 2.6 * Math.max(0, HEATMAP_INTENSITY);

      return {
        coordinate: [longitude, latitude],
        dataInfluenceRadius,
        influenceRadius: baseRadius * 2.6,
        metricPoint: coordinateToMetricPoint([longitude, latitude]),
        point,
        weight: clamp(feature.properties.weight, 0, Number.POSITIVE_INFINITY),
      };
    })
    .filter((source) => source.weight > 0 && source.influenceRadius > 0);
}

function createMetricProjection(viewport) {
  return {
    getMetricPoint(x, y) {
      return coordinateToMetricPoint(viewport.pointToCoordinate({ x, y }));
    },
    getMetricX(x) {
      return coordinateToMetricPoint(viewport.pointToCoordinate({ x, y: viewport.height / 2 })).x;
    },
    getMetricY(y) {
      return coordinateToMetricPoint(viewport.pointToCoordinate({ x: viewport.width / 2, y })).y;
    },
  };
}

function createStableSurfacePlan(data, bounds, viewport) {
  const dimensions = resolveStableRasterDimensions(bounds, viewport);
  const metricBounds = getMetricBounds(bounds);
  const dataInfluenceRadius = HEATMAP_RADIUS.meters * 2.6 * Math.max(0, HEATMAP_INTENSITY);
  const metersPerPixel = Math.max(
    (metricBounds.east - metricBounds.west) / Math.max(1, dimensions.width),
    (metricBounds.north - metricBounds.south) / Math.max(1, dimensions.height),
  );
  const influenceRadius = dataInfluenceRadius / Math.max(1, metersPerPixel);
  const sources = data.features
    .map((feature) => {
      const metricPoint = coordinateToMetricPoint(feature.geometry.coordinates);

      return {
        coordinate: feature.geometry.coordinates,
        dataInfluenceRadius,
        influenceRadius,
        metricPoint,
        point: {
          x:
            ((metricPoint.x - metricBounds.west) /
              Math.max(Number.EPSILON, metricBounds.east - metricBounds.west)) *
            dimensions.width,
          y:
            ((metricBounds.north - metricPoint.y) /
              Math.max(Number.EPSILON, metricBounds.north - metricBounds.south)) *
            dimensions.height,
        },
        weight: clamp(feature.properties.weight, 0, Number.POSITIVE_INFINITY),
      };
    })
    .filter((source) => source.weight > 0 && source.influenceRadius > 0);

  return {
    height: dimensions.height,
    maxInfluenceRadius: Math.max(0, ...sources.map((source) => source.influenceRadius)),
    metricProjection: createStableMetricProjection(bounds, dimensions),
    sources,
    width: dimensions.width,
  };
}

function createStableMetricProjection(bounds, dimensions) {
  const metricBounds = getMetricBounds(bounds);

  return {
    getMetricPoint(x, y) {
      return {
        x:
          metricBounds.west +
          (x / Math.max(1, dimensions.width)) * (metricBounds.east - metricBounds.west),
        y:
          metricBounds.north -
          (y / Math.max(1, dimensions.height)) * (metricBounds.north - metricBounds.south),
      };
    },
    getMetricX(x) {
      return metricBounds.west + (x / Math.max(1, dimensions.width)) * (metricBounds.east - metricBounds.west);
    },
    getMetricY(y) {
      return metricBounds.north - (y / Math.max(1, dimensions.height)) * (metricBounds.north - metricBounds.south);
    },
  };
}

function resolveStableRasterDimensions(bounds, viewport) {
  const metricBounds = getMetricBounds(bounds);
  const aspectRatio = Math.max(
    0.05,
    (metricBounds.east - metricBounds.west) / Math.max(1, metricBounds.north - metricBounds.south),
  );
  const targetPixels = Math.min(MAX_STABLE_RASTER_PIXELS, Math.max(1, viewport.width * viewport.height));
  const width = Math.max(1, Math.round(Math.sqrt(targetPixels * aspectRatio)));
  const height = Math.max(1, Math.round(width / aspectRatio));

  if (width * height <= MAX_STABLE_RASTER_PIXELS) {
    return { height, width };
  }

  const scale = Math.sqrt(MAX_STABLE_RASTER_PIXELS / (width * height));

  return {
    height: Math.max(1, Math.floor(height * scale)),
    width: Math.max(1, Math.floor(width * scale)),
  };
}

function getStableCoverageBounds(viewport, radius, intensity, overscanRatio) {
  const padding =
    Math.max(viewport.width, viewport.height) * Math.max(0, overscanRatio) +
    getProjectedMetersRadius(radius.meters, viewport.center, (coordinate) =>
      viewport.coordinateToPoint(coordinate),
    ) *
      2.6 *
      Math.max(0, intensity);
  const northWest = viewport.pointToCoordinate({ x: -padding, y: -padding });
  const southEast = viewport.pointToCoordinate({
    x: viewport.width + padding,
    y: viewport.height + padding,
  });

  return [
    clamp(Math.min(northWest[0], southEast[0]), -180, 180),
    clamp(Math.min(northWest[1], southEast[1]), -90, 90),
    clamp(Math.max(northWest[0], southEast[0]), -180, 180),
    clamp(Math.max(northWest[1], southEast[1]), -90, 90),
  ];
}

function getMetricBounds(bounds) {
  const southWest = coordinateToMetricPoint([bounds[0], bounds[1]]);
  const northEast = coordinateToMetricPoint([bounds[2], bounds[3]]);

  return {
    east: Math.max(southWest.x, northEast.x),
    north: Math.max(southWest.y, northEast.y),
    south: Math.min(southWest.y, northEast.y),
    west: Math.min(southWest.x, northEast.x),
  };
}

function containsBounds(outer, inner) {
  return outer[0] <= inner[0] && outer[1] <= inner[1] && outer[2] >= inner[2] && outer[3] >= inner[3];
}

function createViewport({ height, width, zoom }) {
  const centerWorldPoint = coordinateToWorldPoint(CENTER, zoom);

  return {
    center: CENTER,
    height,
    pointToCoordinate(point) {
      return worldPointToCoordinate(
        {
          x: centerWorldPoint.x + point.x - width / 2,
          y: centerWorldPoint.y + point.y - height / 2,
        },
        zoom,
      );
    },
    width,
    zoom,
    coordinateToPoint(coordinate) {
      const worldPoint = coordinateToWorldPoint(coordinate, zoom);

      return {
        x: worldPoint.x - centerWorldPoint.x + width / 2,
        y: worldPoint.y - centerWorldPoint.y + height / 2,
      };
    },
  };
}

function getPaddedViewportBounds(viewport, radius, intensity) {
  const centerCoordinate = viewport.center;
  const padding =
    getProjectedMetersRadius(radius.meters, centerCoordinate, (coordinate) =>
      viewport.coordinateToPoint(coordinate),
    ) *
    2.6 *
    Math.max(0, intensity);
  const northWest = viewport.pointToCoordinate({ x: -padding, y: -padding });
  const southEast = viewport.pointToCoordinate({
    x: viewport.width + padding,
    y: viewport.height + padding,
  });

  return [
    clamp(Math.min(northWest[0], southEast[0]), -180, 180),
    clamp(Math.min(northWest[1], southEast[1]), -90, 90),
    clamp(Math.max(northWest[0], southEast[0]), -180, 180),
    clamp(Math.max(northWest[1], southEast[1]), -90, 90),
  ];
}

function coordinateToWorldPoint([longitude, latitude], zoom) {
  const scale = TILE_SIZE * 2 ** zoom;
  const clampedLatitude = clamp(latitude, -MAX_WEB_MERCATOR_LATITUDE, MAX_WEB_MERCATOR_LATITUDE);
  const latitudeRadians = (clampedLatitude * Math.PI) / 180;
  const sinLatitude = Math.sin(latitudeRadians);

  return {
    x: ((longitude + 180) / 360) * scale,
    y: (0.5 - Math.log((1 + sinLatitude) / (1 - sinLatitude)) / (4 * Math.PI)) * scale,
  };
}

function worldPointToCoordinate({ x, y }, zoom) {
  const scale = TILE_SIZE * 2 ** zoom;
  const longitude = (x / scale) * 360 - 180;
  const mercatorY = 0.5 - y / scale;
  const latitude =
    ((2 * Math.atan(Math.exp(mercatorY * 2 * Math.PI)) - Math.PI / 2) * 180) / Math.PI;

  return [
    clamp(longitude, -180, 180),
    clamp(latitude, -MAX_WEB_MERCATOR_LATITUDE, MAX_WEB_MERCATOR_LATITUDE),
  ];
}

function getProjectedMetersRadius(meters, [longitude, latitude], projectCoordinate) {
  if (!Number.isFinite(meters) || meters <= 0) {
    return 0;
  }

  const center = projectCoordinate([longitude, latitude]);
  const latitudeRadians = (latitude * Math.PI) / 180;
  const longitudeScale = Math.max(0.000001, Math.abs(Math.cos(latitudeRadians)));
  const longitudeOffset = meters / (METERS_PER_DEGREE_AT_EQUATOR * longitudeScale);
  const edge = projectCoordinate([longitude + longitudeOffset, latitude]);

  return Math.hypot(edge.x - center.x, edge.y - center.y);
}

function coordinateToMetricPoint([longitude, latitude]) {
  const clampedLatitude = clamp(latitude, -MAX_WEB_MERCATOR_LATITUDE, MAX_WEB_MERCATOR_LATITUDE);
  const latitudeRadians = (clampedLatitude * Math.PI) / 180;

  return {
    x: longitude * METERS_PER_DEGREE_AT_EQUATOR,
    y:
      (Math.log(Math.tan(Math.PI / 4 + latitudeRadians / 2)) *
        (METERS_PER_DEGREE_AT_EQUATOR * 180)) /
      Math.PI,
  };
}

function measureStats(run, iterations) {
  for (let index = 0; index < Math.min(2, iterations); index += 1) {
    run();
  }

  const samples = [];

  for (let index = 0; index < iterations; index += 1) {
    const startedAt = performance.now();

    run();
    samples.push(performance.now() - startedAt);
  }

  samples.sort((left, right) => left - right);

  return {
    mean: samples.reduce((sum, sample) => sum + sample, 0) / samples.length,
    min: samples[0] ?? 0,
    p95: samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.95))] ?? 0,
  };
}

function getIterationCount(pointCount) {
  if (pointCount >= 25_000) {
    return 3;
  }

  if (pointCount >= 10_000) {
    return 5;
  }

  if (pointCount >= 5_000) {
    return 10;
  }

  return 20;
}

function formatStats(stats) {
  return `${stats.mean.toFixed(2)}/${stats.min.toFixed(2)}/${stats.p95.toFixed(2)}`;
}

function getKiB(value) {
  return Buffer.byteLength(value, "utf8") / 1024;
}

function printHotPathSummary(measuredRows) {
  const interpolatedDominatedRows = measuredRows.filter(
    (row) => row.interpolatedSurfaceMs.mean / row.moveUpdateMs.mean > 0.6,
  );
  const indexDominatedRows = measuredRows.filter(
    (row) => row.indexRebuildMs.mean / row.coldUpdateMs.mean > 0.5,
  );
  const largestPayloadRow = measuredRows.reduce((largest, row) => {
    const rowPayloadKiB = Math.max(row.dataPayloadKiB, row.interpolatedPayloadKiB);
    const largestPayloadKiB = largest
      ? Math.max(largest.dataPayloadKiB, largest.interpolatedPayloadKiB)
      : -1;

    return rowPayloadKiB > largestPayloadKiB ? row : largest;
  }, null);
  const slowestMoveRow = measuredRows.reduce(
    (slowest, row) => (row.moveUpdateMs.mean > (slowest?.moveUpdateMs.mean ?? -1) ? row : slowest),
    null,
  );
  const slowestColdRow = measuredRows.reduce(
    (slowest, row) => (row.coldUpdateMs.mean > (slowest?.coldUpdateMs.mean ?? -1) ? row : slowest),
    null,
  );

  console.log("\nHot path summary");

  if (interpolatedDominatedRows.length > 0) {
    const worst = interpolatedDominatedRows.reduce((currentWorst, row) => {
      const currentRatio = getStageShare(row.interpolatedSurfaceMs.mean, row.moveUpdateMs.mean);
      const worstRatio = getStageShare(currentWorst.interpolatedSurfaceMs.mean, currentWorst.moveUpdateMs.mean);

      return currentRatio > worstRatio ? row : currentWorst;
    });

    console.log(
      `- Interpolated surface generation dominates move updates in ${interpolatedDominatedRows.length}/${measuredRows.length} scenarios; worst is ${formatScenario(worst)} at ${formatRatio(
        worst.interpolatedSurfaceMs.mean,
        worst.moveUpdateMs.mean,
      )} of moveUpdate.`,
    );
  } else {
    console.log("- Interpolated surface generation stayed below 60% of moveUpdate in every scenario.");
  }

  if (indexDominatedRows.length > 0) {
    const worst = indexDominatedRows.reduce((currentWorst, row) => {
      const currentRatio = getStageShare(row.indexRebuildMs.mean, row.coldUpdateMs.mean);
      const worstRatio = getStageShare(currentWorst.indexRebuildMs.mean, currentWorst.coldUpdateMs.mean);

      return currentRatio > worstRatio ? row : currentWorst;
    });

    console.log(
      `- Aggregation/index rebuild dominates cold updates in ${indexDominatedRows.length}/${measuredRows.length} scenarios; worst is ${formatScenario(worst)} at ${formatRatio(
        worst.indexRebuildMs.mean,
        worst.coldUpdateMs.mean,
      )} of coldUpdate.`,
    );
  } else {
    console.log("- Aggregation/index rebuild stayed below 50% of coldUpdate in every scenario.");
  }

  if (largestPayloadRow) {
    const largestPayloadKiB = Math.max(
      largestPayloadRow.dataPayloadKiB,
      largestPayloadRow.interpolatedPayloadKiB,
    );

    if (largestPayloadKiB > LARGE_SURFACE_PAYLOAD_KIB) {
      console.log(
        `- Largest surface payload is ${largestPayloadKiB.toFixed(1)} KiB in ${formatScenario(
          largestPayloadRow,
        )}; payload size may justify lowering sample count or avoiding data URLs entirely.`,
      );
    } else {
      console.log(
        `- Largest surface payload is ${largestPayloadKiB.toFixed(1)} KiB, below the ${LARGE_SURFACE_PAYLOAD_KIB} KiB payload threshold.`,
      );
    }
  }

  if (slowestMoveRow && slowestColdRow) {
    console.log(
      `- Slowest move update: ${formatScenario(slowestMoveRow)} at ${slowestMoveRow.moveUpdateMs.mean.toFixed(
        2,
      )} ms mean.`,
    );
    console.log(
      `- Slowest cold update: ${formatScenario(slowestColdRow)} at ${slowestColdRow.coldUpdateMs.mean.toFixed(
        2,
      )} ms mean.`,
    );
  }
}

function formatScenario(row) {
  return `${row.pointCount} points, ${row.viewport.width}x${row.viewport.height} zoom=${row.viewport.zoom}`;
}

function formatRatio(part, total) {
  return `${(getStageShare(part, total) * 100).toFixed(1)}%`;
}

function getStageShare(part, total) {
  if (total <= 0) {
    return 0;
  }

  return clamp(part / total, 0, 1);
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}
