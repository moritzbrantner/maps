import type { IndexedMapPoint, MapPoint, MapPointFilter } from "./aggregation";

const EARTH_RADIUS_METERS = 6_371_008.8;
const DEFAULT_FIELD_COLUMNS = 256;
const DEFAULT_INTERPOLATION_K = 12;
const DEFAULT_INTERPOLATION_POWER = 2;
const DEFAULT_DOMAIN_PADDING_RATIO = 0.08;
const DEFAULT_EPSILON_METERS = 1;
const MAX_EXPLICIT_FIELD_SIZE = 2_048;

export type HeatFieldInterpolation = "idw";

export type HeatFieldMaskGeoJson = {
  [key: string]: unknown;
  type: string;
};

export type HeatFieldOptions<TProperties = Record<string, unknown>> = {
  colorRamp?: readonly [valueOrNormalized: number, color: string][];
  domainBounds?: [west: number, south: number, east: number, north: number];
  domainPaddingRatio?: number;
  fieldCellSizeMeters?: number;
  fieldColumns?: number;
  fieldRows?: number;
  filterPoint?: MapPointFilter<TProperties>;
  getValue?: (point: IndexedMapPoint<TProperties>) => number;
  interpolation?: HeatFieldInterpolation;
  interpolationEpsilonMeters?: number;
  interpolationExtrapolate?: boolean;
  interpolationK?: number;
  interpolationMaxDistanceMeters?: number;
  interpolationPower?: number;
  // Reserved for clipping field rasters to polygons. The first field implementation
  // intentionally keeps the core IDW path unmasked and deterministic.
  maskGeoJson?: HeatFieldMaskGeoJson | null;
  opacity?: number;
  valueDomain?: [min: number, max: number];
  valueMetric?: string;
};

export type ScalarFieldValuePoint<TProperties = Record<string, unknown>> = {
  index: number;
  point: IndexedMapPoint<TProperties>;
  value: number;
};

export type ScalarFieldGrid = {
  bounds: [west: number, south: number, east: number, north: number];
  columns: number;
  rows: number;
  valueDomain: [min: number, max: number] | null;
  values: Array<number | null>;
};

export type ScalarFieldInterpolator = {
  bounds: [west: number, south: number, east: number, north: number];
  getValueAtCoordinate(coordinate: [longitude: number, latitude: number]): number | null;
  pointCount: number;
  valueDomain: [min: number, max: number] | null;
};

type MetricProjection = {
  centerLatitudeRadians: number;
  project: (coordinate: [longitude: number, latitude: number]) => MetricPoint;
};

type MetricPoint = {
  x: number;
  y: number;
};

type ProjectedValuePoint<TProperties = Record<string, unknown>> =
  ScalarFieldValuePoint<TProperties> &
    MetricPoint & {
      gridColumn: number;
      gridRow: number;
    };

type DistanceCandidate<TProperties = Record<string, unknown>> = {
  distanceMeters: number;
  distanceSquared: number;
  point: ProjectedValuePoint<TProperties>;
};

type SpatialGrid<TProperties = Record<string, unknown>> = {
  cellSizeMeters: number;
  cells: Map<string, Array<ProjectedValuePoint<TProperties>>>;
  maxColumn: number;
  maxRow: number;
  minColumn: number;
  minRow: number;
};

export function createScalarFieldGrid<TProperties = Record<string, unknown>>(
  points: readonly MapPoint<TProperties>[],
  options: HeatFieldOptions<TProperties> = {},
): ScalarFieldGrid {
  const valuePoints = resolveScalarFieldValuePoints(points, options);
  const bounds = resolveScalarFieldBounds(valuePoints, options);

  if (!bounds) {
    return {
      bounds: [0, 0, 0, 0],
      columns: 0,
      rows: 0,
      valueDomain: null,
      values: [],
    };
  }

  const dimensions = resolveScalarFieldDimensions(bounds, options);

  if (dimensions.columns <= 0 || dimensions.rows <= 0) {
    return {
      bounds,
      columns: 0,
      rows: 0,
      valueDomain: resolveValueDomain(valuePoints, [], options.valueDomain),
      values: [],
    };
  }

  const interpolator = createIdwInterpolatorFromValuePoints(valuePoints, bounds, options);
  const values: Array<number | null> = [];
  const [west, south, east, north] = bounds;
  const longitudeStep = (east - west) / dimensions.columns;
  const latitudeStep = (north - south) / dimensions.rows;

  for (let row = 0; row < dimensions.rows; row += 1) {
    const latitude = north - latitudeStep * (row + 0.5);

    for (let column = 0; column < dimensions.columns; column += 1) {
      const longitude = west + longitudeStep * (column + 0.5);
      values.push(interpolator.getValueAtCoordinate([longitude, latitude]));
    }
  }

  return {
    bounds,
    columns: dimensions.columns,
    rows: dimensions.rows,
    valueDomain: resolveValueDomain(valuePoints, values, options.valueDomain),
    values,
  };
}

