const INTERPOLATED_HEAT_DENSITY_GAMMA = 0.7;
const INTERPOLATED_HEAT_MIN_DENSITY = 0.08;

export type HeatLayerColorStop = readonly [density: number, color: string];

export type HeatLayerMetricPoint = {
  x: number;
  y: number;
};

export type HeatLayerSurfaceSource = {
  coordinate: [longitude: number, latitude: number];
  dataInfluenceRadius: number | null;
  influenceRadius: number;
  metricPoint: HeatLayerMetricPoint;
  point: {
    x: number;
    y: number;
  };
  weight: number;
};

export type MetricHeatLayerSurfaceSource = HeatLayerSurfaceSource & {
  dataInfluenceRadius: number;
};

export type PreparedHeatLayerColorRamp = {
  stops: PreparedHeatLayerColorStop[];
};

export type HeatLayerSurfaceImage = {
  objectUrl: boolean;
  url: string;
};

type PreparedHeatLayerColorStop = {
  color: string;
  density: number;
  parsed: HeatLayerParsedColor | null;
};

export type HeatLayerMetricSurfaceProjection = {
  getMetricPoint: (x: number, y: number) => HeatLayerMetricPoint;
  getMetricX?: (x: number) => number;
  getMetricY?: (y: number) => number;
};

export type HeatLayerSurfaceDensityMode = "brute-force" | "indexed";

type HeatLayerSurfaceCell = {
  density: number;
  x: number;
  y: number;
};

type HeatLayerSurfaceSpatialIndex<TSource> = {
  buckets: Array<HeatLayerSurfaceSpatialIndexBucket<TSource>>;
  cellSize: number;
  cells: Map<number, TSource[]>;
  maxRadius: number;
};

type HeatLayerSurfaceSpatialIndexBucket<TSource> = {
  cellSize: number;
  cells: Map<number, TSource[]>;
  maxRadius: number;
};

type HeatLayerParsedColor = {
  alpha: number;
  blue: number;
  green: number;
  red: number;
};

type HeatLayerDataSurfaceOptions = {
  colorRamp: PreparedHeatLayerColorRamp;
  height: number;
  sources: readonly HeatLayerSurfaceSource[];
  width: number;
};

type HeatLayerInterpolatedSurfaceOptions = {
  colorRamp: PreparedHeatLayerColorRamp;
  densityMode?: HeatLayerSurfaceDensityMode;
  height: number;
  maxInfluenceRadius: number;
  metricProjection: HeatLayerMetricSurfaceProjection;
  sources: readonly HeatLayerSurfaceSource[];
  width: number;
};

type HeatLayerInterpolatedSurfaceSamples = {
  blur: number;
  cellSize: number;
  cells: HeatLayerSurfaceCell[];
};

type HeatLayerSampleGrid = {
  cellSize: number;
  columnCount: number;
  rowCount: number;
  xCenters: Float64Array;
  yCenters: Float64Array;
};

type HeatLayerMetricSampleGrid = HeatLayerSampleGrid & {
  metricXs: Float64Array;
  metricYs: Float64Array;
};

export function prepareHeatLayerColorRamp(
  colorRamp: readonly HeatLayerColorStop[],
): PreparedHeatLayerColorRamp {
  return {
    stops: [...colorRamp].sort(([left], [right]) => left - right).map(([density, color]) => ({
      color,
      density,
      parsed: parseHeatLayerColor(color),
    })),
  };
}

export function createHeatLayerDataSurfaceSvg({
  colorRamp,
  height,
  sources,
  width,
}: HeatLayerDataSurfaceOptions) {
  const maxInfluenceRadius = Math.max(0, ...sources.map((source) => source.influenceRadius));
  const blur = Math.max(1, maxInfluenceRadius * 0.16);
  const circles = sources
    .map((source) => {
      const normalizedWeight = clamp(source.weight, 0, 1);
      const radius = source.influenceRadius * (0.42 + Math.sqrt(normalizedWeight) * 0.5);
      const opacity = Math.min(1, 0.22 + normalizedWeight * 0.78);

      return `<circle cx="${roundSvgNumber(source.point.x)}" cy="${roundSvgNumber(
        source.point.y,
      )}" r="${roundSvgNumber(radius)}" fill="${escapeSvgAttribute(
        resolveHeatLayerInterpolatedColor(colorRamp, normalizedWeight),
      )}" opacity="${roundSvgNumber(opacity)}" />`;
    })
    .join("");

  return createHeatLayerSvg({ blur, content: circles, height, width });
}

export function createHeatLayerDataSurfaceDataUrl(options: HeatLayerDataSurfaceOptions) {
  const maxInfluenceRadius = Math.max(
    0,
    ...options.sources.map((source) => source.influenceRadius),
  );
  const blur = Math.max(1, maxInfluenceRadius * 0.16);
  const canvasUrl = createHeatLayerDataSurfaceCanvasDataUrl({ ...options, blur });

  return canvasUrl ?? createSvgDataUrl(createHeatLayerDataSurfaceSvg(options));
}

