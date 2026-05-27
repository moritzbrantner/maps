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
  cellSize: number;
  cells: Map<string, TSource[]>;
  maxRadius: number;
};

type HeatLayerParsedColor = {
  alpha: number;
  blue: number;
  green: number;
  red: number;
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
}: {
  colorRamp: PreparedHeatLayerColorRamp;
  height: number;
  sources: readonly HeatLayerSurfaceSource[];
  width: number;
}) {
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

export function createHeatLayerInterpolatedSurfaceSvg({
  colorRamp,
  densityMode = "indexed",
  height,
  maxInfluenceRadius,
  metricProjection,
  sources,
  width,
}: {
  colorRamp: PreparedHeatLayerColorRamp;
  densityMode?: HeatLayerSurfaceDensityMode;
  height: number;
  maxInfluenceRadius: number;
  metricProjection: HeatLayerMetricSurfaceProjection;
  sources: readonly HeatLayerSurfaceSource[];
  width: number;
}) {
  const metricSources = sources.filter(isMetricHeatLayerSurfaceSource);

  if (metricSources.length === sources.length) {
    return createHeatLayerMetricInterpolatedSurfaceSvg({
      colorRamp,
      densityMode,
      height,
      maxInfluenceRadius,
      metricProjection,
      sources: metricSources,
      width,
    });
  }

  const cellSize = resolveHeatLayerSampleSize(width, height, maxInfluenceRadius);
  const cells: HeatLayerSurfaceCell[] = [];
  const sourceIndex =
    densityMode === "indexed" &&
    shouldUseHeatLayerSurfaceSpatialIndex({
      height,
      maxInfluenceRadius,
      sourceCount: sources.length,
      width,
    })
      ? createHeatLayerSurfaceSpatialIndex(sources)
      : null;
  const startX = -cellSize;
  const startY = -cellSize;
  const endX = width + cellSize;
  const endY = height + cellSize;

  for (let y = startY; y < endY; y += cellSize) {
    for (let x = startX; x < endX; x += cellSize) {
      const centerX = x + cellSize / 2;
      const centerY = y + cellSize / 2;
      const density = sourceIndex
        ? getHeatLayerCellDensityFromIndex(sourceIndex, centerX, centerY)
        : getHeatLayerCellDensityBruteForce(sources, centerX, centerY);

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
      density: sourceIndex
        ? getHeatLayerCellDensityFromIndex(sourceIndex, source.point.x, source.point.y)
        : getHeatLayerCellDensityBruteForce(sources, source.point.x, source.point.y),
      x: source.point.x,
      y: source.point.y,
    });
  }

  return createHeatLayerSampledSurfaceSvg({
    blur: Math.max(5, cellSize * 0.75),
    cellSize,
    cells,
    colorRamp,
    height,
    width,
  });
}

export function createHeatLayerSurfaceSpatialIndex(
  sources: readonly HeatLayerSurfaceSource[],
): HeatLayerSurfaceSpatialIndex<HeatLayerSurfaceSource> {
  const maxRadius = Math.max(0, ...sources.map((source) => source.influenceRadius));
  const cellSize = Math.max(1, maxRadius);
  const cells = new Map<string, HeatLayerSurfaceSource[]>();

  for (const source of sources) {
    const column = Math.floor(source.point.x / cellSize);
    const row = Math.floor(source.point.y / cellSize);
    const key = getHeatLayerSpatialCellKey(column, row);
    const cell = cells.get(key);

    if (cell) {
      cell.push(source);
    } else {
      cells.set(key, [source]);
    }
  }

  return {
    cellSize,
    cells,
    maxRadius,
  };
}