export function createIdwInterpolator<TProperties = Record<string, unknown>>(
  points: readonly MapPoint<TProperties>[],
  options: HeatFieldOptions<TProperties> = {},
): ScalarFieldInterpolator {
  const valuePoints = resolveScalarFieldValuePoints(points, options);
  const bounds = resolveScalarFieldBounds(valuePoints, options) ?? [0, 0, 0, 0];

  return createIdwInterpolatorFromValuePoints(valuePoints, bounds, options);
}

export function getScalarFieldValueAtCoordinate(
  gridOrInterpolator: ScalarFieldGrid | ScalarFieldInterpolator,
  coordinate: [longitude: number, latitude: number],
): number | null {
  if ("getValueAtCoordinate" in gridOrInterpolator) {
    return gridOrInterpolator.getValueAtCoordinate(coordinate);
  }

  return getScalarFieldGridValueAtCoordinate(gridOrInterpolator, coordinate);
}

export function normalizeScalarFieldValue(
  value: number,
  valueDomain: [min: number, max: number] | null,
) {
  if (!valueDomain || !Number.isFinite(value)) {
    return null;
  }

  const [min, max] = valueDomain;

  if (max <= min) {
    return 0.5;
  }

  return clamp((value - min) / (max - min), 0, 1);
}

export function resolveScalarFieldValuePoints<TProperties = Record<string, unknown>>(
  points: readonly MapPoint<TProperties>[],
  options: Pick<HeatFieldOptions<TProperties>, "filterPoint" | "getValue" | "valueMetric"> = {},
): Array<ScalarFieldValuePoint<TProperties>> {
  return points
    .map(toIndexedMapPoint)
    .filter(isValidCoordinatePoint)
    .filter((point) => options.filterPoint?.(point) ?? true)
    .map((point, index) => {
      const value = resolveScalarFieldPointValue(point, options);

      if (!Number.isFinite(value)) {
        return null;
      }

      return {
        index,
        point,
        value,
      };
    })
    .filter(isDefined);
}

function createIdwInterpolatorFromValuePoints<TProperties = Record<string, unknown>>(
  valuePoints: readonly ScalarFieldValuePoint<TProperties>[],
  bounds: [west: number, south: number, east: number, north: number],
  options: HeatFieldOptions<TProperties>,
): ScalarFieldInterpolator {
  const projection = createLocalEquirectangularProjection(bounds);
  const projectedPoints = valuePoints.map((entry) => {
    const projected = projection.project([entry.point.longitude, entry.point.latitude]);

    return {
      ...entry,
      gridColumn: 0,
      gridRow: 0,
      x: projected.x,
      y: projected.y,
    };
  });
  const projectedBounds = getProjectedBounds(bounds, projection);
  const spatialGrid = createMetricSpatialGrid(projectedPoints, projectedBounds, options);
  const power = getPositiveFinite(options.interpolationPower, DEFAULT_INTERPOLATION_POWER);
  const kNearest = Math.max(1, Math.floor(getPositiveFinite(options.interpolationK, DEFAULT_INTERPOLATION_K)));
  const epsilonMeters = Math.max(
    0,
    getPositiveFinite(options.interpolationEpsilonMeters, DEFAULT_EPSILON_METERS),
  );
  const maxDistanceMeters =
    Number.isFinite(options.interpolationMaxDistanceMeters) &&
    (options.interpolationMaxDistanceMeters ?? 0) > 0
      ? options.interpolationMaxDistanceMeters!
      : null;
  const extrapolate = options.interpolationExtrapolate ?? true;

  return {
    bounds,
    getValueAtCoordinate(coordinate) {
      if (projectedPoints.length === 0 || !isValidCoordinate(coordinate)) {
        return null;
      }

      const projected = projection.project(coordinate);
      let candidates = getSpatialGridCandidates(projected, spatialGrid, {
        kNearest,
        maxDistanceMeters,
      });

      if (maxDistanceMeters !== null) {
        candidates = candidates.filter((candidate) => candidate.distanceMeters <= maxDistanceMeters);

        if (candidates.length === 0 && extrapolate) {
          candidates = getSpatialGridCandidates(projected, spatialGrid, {
            kNearest,
            maxDistanceMeters: null,
          });
        }
      }

      if (candidates.length === 0) {
        return null;
      }

      candidates.sort(compareDistanceCandidates);

      const exact = candidates.find((candidate) => candidate.distanceMeters <= epsilonMeters);

      if (exact) {
        return exact.point.value;
      }

      return interpolateIdw(candidates.slice(0, kNearest), power);
    },
    pointCount: projectedPoints.length,
    valueDomain: resolveValueDomain(valuePoints, [], options.valueDomain),
  };
}