export async function createHeatLayerDataSurfaceImage(
  options: HeatLayerDataSurfaceOptions,
): Promise<HeatLayerSurfaceImage> {
  const maxInfluenceRadius = Math.max(
    0,
    ...options.sources.map((source) => source.influenceRadius),
  );
  const blur = Math.max(1, maxInfluenceRadius * 0.16);
  const canvasImage = await createHeatLayerDataSurfaceCanvasImage({ ...options, blur });

  return canvasImage ?? {
    objectUrl: false,
    url: createSvgDataUrl(createHeatLayerDataSurfaceSvg(options)),
  };
}

export function createHeatLayerInterpolatedSurfaceSvg({
  colorRamp,
  densityMode = "indexed",
  height,
  maxInfluenceRadius,
  metricProjection,
  sources,
  width,
}: HeatLayerInterpolatedSurfaceOptions) {
  const sampledSurface = createHeatLayerInterpolatedSurfaceSamples({
    densityMode,
    height,
    maxInfluenceRadius,
    metricProjection,
    sources,
    width,
  });

  return createHeatLayerSampledSurfaceSvg({
    ...sampledSurface,
    colorRamp,
    height,
    width,
  });
}

export function createHeatLayerInterpolatedSurfaceDataUrl(
  options: HeatLayerInterpolatedSurfaceOptions,
) {
  const sampledSurface = createHeatLayerInterpolatedSurfaceSamples(options);
  const canvasUrl = createHeatLayerSampledSurfaceCanvasDataUrl({
    ...sampledSurface,
    colorRamp: options.colorRamp,
    height: options.height,
    width: options.width,
  });

  return (
    canvasUrl ??
    createSvgDataUrl(
      createHeatLayerSampledSurfaceSvg({
        ...sampledSurface,
        colorRamp: options.colorRamp,
        height: options.height,
        width: options.width,
      }),
    )
  );
}

export async function createHeatLayerInterpolatedSurfaceImage(
  options: HeatLayerInterpolatedSurfaceOptions,
): Promise<HeatLayerSurfaceImage> {
  const sampledSurface = createHeatLayerInterpolatedSurfaceSamples(options);
  const canvasImage = await createHeatLayerSampledSurfaceCanvasImage({
    ...sampledSurface,
    colorRamp: options.colorRamp,
    height: options.height,
    width: options.width,
  });

  return canvasImage ?? {
    objectUrl: false,
    url: createSvgDataUrl(
      createHeatLayerSampledSurfaceSvg({
        ...sampledSurface,
        colorRamp: options.colorRamp,
        height: options.height,
        width: options.width,
      }),
    ),
  };
}

function createHeatLayerInterpolatedSurfaceSamples({
  densityMode = "indexed",
  height,
  maxInfluenceRadius,
  metricProjection,
  sources,
  width,
}: Omit<HeatLayerInterpolatedSurfaceOptions, "colorRamp">): HeatLayerInterpolatedSurfaceSamples {
  const metricSources = sources.filter(isMetricHeatLayerSurfaceSource);

  if (metricSources.length === sources.length) {
    return createHeatLayerMetricInterpolatedSurfaceSamples({
      densityMode,
      height,
      maxInfluenceRadius,
      metricProjection,
      sources: metricSources,
      width,
    });
  }

  if (densityMode === "indexed") {
    return createHeatLayerAccumulatedSurfaceSamples({
      height,
      maxInfluenceRadius,
      sources,
      width,
    });
  }

  const cellSize = resolveHeatLayerSampleSize(width, height, maxInfluenceRadius);
  const cells: HeatLayerSurfaceCell[] = [];
  const startX = -cellSize;
  const startY = -cellSize;
  const endX = width + cellSize;
  const endY = height + cellSize;

  for (let y = startY; y < endY; y += cellSize) {
    for (let x = startX; x < endX; x += cellSize) {
      const centerX = x + cellSize / 2;
      const centerY = y + cellSize / 2;
      const density = getHeatLayerCellDensityBruteForce(sources, centerX, centerY);

      cells.push({ density, x: centerX, y: centerY });
    }
  }

  for (const source of sources) {
    if (
      source.point.x < -maxInfluenceRadius ||
      source.point.x > width + maxInfluenceRadius ||
      source.point.y < -maxInfluenceRadius ||
      source.point.y > height + maxInfluenceRadius
    ) {
      continue;
    }

    cells.push({
      density: getHeatLayerCellDensityBruteForce(sources, source.point.x, source.point.y),
      x: source.point.x,
      y: source.point.y,
    });
  }

  return {
    blur: Math.max(5, cellSize * 0.75),
    cellSize,
    cells,
  };
}

export function createHeatLayerSurfaceSpatialIndex(
  sources: readonly HeatLayerSurfaceSource[],
): HeatLayerSurfaceSpatialIndex<HeatLayerSurfaceSource> {
  return createHeatLayerRadiusBucketSpatialIndex(
    sources,
    (source) => source.point,
    (source) => source.influenceRadius,
  );
}

export function createHeatLayerMetricSurfaceSpatialIndex(
  sources: readonly MetricHeatLayerSurfaceSource[],
): HeatLayerSurfaceSpatialIndex<MetricHeatLayerSurfaceSource> {
  return createHeatLayerRadiusBucketSpatialIndex(
    sources,
    (source) => source.metricPoint,
    (source) => source.dataInfluenceRadius,
  );
}