export function createHeatLayerMetricSurfaceSpatialIndex(
  sources: readonly MetricHeatLayerSurfaceSource[],
): HeatLayerSurfaceSpatialIndex<MetricHeatLayerSurfaceSource> {
  const maxRadius = Math.max(0, ...sources.map((source) => source.dataInfluenceRadius));
  const cellSize = Math.max(1, maxRadius);
  const cells = new Map<string, MetricHeatLayerSurfaceSource[]>();

  for (const source of sources) {
    const column = Math.floor(source.metricPoint.x / cellSize);
    const row = Math.floor(source.metricPoint.y / cellSize);
    const key = getHeatLayerSpatialCellKey(column, row);
    const cell = cells.get(key);

    if (cell) {
      cell.push(source);
    } else {
      cells.set(key, [source]);
    }
  }

  return {
    cellSize,
    cells,
    maxRadius,
  };
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

function createHeatLayerMetricInterpolatedSurfaceSvg({
  colorRamp,
  densityMode,
  height,
  maxInfluenceRadius,
  metricProjection,
  sources,
  width,
}: {
  colorRamp: PreparedHeatLayerColorRamp;
  densityMode: HeatLayerSurfaceDensityMode;
  height: number;
  maxInfluenceRadius: number;
  metricProjection: HeatLayerMetricSurfaceProjection;
  sources: readonly MetricHeatLayerSurfaceSource[];
  width: number;
}) {
  const cellSize = resolveHeatLayerSampleSize(width, height, maxInfluenceRadius);
  const cells: HeatLayerSurfaceCell[] = [];
  const sourceIndex =
    densityMode === "indexed" &&
    shouldUseHeatLayerSurfaceSpatialIndex({
      height,
      maxInfluenceRadius,
      sourceCount: sources.length,
      width,
    })
      ? createHeatLayerMetricSurfaceSpatialIndex(sources)
      : null;
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
      const density = sourceIndex
        ? getHeatLayerMetricCellDensityFromIndex(sourceIndex, metricPoint.x, metricPoint.y)
        : getHeatLayerMetricCellDensityBruteForce(sources, metricPoint.x, metricPoint.y);

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
      density: sourceIndex
        ? getHeatLayerMetricCellDensityFromIndex(
            sourceIndex,
            source.metricPoint.x,
            source.metricPoint.y,
          )
        : getHeatLayerMetricCellDensityBruteForce(
            sources,
            source.metricPoint.x,
            source.metricPoint.y,
          ),
      x: source.point.x,
      y: source.point.y,
    });
  }

  return createHeatLayerSampledSurfaceSvg({
    blur: Math.max(1, maxInfluenceRadius * 0.04),
    cellSize,
    cells,
    colorRamp,
    height,
    width,
  });
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

function shouldUseHeatLayerSurfaceSpatialIndex({
  height,
  maxInfluenceRadius,
  sourceCount,
  width,
}: {
  height: number;
  maxInfluenceRadius: number;
  sourceCount: number;
  width: number;
}) {
  if (sourceCount <= 0 || maxInfluenceRadius <= 0) {
    return false;
  }

  const cellSize = Math.max(1, maxInfluenceRadius);
  const domainColumns = Math.max(1, Math.ceil((width + maxInfluenceRadius * 2) / cellSize));
  const domainRows = Math.max(1, Math.ceil((height + maxInfluenceRadius * 2) / cellSize));
  const domainCellCount = domainColumns * domainRows;
  const queryCellsPerSample = 9;
  const estimatedCandidateRatio = queryCellsPerSample / domainCellCount;

  return estimatedCandidateRatio < 0.25;
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
  if (index.cells.size === 0 || index.maxRadius <= 0) {
    return;
  }

  const minColumn = Math.floor((x - index.maxRadius) / index.cellSize);
  const maxColumn = Math.floor((x + index.maxRadius) / index.cellSize);
  const minRow = Math.floor((y - index.maxRadius) / index.cellSize);
  const maxRow = Math.floor((y + index.maxRadius) / index.cellSize);

  for (let row = minRow; row <= maxRow; row += 1) {
    for (let column = minColumn; column <= maxColumn; column += 1) {
      const cell = index.cells.get(getHeatLayerSpatialCellKey(column, row));

      if (!cell) {
        continue;
      }

      for (const source of cell) {
        visit(source);
      }
    }
  }
}

function getHeatLayerSpatialCellKey(column: number, row: number) {
  return `${column}:${row}`;
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