function interpolateIdw<TProperties>(
  candidates: readonly DistanceCandidate<TProperties>[],
  power: number,
) {
  let weightedValue = 0;
  let totalWeight = 0;

  for (const candidate of candidates) {
    if (candidate.distanceMeters <= 0) {
      return candidate.point.value;
    }

    const weight = 1 / candidate.distanceMeters ** power;
    weightedValue += weight * candidate.point.value;
    totalWeight += weight;
  }

  return totalWeight > 0 ? weightedValue / totalWeight : null;
}

function getScalarFieldGridValueAtCoordinate(
  grid: ScalarFieldGrid,
  [longitude, latitude]: [longitude: number, latitude: number],
) {
  const [west, south, east, north] = grid.bounds;

  if (
    grid.columns <= 0 ||
    grid.rows <= 0 ||
    longitude < west ||
    longitude > east ||
    latitude < south ||
    latitude > north
  ) {
    return null;
  }

  const columnPosition = ((longitude - west) / Math.max(Number.EPSILON, east - west)) * grid.columns - 0.5;
  const rowPosition = ((north - latitude) / Math.max(Number.EPSILON, north - south)) * grid.rows - 0.5;
  const leftColumn = Math.floor(columnPosition);
  const topRow = Math.floor(rowPosition);
  const columnProgress = columnPosition - leftColumn;
  const rowProgress = rowPosition - topRow;
  const samples = [
    getGridSample(grid, leftColumn, topRow),
    getGridSample(grid, leftColumn + 1, topRow),
    getGridSample(grid, leftColumn, topRow + 1),
    getGridSample(grid, leftColumn + 1, topRow + 1),
  ];

  if (samples.every((value) => value === null)) {
    return null;
  }

  if (samples.some((value) => value === null)) {
    return getGridSample(
      grid,
      clamp(Math.round(columnPosition), 0, grid.columns - 1),
      clamp(Math.round(rowPosition), 0, grid.rows - 1),
    );
  }

  const top = samples[0]! + (samples[1]! - samples[0]!) * columnProgress;
  const bottom = samples[2]! + (samples[3]! - samples[2]!) * columnProgress;

  return top + (bottom - top) * rowProgress;
}

function getGridSample(grid: ScalarFieldGrid, column: number, row: number) {
  if (column < 0 || column >= grid.columns || row < 0 || row >= grid.rows) {
    return null;
  }

  return grid.values[row * grid.columns + column] ?? null;
}

function resolveScalarFieldPointValue<TProperties>(
  point: IndexedMapPoint<TProperties>,
  options: Pick<HeatFieldOptions<TProperties>, "getValue" | "valueMetric">,
) {
  if (options.getValue) {
    return options.getValue(point);
  }

  if (options.valueMetric) {
    return point.metrics[options.valueMetric] ?? Number.NaN;
  }

  return point.metrics.value ?? point.metrics.weight ?? Number.NaN;
}