export function getHeatLayerCellDensityFromIndex(
  index: HeatLayerSurfaceSpatialIndex<HeatLayerSurfaceSource>,
  x: number,
  y: number,
) {
  let density = 0;

  visitHeatLayerSpatialIndexCandidates(index, x, y, (source) => {
    const dx = source.point.x - x;
    const dy = source.point.y - y;
    const distanceSquared = dx * dx + dy * dy;
    const localRadiusSquared = source.influenceRadius * source.influenceRadius;

    if (localRadiusSquared > 0 && distanceSquared <= localRadiusSquared) {
      density += source.weight * Math.exp((-3 * distanceSquared) / localRadiusSquared);
    }
  });

  return density;
}

export function getHeatLayerMetricCellDensityFromIndex(
  index: HeatLayerSurfaceSpatialIndex<MetricHeatLayerSurfaceSource>,
  x: number,
  y: number,
) {
  let density = 0;

  visitHeatLayerSpatialIndexCandidates(index, x, y, (source) => {
    const dx = source.metricPoint.x - x;
    const dy = source.metricPoint.y - y;
    const distanceSquared = dx * dx + dy * dy;
    const localRadiusSquared = source.dataInfluenceRadius * source.dataInfluenceRadius;

    if (localRadiusSquared > 0 && distanceSquared <= localRadiusSquared) {
      density += source.weight * Math.exp((-3 * distanceSquared) / localRadiusSquared);
    }
  });

  return density;
}

export function getHeatLayerCellDensityBruteForce(
  sources: readonly HeatLayerSurfaceSource[],
  x: number,
  y: number,
) {
  let density = 0;

  for (const source of sources) {
    const dx = source.point.x - x;
    const dy = source.point.y - y;
    const distanceSquared = dx * dx + dy * dy;
    const localRadiusSquared = source.influenceRadius * source.influenceRadius;

    if (localRadiusSquared > 0 && distanceSquared <= localRadiusSquared) {
      density += source.weight * Math.exp((-3 * distanceSquared) / localRadiusSquared);
    }
  }

  return density;
}

export function getHeatLayerMetricCellDensityBruteForce(
  sources: readonly MetricHeatLayerSurfaceSource[],
  x: number,
  y: number,
) {
  let density = 0;

  for (const source of sources) {
    const dx = source.metricPoint.x - x;
    const dy = source.metricPoint.y - y;
    const distanceSquared = dx * dx + dy * dy;
    const localRadiusSquared = source.dataInfluenceRadius * source.dataInfluenceRadius;

    if (localRadiusSquared > 0 && distanceSquared <= localRadiusSquared) {
      density += source.weight * Math.exp((-3 * distanceSquared) / localRadiusSquared);
    }
  }

  return density;
}

