import type {
  MapFlow,
  IndexedMapFlow,
  FlowLayerFeature,
  FlowLayerWeightAccessor,
  FlowShape,
} from "./flow-layer";

export function createFlowLayerFeatures<TProperties = Record<string, unknown>>(
  flows: readonly MapFlow<TProperties>[],
  options: {
    getWeight?: FlowLayerWeightAccessor<TProperties>;
    maxWeight?: number;
    maxWidth?: number;
    minWidth?: number;
    weightMetric?: string;
  } = {},
): Array<FlowLayerFeature<TProperties>> {
  const indexedFlows = flows.map(toIndexedFlow).filter(isValidFlow);
  const weightedFlows = indexedFlows
    .map((flow) => ({
      flow,
      rawValue: resolveFlowWeight(flow, options),
    }))
    .filter((entry) => entry.rawValue > 0);
  const effectiveMaxWeight =
    Number.isFinite(options.maxWeight) && (options.maxWeight ?? 0) > 0
      ? options.maxWeight!
      : Math.max(1, ...weightedFlows.map((entry) => entry.rawValue));
  const minWidth = Math.max(0, options.minWidth ?? 1.5);
  const maxWidth = Math.max(minWidth, options.maxWidth ?? 12);

  return weightedFlows.map(({ flow, rawValue }) => {
    const value = clamp(rawValue / effectiveMaxWeight, 0, 1);

    return {
      flow,
      rawValue,
      value,
      width: minWidth + Math.sqrt(value) * (maxWidth - minWidth),
    };
  });
}

export function createFlowPathCoordinates<TProperties>(
  feature: FlowLayerFeature<TProperties>,
  shape: FlowShape = "straight",
): Array<[longitude: number, latitude: number]> {
  const from = feature.flow.from;
  const to = feature.flow.to;
  const options = resolveFlowShapeOptions(feature, shape);

  if (options.type === "straight") {
    return [from, to];
  }

  const deltaLongitude = to[0] - from[0];
  const deltaLatitude = to[1] - from[1];
  const distance = Math.hypot(deltaLongitude, deltaLatitude);

  if (distance <= 0) {
    return [from, to];
  }

  const offset = clamp(distance * options.bend, 0, distance * 0.85);
  const direction = options.direction;
  const segments = options.segments;
  const perpendicular: [number, number] = [
    (-deltaLatitude / distance) * offset * direction,
    (deltaLongitude / distance) * offset * direction,
  ];
  const coordinates: Array<[longitude: number, latitude: number]> = [];

  if (options.type === "s-curve") {
    const controlA: [number, number] = [
      from[0] + deltaLongitude * 0.32 + perpendicular[0],
      from[1] + deltaLatitude * 0.32 + perpendicular[1],
    ];
    const controlB: [number, number] = [
      from[0] + deltaLongitude * 0.68 - perpendicular[0],
      from[1] + deltaLatitude * 0.68 - perpendicular[1],
    ];

    for (let index = 0; index < segments; index += 1) {
      const t = index / (segments - 1);
      const inverse = 1 - t;

      coordinates.push([
        inverse ** 3 * from[0] +
          3 * inverse * inverse * t * controlA[0] +
          3 * inverse * t * t * controlB[0] +
          t ** 3 * to[0],
        inverse ** 3 * from[1] +
          3 * inverse * inverse * t * controlA[1] +
          3 * inverse * t * t * controlB[1] +
          t ** 3 * to[1],
      ]);
    }

    return coordinates;
  }

  const control: [number, number] = [
    (from[0] + to[0]) / 2 + perpendicular[0],
    (from[1] + to[1]) / 2 + perpendicular[1],
  ];

  for (let index = 0; index < segments; index += 1) {
    const t = index / (segments - 1);
    const inverse = 1 - t;

    coordinates.push([
      inverse * inverse * from[0] + 2 * inverse * t * control[0] + t * t * to[0],
      inverse * inverse * from[1] + 2 * inverse * t * control[1] + t * t * to[1],
    ]);
  }

  return coordinates;
}

function resolveFlowShapeOptions<TProperties>(
  feature: FlowLayerFeature<TProperties>,
  shape: FlowShape,
) {
  const type = typeof shape === "string" ? shape : (shape.type ?? "arc");
  const rawBend = typeof shape === "string" ? undefined : shape.bend;
  const rawSegments = typeof shape === "string" ? undefined : shape.segments;
  const rawDirection = typeof shape === "string" ? "auto" : (shape.direction ?? "auto");
  const direction =
    rawDirection === "clockwise"
      ? 1
      : rawDirection === "counterclockwise"
        ? -1
        : getFlowArcDirection(feature.flow.id);

  return {
    bend: clamp(rawBend ?? (type === "s-curve" ? 0.28 : 0.22), 0, 1),
    direction,
    segments: Math.max(2, Math.min(96, Math.round(rawSegments ?? 24))),
    type,
  };
}

function getFlowArcDirection(id: string) {
  let hash = 0;

  for (let index = 0; index < id.length; index += 1) {
    hash = (hash * 31 + id.charCodeAt(index)) | 0;
  }

  return hash % 2 === 0 ? 1 : -1;
}

function resolveFlowWeight<TProperties>(
  flow: IndexedMapFlow<TProperties>,
  options: {
    getWeight?: FlowLayerWeightAccessor<TProperties>;
    weightMetric?: string;
  },
) {
  const rawWeight = options.getWeight
    ? options.getWeight(flow)
    : options.weightMetric
      ? (flow.metrics[options.weightMetric] ?? 0)
      : (flow.metrics.weight ?? 1);

  return Number.isFinite(rawWeight) ? Math.max(0, rawWeight) : 0;
}

function toIndexedFlow<TProperties>(
  flow: MapFlow<TProperties>,
  index: number,
): IndexedMapFlow<TProperties> {
  return {
    from: flow.from,
    id: String(flow.id ?? index),
    label: flow.label ?? "",
    metrics: flow.metrics ?? {},
    properties: flow.properties ?? ({} as TProperties),
    to: flow.to,
  };
}

function isValidFlow<TProperties>(flow: IndexedMapFlow<TProperties>) {
  return (
    Number.isFinite(flow.from[0]) &&
    Number.isFinite(flow.from[1]) &&
    Number.isFinite(flow.to[0]) &&
    Number.isFinite(flow.to[1])
  );
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}