function resolveScalarFieldBounds<TProperties>(
  valuePoints: readonly ScalarFieldValuePoint<TProperties>[],
  options: Pick<HeatFieldOptions<TProperties>, "domainBounds" | "domainPaddingRatio">,
) {
  if (options.domainBounds) {
    return normalizeBounds(options.domainBounds);
  }

  if (valuePoints.length === 0) {
    return null;
  }

  let west = Number.POSITIVE_INFINITY;
  let south = Number.POSITIVE_INFINITY;
  let east = Number.NEGATIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;

  for (const { point } of valuePoints) {
    west = Math.min(west, point.longitude);
    south = Math.min(south, point.latitude);
    east = Math.max(east, point.longitude);
    north = Math.max(north, point.latitude);
  }

  const longitudeSpan = Math.max(east - west, 1);
  const latitudeSpan = Math.max(north - south, 1);
  const paddingRatio = Math.max(
    0,
    Number.isFinite(options.domainPaddingRatio)
      ? options.domainPaddingRatio!
      : DEFAULT_DOMAIN_PADDING_RATIO,
  );

  return normalizeBounds([
    west - longitudeSpan * paddingRatio,
    south - latitudeSpan * paddingRatio,
    east + longitudeSpan * paddingRatio,
    north + latitudeSpan * paddingRatio,
  ]);
}

function normalizeBounds(
  bounds: [west: number, south: number, east: number, north: number],
): [west: number, south: number, east: number, north: number] | null {
  if (!bounds.every(Number.isFinite)) {
    return null;
  }

  const west = clamp(Math.min(bounds[0], bounds[2]), -180, 180);
  const east = clamp(Math.max(bounds[0], bounds[2]), -180, 180);
  const south = clamp(Math.min(bounds[1], bounds[3]), -90, 90);
  const north = clamp(Math.max(bounds[1], bounds[3]), -90, 90);

  if (west === east || south === north) {
    return null;
  }

  return [west, south, east, north];
}

function resolveScalarFieldDimensions(
  bounds: [west: number, south: number, east: number, north: number],
  options: Pick<HeatFieldOptions, "fieldCellSizeMeters" | "fieldColumns" | "fieldRows">,
) {
  const projection = createLocalEquirectangularProjection(bounds);
  const projectedBounds = getProjectedBounds(bounds, projection);
  const widthMeters = Math.max(1, projectedBounds.east - projectedBounds.west);
  const heightMeters = Math.max(1, projectedBounds.north - projectedBounds.south);
  const aspectRatio = widthMeters / heightMeters;
  const explicitColumns = getPositiveInteger(options.fieldColumns);
  const explicitRows = getPositiveInteger(options.fieldRows);

  if (explicitColumns && explicitRows) {
    return {
      columns: clamp(explicitColumns, 1, MAX_EXPLICIT_FIELD_SIZE),
      rows: clamp(explicitRows, 1, MAX_EXPLICIT_FIELD_SIZE),
    };
  }

  if (Number.isFinite(options.fieldCellSizeMeters) && (options.fieldCellSizeMeters ?? 0) > 0) {
    return {
      columns: clamp(Math.ceil(widthMeters / options.fieldCellSizeMeters!), 1, MAX_EXPLICIT_FIELD_SIZE),
      rows: clamp(Math.ceil(heightMeters / options.fieldCellSizeMeters!), 1, MAX_EXPLICIT_FIELD_SIZE),
    };
  }

  if (explicitColumns) {
    return {
      columns: clamp(explicitColumns, 1, MAX_EXPLICIT_FIELD_SIZE),
      rows: clamp(Math.round(explicitColumns / Math.max(aspectRatio, 0.001)), 1, MAX_EXPLICIT_FIELD_SIZE),
    };
  }

  if (explicitRows) {
    return {
      columns: clamp(Math.round(explicitRows * aspectRatio), 1, MAX_EXPLICIT_FIELD_SIZE),
      rows: clamp(explicitRows, 1, MAX_EXPLICIT_FIELD_SIZE),
    };
  }

  return {
    columns: DEFAULT_FIELD_COLUMNS,
    rows: clamp(Math.round(DEFAULT_FIELD_COLUMNS / Math.max(aspectRatio, 0.001)), 1, DEFAULT_FIELD_COLUMNS),
  };
}

function createLocalEquirectangularProjection(
  bounds: [west: number, south: number, east: number, north: number],
): MetricProjection {
  const centerLatitudeRadians = (((bounds[1] + bounds[3]) / 2) * Math.PI) / 180;
  const longitudeScale = Math.cos(centerLatitudeRadians);

  return {
    centerLatitudeRadians,
    project([longitude, latitude]) {
      return {
        x: EARTH_RADIUS_METERS * ((longitude * Math.PI) / 180) * longitudeScale,
        y: EARTH_RADIUS_METERS * ((latitude * Math.PI) / 180),
      };
    },
  };
}