export function createSvgDataUrl(svg: string) {
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

export function resolveHeatLayerColor(colorRamp: PreparedHeatLayerColorRamp, weight: number) {
  if (colorRamp.stops.length === 0) {
    return "#dc2626";
  }

  const fallback = colorRamp.stops[colorRamp.stops.length - 1];

  for (const stop of colorRamp.stops) {
    if (weight <= stop.density) {
      return stop.color;
    }
  }

  return fallback?.color ?? "#dc2626";
}

export function resolveHeatLayerInterpolatedColor(
  colorRamp: PreparedHeatLayerColorRamp,
  weight: number,
) {
  if (colorRamp.stops.length === 0) {
    return "#dc2626";
  }

  const normalizedWeight = clamp(weight, 0, 1);
  const first = colorRamp.stops[0];

  if (!first || normalizedWeight <= first.density) {
    return first?.color ?? "#dc2626";
  }

  for (let index = 1; index < colorRamp.stops.length; index += 1) {
    const previous = colorRamp.stops[index - 1]!;
    const next = colorRamp.stops[index]!;

    if (normalizedWeight > next.density) {
      continue;
    }

    if (!previous.parsed || !next.parsed) {
      return resolveHeatLayerColor(colorRamp, normalizedWeight);
    }

    const progress =
      next.density <= previous.density
        ? 1
        : clamp((normalizedWeight - previous.density) / (next.density - previous.density), 0, 1);

    return formatHeatLayerColor({
      alpha: previous.parsed.alpha + (next.parsed.alpha - previous.parsed.alpha) * progress,
      blue: previous.parsed.blue + (next.parsed.blue - previous.parsed.blue) * progress,
      green: previous.parsed.green + (next.parsed.green - previous.parsed.green) * progress,
      red: previous.parsed.red + (next.parsed.red - previous.parsed.red) * progress,
    });
  }

  return colorRamp.stops[colorRamp.stops.length - 1]?.color ?? "#dc2626";
}

function createHeatLayerMetricInterpolatedSurfaceSamples({
  densityMode,
  height,
  maxInfluenceRadius,
  metricProjection,
  sources,
  width,
}: {
  densityMode: HeatLayerSurfaceDensityMode;
  height: number;
  maxInfluenceRadius: number;
  metricProjection: HeatLayerMetricSurfaceProjection;
  sources: readonly MetricHeatLayerSurfaceSource[];
  width: number;
}): HeatLayerInterpolatedSurfaceSamples {
  if (densityMode === "indexed") {
    return createHeatLayerMetricAccumulatedSurfaceSamples({
      height,
      maxInfluenceRadius,
      metricProjection,
      sources,
      width,
    });
  }

  const cellSize = resolveHeatLayerSampleSize(width, height, maxInfluenceRadius);
  const cells: HeatLayerSurfaceCell[] = [];
  const startX = -cellSize;
  const startY = -cellSize;
  const endX = width + cellSize;
  const endY = height + cellSize;
  const sampleColumns = getHeatLayerSampleCenters(startX, endX, cellSize).map((x) => ({
    metricX: metricProjection.getMetricX?.(x),
    x,
  }));
  const sampleRows = getHeatLayerSampleCenters(startY, endY, cellSize).map((y) => ({
    metricY: metricProjection.getMetricY?.(y),
    y,
  }));

  for (const row of sampleRows) {
    for (const column of sampleColumns) {
      const metricPoint =
        column.metricX !== undefined && row.metricY !== undefined
          ? { x: column.metricX, y: row.metricY }
          : metricProjection.getMetricPoint(column.x, row.y);
      const density = getHeatLayerMetricCellDensityBruteForce(
        sources,
        metricPoint.x,
        metricPoint.y,
      );

      cells.push({ density, x: column.x, y: row.y });
    }
  }

  for (const source of sources) {
    if (
      source.point.x < -maxInfluenceRadius ||
      source.point.x > width + maxInfluenceRadius ||
      source.point.y < -maxInfluenceRadius ||
      source.point.y > height + maxInfluenceRadius
    ) {
      continue;
    }

    cells.push({
      density: getHeatLayerMetricCellDensityBruteForce(
        sources,
        source.metricPoint.x,
        source.metricPoint.y,
      ),
      x: source.point.x,
      y: source.point.y,
    });
  }

  return {
    blur: Math.max(1, maxInfluenceRadius * 0.04),
    cellSize,
    cells,
  };
}

function createHeatLayerAccumulatedSurfaceSamples({
  height,
  maxInfluenceRadius,
  sources,
  width,
}: {
  height: number;
  maxInfluenceRadius: number;
  sources: readonly HeatLayerSurfaceSource[];
  width: number;
}): HeatLayerInterpolatedSurfaceSamples {
  const grid = createHeatLayerSampleGrid(width, height, maxInfluenceRadius);
  const densities = new Float64Array(grid.columnCount * grid.rowCount);

  for (const source of sources) {
    accumulateHeatLayerPixelSource(grid, densities, source);
  }

  const cells = createHeatLayerCellsFromSampleGrid(grid, densities);

  appendHeatLayerSourceAnchorCells({
    cells,
    densities,
    getFallbackDensity: (source) => source.weight,
    grid,
    maxInfluenceRadius,
    sources,
    width,
    height,
  });

  return {
    blur: Math.max(5, grid.cellSize * 0.75),
    cellSize: grid.cellSize,
    cells,
  };
}

function createHeatLayerMetricAccumulatedSurfaceSamples({
  height,
  maxInfluenceRadius,
  metricProjection,
  sources,
  width,
}: {
  height: number;
  maxInfluenceRadius: number;
  metricProjection: HeatLayerMetricSurfaceProjection;
  sources: readonly MetricHeatLayerSurfaceSource[];
  width: number;
}): HeatLayerInterpolatedSurfaceSamples {
  const grid = createHeatLayerMetricSampleGrid(width, height, maxInfluenceRadius, metricProjection);
  const densities = new Float64Array(grid.columnCount * grid.rowCount);

  for (const source of sources) {
    accumulateHeatLayerMetricSource(grid, densities, source);
  }

  const cells = createHeatLayerCellsFromSampleGrid(grid, densities);

  appendHeatLayerSourceAnchorCells({
    cells,
    densities,
    getFallbackDensity: (source) => source.weight,
    grid,
    maxInfluenceRadius,
    sources,
    width,
    height,
  });

  return {
    blur: Math.max(1, maxInfluenceRadius * 0.04),
    cellSize: grid.cellSize,
    cells,
  };
}

function createHeatLayerSampleGrid(
  width: number,
  height: number,
  maxInfluenceRadius: number,
): HeatLayerSampleGrid {
  const cellSize = resolveHeatLayerSampleSize(width, height, maxInfluenceRadius);
  const startX = -cellSize;
  const startY = -cellSize;
  const endX = width + cellSize;
  const endY = height + cellSize;
  const xCenters = Float64Array.from(getHeatLayerSampleCenters(startX, endX, cellSize));
  const yCenters = Float64Array.from(getHeatLayerSampleCenters(startY, endY, cellSize));

  return {
    cellSize,
    columnCount: xCenters.length,
    rowCount: yCenters.length,
    xCenters,
    yCenters,
  };
}

function createHeatLayerMetricSampleGrid(
  width: number,
  height: number,
  maxInfluenceRadius: number,
  metricProjection: HeatLayerMetricSurfaceProjection,
): HeatLayerMetricSampleGrid {
  const grid = createHeatLayerSampleGrid(width, height, maxInfluenceRadius);
  const metricXs = new Float64Array(grid.columnCount * grid.rowCount);
  const metricYs = new Float64Array(grid.columnCount * grid.rowCount);
  const columnMetricXs = metricProjection.getMetricX
    ? Array.from(grid.xCenters, (x) => metricProjection.getMetricX!(x))
    : null;
  const rowMetricYs = metricProjection.getMetricY
    ? Array.from(grid.yCenters, (y) => metricProjection.getMetricY!(y))
    : null;

  for (let row = 0; row < grid.rowCount; row += 1) {
    for (let column = 0; column < grid.columnCount; column += 1) {
      const index = row * grid.columnCount + column;

      if (columnMetricXs && rowMetricYs) {
        metricXs[index] = columnMetricXs[column] ?? 0;
        metricYs[index] = rowMetricYs[row] ?? 0;
      } else {
        const metricPoint = metricProjection.getMetricPoint(
          grid.xCenters[column] ?? 0,
          grid.yCenters[row] ?? 0,
        );

        metricXs[index] = metricPoint.x;
        metricYs[index] = metricPoint.y;
      }
    }
  }

  return {
    ...grid,
    metricXs,
    metricYs,
  };
}

function accumulateHeatLayerPixelSource(
  grid: HeatLayerSampleGrid,
  densities: Float64Array,
  source: HeatLayerSurfaceSource,
) {
  const radius = source.influenceRadius;
  const radiusSquared = radius * radius;

  if (radiusSquared <= 0 || source.weight <= 0) {
    return;
  }

  const bounds = getHeatLayerSourceSampleBounds(grid, source.point.x, source.point.y, radius);

  for (let row = bounds.minRow; row <= bounds.maxRow; row += 1) {
    const y = grid.yCenters[row] ?? 0;
    const dy = source.point.y - y;
    const dySquared = dy * dy;

    for (let column = bounds.minColumn; column <= bounds.maxColumn; column += 1) {
      const x = grid.xCenters[column] ?? 0;
      const dx = source.point.x - x;
      const distanceSquared = dx * dx + dySquared;

      if (distanceSquared <= radiusSquared) {
        densities[row * grid.columnCount + column] +=
          source.weight * Math.exp((-3 * distanceSquared) / radiusSquared);
      }
    }
  }
}

function accumulateHeatLayerMetricSource(
  grid: HeatLayerMetricSampleGrid,
  densities: Float64Array,
  source: MetricHeatLayerSurfaceSource,
) {
  const radius = source.dataInfluenceRadius;
  const radiusSquared = radius * radius;

  if (radiusSquared <= 0 || source.weight <= 0) {
    return;
  }

  const bounds = getHeatLayerSourceSampleBounds(
    grid,
    source.point.x,
    source.point.y,
    source.influenceRadius,
  );

  for (let row = bounds.minRow; row <= bounds.maxRow; row += 1) {
    for (let column = bounds.minColumn; column <= bounds.maxColumn; column += 1) {
      const index = row * grid.columnCount + column;
      const dx = source.metricPoint.x - (grid.metricXs[index] ?? 0);
      const dy = source.metricPoint.y - (grid.metricYs[index] ?? 0);
      const distanceSquared = dx * dx + dy * dy;

      if (distanceSquared <= radiusSquared) {
        densities[index] += source.weight * Math.exp((-3 * distanceSquared) / radiusSquared);
      }
    }
  }
}

function getHeatLayerSourceSampleBounds(
  grid: HeatLayerSampleGrid,
  x: number,
  y: number,
  radius: number,
) {
  const firstX = grid.xCenters[0] ?? 0;
  const firstY = grid.yCenters[0] ?? 0;

  return {
    maxColumn: clamp(
      Math.ceil((x + radius - firstX) / grid.cellSize),
      0,
      grid.columnCount - 1,
    ),
    maxRow: clamp(Math.ceil((y + radius - firstY) / grid.cellSize), 0, grid.rowCount - 1),
    minColumn: clamp(
      Math.floor((x - radius - firstX) / grid.cellSize),
      0,
      grid.columnCount - 1,
    ),
    minRow: clamp(Math.floor((y - radius - firstY) / grid.cellSize), 0, grid.rowCount - 1),
  };
}

function createHeatLayerCellsFromSampleGrid(
  grid: HeatLayerSampleGrid,
  densities: Float64Array,
): HeatLayerSurfaceCell[] {
  const cells: HeatLayerSurfaceCell[] = [];

  for (let row = 0; row < grid.rowCount; row += 1) {
    for (let column = 0; column < grid.columnCount; column += 1) {
      cells.push({
        density: densities[row * grid.columnCount + column] ?? 0,
        x: grid.xCenters[column] ?? 0,
        y: grid.yCenters[row] ?? 0,
      });
    }
  }

  return cells;
}

function appendHeatLayerSourceAnchorCells<TSource extends HeatLayerSurfaceSource>({
  cells,
  densities,
  getFallbackDensity,
  grid,
  height,
  maxInfluenceRadius,
  sources,
  width,
}: {
  cells: HeatLayerSurfaceCell[];
  densities: Float64Array;
  getFallbackDensity: (source: TSource) => number;
  grid: HeatLayerSampleGrid;
  height: number;
  maxInfluenceRadius: number;
  sources: readonly TSource[];
  width: number;
}) {
  for (const source of sources) {
    if (
      source.point.x < -maxInfluenceRadius ||
      source.point.x > width + maxInfluenceRadius ||
      source.point.y < -maxInfluenceRadius ||
      source.point.y > height + maxInfluenceRadius
    ) {
      continue;
    }

    cells.push({
      density: Math.max(
        getFallbackDensity(source),
        getNearestHeatLayerSampleDensity(grid, densities, source.point.x, source.point.y),
      ),
      x: source.point.x,
      y: source.point.y,
    });
  }
}

function getNearestHeatLayerSampleDensity(
  grid: HeatLayerSampleGrid,
  densities: Float64Array,
  x: number,
  y: number,
) {
  const firstX = grid.xCenters[0] ?? 0;
  const firstY = grid.yCenters[0] ?? 0;
  const column = clamp(Math.round((x - firstX) / grid.cellSize), 0, grid.columnCount - 1);
  const row = clamp(Math.round((y - firstY) / grid.cellSize), 0, grid.rowCount - 1);

  return densities[row * grid.columnCount + column] ?? 0;
}

function createHeatLayerSampledSurfaceSvg({
  blur,
  cellSize,
  cells,
  colorRamp,
  height,
  width,
}: {
  blur: number;
  cellSize: number;
  cells: readonly HeatLayerSurfaceCell[];
  colorRamp: PreparedHeatLayerColorRamp;
  height: number;
  width: number;
}) {
  const sampleRadius = cellSize * 1.15;
  const circles = cells
    .map((cell) => {
      const normalizedDensity = resolveHeatLayerAbsoluteDensity(cell.density);

      return `<circle cx="${roundSvgNumber(cell.x)}" cy="${roundSvgNumber(cell.y)}" r="${roundSvgNumber(
        sampleRadius,
      )}" fill="${escapeSvgAttribute(
        resolveHeatLayerInterpolatedColor(colorRamp, normalizedDensity),
      )}" opacity="${roundSvgNumber(Math.min(1, 0.28 + normalizedDensity * 0.72))}" />`;
    })
    .join("");

  return createHeatLayerSvg({
    blur,
    content: circles,
    height,
    width,
  });
}

function createHeatLayerDataSurfaceCanvasDataUrl({
  blur,
  colorRamp,
  height,
  sources,
  width,
}: HeatLayerDataSurfaceOptions & {
  blur: number;
}) {
  return createHeatLayerCanvasDataUrl({
    blur,
    draw(context) {
      for (const source of sources) {
        const normalizedWeight = clamp(source.weight, 0, 1);
        const radius = source.influenceRadius * (0.42 + Math.sqrt(normalizedWeight) * 0.5);
        const opacity = Math.min(1, 0.22 + normalizedWeight * 0.78);

        drawHeatLayerCanvasCircle(
          context,
          source.point.x,
          source.point.y,
          radius,
          resolveHeatLayerInterpolatedColor(colorRamp, normalizedWeight),
          opacity,
        );
      }
    },
    height,
    width,
  });
}

function createHeatLayerDataSurfaceCanvasImage({
  blur,
  colorRamp,
  height,
  sources,
  width,
}: HeatLayerDataSurfaceOptions & {
  blur: number;
}) {
  return createHeatLayerCanvasImage({
    blur,
    draw(context) {
      for (const source of sources) {
        const normalizedWeight = clamp(source.weight, 0, 1);
        const radius = source.influenceRadius * (0.42 + Math.sqrt(normalizedWeight) * 0.5);
        const opacity = Math.min(1, 0.22 + normalizedWeight * 0.78);

        drawHeatLayerCanvasCircle(
          context,
          source.point.x,
          source.point.y,
          radius,
          resolveHeatLayerInterpolatedColor(colorRamp, normalizedWeight),
          opacity,
        );
      }
    },
    height,
    width,
  });
}

function createHeatLayerSampledSurfaceCanvasDataUrl({
  cellSize,
  cells,
  colorRamp,
  height,
  width,
}: {
  blur: number;
  cellSize: number;
  cells: readonly HeatLayerSurfaceCell[];
  colorRamp: PreparedHeatLayerColorRamp;
  height: number;
  width: number;
}) {
  return createHeatLayerCanvasDataUrl({
    blur: 0,
    draw(context) {
      for (const cell of cells) {
        const normalizedDensity = resolveHeatLayerAbsoluteDensity(cell.density);
        const opacity = Math.min(1, 0.28 + normalizedDensity * 0.72);

        context.globalAlpha = opacity;
        context.fillStyle = resolveHeatLayerInterpolatedColor(colorRamp, normalizedDensity);
        context.fillRect(
          cell.x - cellSize * 0.65,
          cell.y - cellSize * 0.65,
          cellSize * 1.3,
          cellSize * 1.3,
        );
      }
    },
    height,
    width,
  });
}

function createHeatLayerSampledSurfaceCanvasImage({
  cellSize,
  cells,
  colorRamp,
  height,
  width,
}: {
  blur: number;
  cellSize: number;
  cells: readonly HeatLayerSurfaceCell[];
  colorRamp: PreparedHeatLayerColorRamp;
  height: number;
  width: number;
}) {
  return createHeatLayerCanvasImage({
    blur: 0,
    draw(context) {
      for (const cell of cells) {
        const normalizedDensity = resolveHeatLayerAbsoluteDensity(cell.density);
        const opacity = Math.min(1, 0.28 + normalizedDensity * 0.72);

        context.globalAlpha = opacity;
        context.fillStyle = resolveHeatLayerInterpolatedColor(colorRamp, normalizedDensity);
        context.fillRect(
          cell.x - cellSize * 0.65,
          cell.y - cellSize * 0.65,
          cellSize * 1.3,
          cellSize * 1.3,
        );
      }
    },
    height,
    width,
  });
}

function createHeatLayerCanvasDataUrl({
  blur,
  draw,
  height,
  width,
}: {
  blur: number;
  draw: (context: CanvasRenderingContext2D) => void;
  height: number;
  width: number;
}) {
  if (!canUseHeatLayerCanvas()) {
    return null;
  }

  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");

  if (!context) {
    return null;
  }

  canvas.width = Math.max(1, Math.ceil(width));
  canvas.height = Math.max(1, Math.ceil(height));
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.save();
  context.filter = `blur(${roundSvgNumber(Math.max(0, blur))}px)`;
  draw(context);
  context.restore();

  return canvas.toDataURL("image/png");
}

async function createHeatLayerCanvasImage(options: {
  blur: number;
  draw: (context: CanvasRenderingContext2D) => void;
  height: number;
  width: number;
}): Promise<HeatLayerSurfaceImage | null> {
  const canvas = createHeatLayerCanvas(options);

  if (!canvas) {
    return null;
  }

  const objectUrl = await createHeatLayerCanvasObjectUrl(canvas);

  if (objectUrl) {
    return {
      objectUrl: true,
      url: objectUrl,
    };
  }

  return {
    objectUrl: false,
    url: canvas.toDataURL("image/png"),
  };
}

function createHeatLayerCanvas({
  blur,
  draw,
  height,
  width,
}: {
  blur: number;
  draw: (context: CanvasRenderingContext2D) => void;
  height: number;
  width: number;
}) {
  if (!canUseHeatLayerCanvas()) {
    return null;
  }

  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");

  if (!context) {
    return null;
  }

  canvas.width = Math.max(1, Math.ceil(width));
  canvas.height = Math.max(1, Math.ceil(height));
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.save();
  context.filter = `blur(${roundSvgNumber(Math.max(0, blur))}px)`;
  draw(context);
  context.restore();

  return canvas;
}

function createHeatLayerCanvasObjectUrl(canvas: HTMLCanvasElement) {
  if (
    typeof URL === "undefined" ||
    typeof URL.createObjectURL !== "function" ||
    typeof canvas.toBlob !== "function"
  ) {
    return Promise.resolve(null);
  }

  return new Promise<string | null>((resolve) => {
    canvas.toBlob((blob) => {
      resolve(blob ? URL.createObjectURL(blob) : null);
    }, "image/png");
  });
}

function drawHeatLayerCanvasCircle(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  fill: string,
  opacity: number,
) {
  if (radius <= 0 || opacity <= 0) {
    return;
  }

  context.globalAlpha = clamp(opacity, 0, 1);
  context.fillStyle = fill;
  context.beginPath();
  context.arc(x, y, radius, 0, Math.PI * 2);
  context.fill();
}

function canUseHeatLayerCanvas() {
  return (
    typeof document !== "undefined" &&
    typeof navigator !== "undefined" &&
    !/jsdom/i.test(navigator.userAgent)
  );
}

function resolveHeatLayerSampleSize(width: number, height: number, influenceRadius: number) {
  const preferredCellSize = clamp(Math.round(influenceRadius / 7), 8, 18);
  const maxSamples = 8_000;
  const estimatedSamples =
    Math.ceil((width + preferredCellSize * 2) / preferredCellSize) *
    Math.ceil((height + preferredCellSize * 2) / preferredCellSize);

  if (estimatedSamples <= maxSamples) {
    return preferredCellSize;
  }

  return Math.ceil(
    Math.sqrt(((width + preferredCellSize * 2) * (height + preferredCellSize * 2)) / maxSamples),
  );
}

function getHeatLayerSampleCenters(start: number, end: number, cellSize: number) {
  const centers: number[] = [];

  for (let value = start; value < end; value += cellSize) {
    centers.push(value + cellSize / 2);
  }

  return centers;
}

function resolveHeatLayerAbsoluteDensity(density: number) {
  return clamp(
    INTERPOLATED_HEAT_MIN_DENSITY +
      Math.pow(Math.max(0, density), INTERPOLATED_HEAT_DENSITY_GAMMA) *
        (1 - INTERPOLATED_HEAT_MIN_DENSITY),
    0,
    1,
  );
}

function isMetricHeatLayerSurfaceSource(
  source: HeatLayerSurfaceSource,
): source is MetricHeatLayerSurfaceSource {
  return source.dataInfluenceRadius !== null && source.dataInfluenceRadius > 0;
}

function visitHeatLayerSpatialIndexCandidates<TSource>(
  index: HeatLayerSurfaceSpatialIndex<TSource>,
  x: number,
  y: number,
  visit: (source: TSource) => void,
) {
  if (index.buckets.length === 0 || index.maxRadius <= 0) {
    return;
  }

  for (const bucket of index.buckets) {
    if (bucket.cells.size === 0 || bucket.maxRadius <= 0) {
      continue;
    }

    const minColumn = Math.floor((x - bucket.maxRadius) / bucket.cellSize);
    const maxColumn = Math.floor((x + bucket.maxRadius) / bucket.cellSize);
    const minRow = Math.floor((y - bucket.maxRadius) / bucket.cellSize);
    const maxRow = Math.floor((y + bucket.maxRadius) / bucket.cellSize);

    for (let row = minRow; row <= maxRow; row += 1) {
      for (let column = minColumn; column <= maxColumn; column += 1) {
        const cell = bucket.cells.get(getHeatLayerSpatialCellKey(column, row));

        if (!cell) {
          continue;
        }

        for (const source of cell) {
          visit(source);
        }
      }
    }
  }
}

function createHeatLayerRadiusBucketSpatialIndex<TSource>(
  sources: readonly TSource[],
  getPoint: (source: TSource) => HeatLayerMetricPoint,
  getRadius: (source: TSource) => number,
): HeatLayerSurfaceSpatialIndex<TSource> {
  const bucketsByCellSize = new Map<number, HeatLayerSurfaceSpatialIndexBucket<TSource>>();
  let maxRadius = 0;

  for (const source of sources) {
    const radius = getRadius(source);

    if (!Number.isFinite(radius) || radius <= 0) {
      continue;
    }

    const point = getPoint(source);
    const cellSize = getHeatLayerRadiusBucketCellSize(radius);
    let bucket = bucketsByCellSize.get(cellSize);

    if (!bucket) {
      bucket = {
        cellSize,
        cells: new Map(),
        maxRadius: radius,
      };
      bucketsByCellSize.set(cellSize, bucket);
    } else {
      bucket.maxRadius = Math.max(bucket.maxRadius, radius);
    }

    maxRadius = Math.max(maxRadius, radius);

    const column = Math.floor(point.x / cellSize);
    const row = Math.floor(point.y / cellSize);
    const key = getHeatLayerSpatialCellKey(column, row);
    const cell = bucket.cells.get(key);

    if (cell) {
      cell.push(source);
    } else {
      bucket.cells.set(key, [source]);
    }
  }

  const buckets = [...bucketsByCellSize.values()].sort((left, right) => left.cellSize - right.cellSize);
  const largestBucket = buckets[buckets.length - 1];

  return {
    buckets,
    cellSize: largestBucket?.cellSize ?? 1,
    cells: largestBucket?.cells ?? new Map(),
    maxRadius,
  };
}

function getHeatLayerRadiusBucketCellSize(radius: number) {
  return 2 ** Math.ceil(Math.log2(Math.max(1, radius)));
}

function getHeatLayerSpatialCellKey(column: number, row: number) {
  const x = column >= 0 ? column * 2 : -column * 2 - 1;
  const y = row >= 0 ? row * 2 : -row * 2 - 1;

  return ((x + y) * (x + y + 1)) / 2 + y;
}

function createHeatLayerSvg({
  blur,
  content,
  height,
  width,
}: {
  blur: number;
  content: string;
  height: number;
  width: number;
}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(width)}" height="${Math.ceil(
    height,
  )}" viewBox="0 0 ${roundSvgNumber(width)} ${roundSvgNumber(
    height,
  )}" preserveAspectRatio="none"><defs><filter id="heat-soften" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="${roundSvgNumber(
    blur,
  )}" /></filter></defs><rect width="100%" height="100%" fill="transparent" /><g filter="url(#heat-soften)">${content}</g></svg>`;
}

function parseHeatLayerColor(color: string): HeatLayerParsedColor | null {
  const trimmedColor = color.trim();

  if (trimmedColor === "transparent") {
    return {
      alpha: 0,
      blue: 0,
      green: 0,
      red: 0,
    };
  }

  const hexMatch = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(trimmedColor);

  if (hexMatch?.[1]) {
    const hex = hexMatch[1];
    const normalizedHex =
      hex.length === 3
        ? hex
            .split("")
            .map((channel) => `${channel}${channel}`)
            .join("")
        : hex;

    return {
      alpha: 1,
      blue: Number.parseInt(normalizedHex.slice(4, 6), 16),
      green: Number.parseInt(normalizedHex.slice(2, 4), 16),
      red: Number.parseInt(normalizedHex.slice(0, 2), 16),
    };
  }

  const rgbMatch =
    /^rgba?\(\s*([0-9.]+)(?:,|\s)\s*([0-9.]+)(?:,|\s)\s*([0-9.]+)(?:(?:,|\s*\/\s*)\s*([0-9.]+))?\s*\)$/i.exec(
      trimmedColor,
    );

  if (!rgbMatch) {
    return null;
  }

  return {
    alpha: rgbMatch[4] === undefined ? 1 : clamp(Number(rgbMatch[4]), 0, 1),
    blue: clamp(Number(rgbMatch[3]), 0, 255),
    green: clamp(Number(rgbMatch[2]), 0, 255),
    red: clamp(Number(rgbMatch[1]), 0, 255),
  };
}

function formatHeatLayerColor(color: HeatLayerParsedColor) {
  return `rgba(${Math.round(clamp(color.red, 0, 255))}, ${Math.round(
    clamp(color.green, 0, 255),
  )}, ${Math.round(clamp(color.blue, 0, 255))}, ${roundSvgNumber(clamp(color.alpha, 0, 1))})`;
}

function escapeSvgAttribute(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function roundSvgNumber(value: number) {
  return Number(value.toFixed(3));
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}