function getProjectedBounds(
  bounds: [west: number, south: number, east: number, north: number],
  projection: MetricProjection,
) {
  const southWest = projection.project([bounds[0], bounds[1]]);
  const northEast = projection.project([bounds[2], bounds[3]]);

  return {
    east: Math.max(southWest.x, northEast.x),
    north: Math.max(southWest.y, northEast.y),
    south: Math.min(southWest.y, northEast.y),
    west: Math.min(southWest.x, northEast.x),
  };
}

function createMetricSpatialGrid<TProperties>(
  points: readonly ProjectedValuePoint<TProperties>[],
  projectedBounds: { east: number; north: number; south: number; west: number },
  options: Pick<HeatFieldOptions<TProperties>, "interpolationMaxDistanceMeters">,
): SpatialGrid<TProperties> {
  const domainWidth = Math.max(1, projectedBounds.east - projectedBounds.west);
  const domainHeight = Math.max(1, projectedBounds.north - projectedBounds.south);
  const defaultCellSize = Math.max(
    25_000,
    Math.sqrt((domainWidth * domainHeight) / Math.max(1, points.length)),
  );
  const cellSizeMeters =
    Number.isFinite(options.interpolationMaxDistanceMeters) &&
    (options.interpolationMaxDistanceMeters ?? 0) > 0
      ? Math.max(1, options.interpolationMaxDistanceMeters!)
      : defaultCellSize;
  const cells = new Map<string, Array<ProjectedValuePoint<TProperties>>>();
  let minColumn = Number.POSITIVE_INFINITY;
  let minRow = Number.POSITIVE_INFINITY;
  let maxColumn = Number.NEGATIVE_INFINITY;
  let maxRow = Number.NEGATIVE_INFINITY;

  for (const point of points) {
    point.gridColumn = Math.floor(point.x / cellSizeMeters);
    point.gridRow = Math.floor(point.y / cellSizeMeters);
    minColumn = Math.min(minColumn, point.gridColumn);
    maxColumn = Math.max(maxColumn, point.gridColumn);
    minRow = Math.min(minRow, point.gridRow);
    maxRow = Math.max(maxRow, point.gridRow);

    const key = getSpatialGridCellKey(point.gridColumn, point.gridRow);
    const cell = cells.get(key);

    if (cell) {
      cell.push(point);
    } else {
      cells.set(key, [point]);
    }
  }

  return {
    cellSizeMeters,
    cells,
    maxColumn: Number.isFinite(maxColumn) ? maxColumn : 0,
    maxRow: Number.isFinite(maxRow) ? maxRow : 0,
    minColumn: Number.isFinite(minColumn) ? minColumn : 0,
    minRow: Number.isFinite(minRow) ? minRow : 0,
  };
}

function getSpatialGridCandidates<TProperties>(
  target: MetricPoint,
  grid: SpatialGrid<TProperties>,
  options: {
    kNearest: number;
    maxDistanceMeters: number | null;
  },
): Array<DistanceCandidate<TProperties>> {
  if (grid.cells.size === 0) {
    return [];
  }

  const targetColumn = Math.floor(target.x / grid.cellSizeMeters);
  const targetRow = Math.floor(target.y / grid.cellSizeMeters);
  const candidates: Array<DistanceCandidate<TProperties>> = [];
  const maxRing =
    options.maxDistanceMeters !== null
      ? Math.ceil(options.maxDistanceMeters / grid.cellSizeMeters)
      : Math.max(
          Math.abs(targetColumn - grid.minColumn),
          Math.abs(targetColumn - grid.maxColumn),
          Math.abs(targetRow - grid.minRow),
          Math.abs(targetRow - grid.maxRow),
        );

  for (let ring = 0; ring <= maxRing; ring += 1) {
    forEachSpatialGridRingCell(targetColumn, targetRow, ring, (column, row) => {
      const cell = grid.cells.get(getSpatialGridCellKey(column, row));

      if (!cell) {
        return;
      }

      for (const point of cell) {
        const dx = point.x - target.x;
        const dy = point.y - target.y;
        const distanceSquared = dx * dx + dy * dy;

        candidates.push({
          distanceMeters: Math.sqrt(distanceSquared),
          distanceSquared,
          point,
        });
      }
    });

    if (options.maxDistanceMeters !== null) {
      continue;
    }

    if (candidates.length >= options.kNearest) {
      candidates.sort(compareDistanceCandidates);

      const farthestDistanceSquared = candidates[options.kNearest - 1]?.distanceSquared ?? 0;

      if (farthestDistanceSquared <= getDistanceSquaredToSpatialGridRingExit(target, grid, targetColumn, targetRow, ring)) {
        break;
      }
    }
  }

  candidates.sort(compareDistanceCandidates);

  return candidates.slice(0, options.kNearest);
}

function getDistanceSquaredToSpatialGridRingExit<TProperties>(
  target: MetricPoint,
  grid: SpatialGrid<TProperties>,
  targetColumn: number,
  targetRow: number,
  ring: number,
) {
  const minX = (targetColumn - ring) * grid.cellSizeMeters;
  const maxX = (targetColumn + ring + 1) * grid.cellSizeMeters;
  const minY = (targetRow - ring) * grid.cellSizeMeters;
  const maxY = (targetRow + ring + 1) * grid.cellSizeMeters;
  const distanceToExit = Math.min(
    Math.abs(target.x - minX),
    Math.abs(target.x - maxX),
    Math.abs(target.y - minY),
    Math.abs(target.y - maxY),
  );

  return distanceToExit * distanceToExit;
}

function forEachSpatialGridRingCell(
  targetColumn: number,
  targetRow: number,
  ring: number,
  visit: (column: number, row: number) => void,
) {
  if (ring === 0) {
    visit(targetColumn, targetRow);
    return;
  }

  for (let column = targetColumn - ring; column <= targetColumn + ring; column += 1) {
    visit(column, targetRow - ring);
    visit(column, targetRow + ring);
  }

  for (let row = targetRow - ring + 1; row <= targetRow + ring - 1; row += 1) {
    visit(targetColumn - ring, row);
    visit(targetColumn + ring, row);
  }
}

function getSpatialGridCellKey(column: number, row: number) {
  return `${column}:${row}`;
}

function compareDistanceCandidates<TProperties>(
  left: DistanceCandidate<TProperties>,
  right: DistanceCandidate<TProperties>,
) {
  return (
    left.distanceSquared - right.distanceSquared ||
    left.point.index - right.point.index ||
    left.point.point.id.localeCompare(right.point.point.id)
  );
}

function resolveValueDomain<TProperties>(
  valuePoints: readonly ScalarFieldValuePoint<TProperties>[],
  gridValues: ReadonlyArray<number | null>,
  valueDomain?: [min: number, max: number],
): [min: number, max: number] | null {
  if (valueDomain?.every(Number.isFinite)) {
    return valueDomain[0] <= valueDomain[1] ? valueDomain : [valueDomain[1], valueDomain[0]];
  }

  const values = gridValues.some((value) => value !== null)
    ? gridValues.filter((value): value is number => value !== null && Number.isFinite(value))
    : valuePoints.map((entry) => entry.value).filter(Number.isFinite);

  if (values.length === 0) {
    return null;
  }

  return [Math.min(...values), Math.max(...values)];
}

function toIndexedMapPoint<TProperties>(
  point: MapPoint<TProperties>,
  index: number,
): IndexedMapPoint<TProperties> {
  return {
    id: String(point.id ?? index),
    label: point.label ?? "",
    latitude: point.latitude,
    longitude: point.longitude,
    metrics: point.metrics ?? {},
    properties: point.properties ?? ({} as TProperties),
  };
}

function isValidCoordinatePoint<TProperties>(point: IndexedMapPoint<TProperties>) {
  return Number.isFinite(point.latitude) && Number.isFinite(point.longitude);
}

function isValidCoordinate(coordinate: [longitude: number, latitude: number]) {
  return Number.isFinite(coordinate[0]) && Number.isFinite(coordinate[1]);
}

function getPositiveInteger(value: number | undefined) {
  return Number.isFinite(value) && (value ?? 0) > 0 ? Math.floor(value!) : null;
}

function getPositiveFinite(value: number | undefined, fallback: number) {
  return Number.isFinite(value) && (value ?? 0) > 0 ? value! : fallback;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function isDefined<T>(value: T | null): value is T {
  return value !== null;
}
