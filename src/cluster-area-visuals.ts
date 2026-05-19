import type {
  AggregatedMapCluster,
  AggregatedMapFeature,
  PointAggregationIndex,
} from "./aggregation";
import type { ClusterVoronoiBoundarySegment } from "./cluster-area";

type Coordinate = [longitude: number, latitude: number];

const FOUR_COLOR_PALETTE = ["#e11d48", "#f59e0b", "#10b981", "#2563eb"] as const;
const FALLBACK_COLOR_COUNT = 8;
const DEFAULT_MAX_EXACT_COLORING_NODES = 96;
const DEFAULT_MAX_EXACT_COLORING_STATES = 40_000;

export type ClusterAreaSubject = {
  areaId: string;
  coordinates: Coordinate;
  pointCount: number;
  sampleCoordinates: Coordinate[];
};

export function createClusterAreaSubjects<TProperties>(
  features: readonly AggregatedMapFeature<TProperties>[],
  index: Pick<PointAggregationIndex<TProperties>, "getClusterLeaves">,
): ClusterAreaSubject[] {
  return features.map((feature) =>
    feature.kind === "cluster"
      ? {
          areaId: getClusterAreaId(feature),
          coordinates: feature.coordinates,
          pointCount: feature.pointCount,
          sampleCoordinates: getClusterAreaSample(index, feature),
        }
      : {
          areaId: getClusterAreaId(feature),
          coordinates: feature.coordinates,
          pointCount: 1,
          sampleCoordinates: [feature.coordinates],
        },
  );
}

export function getClusterAreaId<TProperties>(feature: AggregatedMapFeature<TProperties>) {
  return feature.kind === "cluster" ? `cluster:${feature.clusterId}` : `point:${feature.point.id}`;
}

export function assignClusterAreaColors(
  areaIds: readonly string[],
  boundarySegments: readonly Pick<ClusterVoronoiBoundarySegment, "clusterIds">[],
  options: {
    maxExactColoringNodes?: number;
    maxExactColoringStates?: number;
  } = {},
) {
  const adjacency = createAdjacencyGraph(areaIds, boundarySegments);
  const exactColoring =
    areaIds.length <= (options.maxExactColoringNodes ?? DEFAULT_MAX_EXACT_COLORING_NODES)
      ? colorGraphWithLimitedPalette(adjacency, FOUR_COLOR_PALETTE, {
          maxStates: options.maxExactColoringStates ?? DEFAULT_MAX_EXACT_COLORING_STATES,
        })
      : null;

  if (exactColoring) {
    return exactColoring;
  }

  const fallbackPalette = createFallbackPalette(
    Math.max(getGreedyColorCount(adjacency), FALLBACK_COLOR_COUNT),
  );

  return colorGraphGreedily(adjacency, fallbackPalette);
}

export function createBoundaryLineColor(
  clusterIds: readonly [string | number, string | number | null],
  colorsByAreaId: ReadonlyMap<string, string>,
) {
  const colors = clusterIds
    .filter((clusterId): clusterId is string => typeof clusterId === "string")
    .map((clusterId) => colorsByAreaId.get(clusterId))
    .filter((color): color is string => Boolean(color));

  if (colors.length === 0) {
    return "#0f172a";
  }

  if (colors.length === 1) {
    return darkenHexColor(colors[0], 0.36);
  }

  return darkenHexColor(blendHexColors(colors), 0.4);
}

function getClusterAreaSample<TProperties>(
  index: Pick<PointAggregationIndex<TProperties>, "getClusterLeaves">,
  feature: AggregatedMapCluster,
) {
  const maxSamples = Math.min(feature.pointCount, 96);
  const batchSize = Math.min(maxSamples, 24);

  if (batchSize <= 0) {
    return [feature.coordinates];
  }

  const sample: Array<[number, number]> = [];
  const stride = Math.max(Math.floor(feature.pointCount / maxSamples), 1);

  for (
    let offset = 0;
    offset < feature.pointCount && sample.length < maxSamples;
    offset += stride * batchSize
  ) {
    const leaves = index.getClusterLeaves(feature.clusterId, batchSize, offset);

    for (const leaf of leaves) {
      sample.push([leaf.longitude, leaf.latitude]);

      if (sample.length >= maxSamples) {
        break;
      }
    }
  }

  sample.push(feature.coordinates);

  return sample;
}

function createAdjacencyGraph(
  areaIds: readonly string[],
  boundarySegments: readonly Pick<ClusterVoronoiBoundarySegment, "clusterIds">[],
) {
  const adjacency = new Map<string, Set<string>>();

  for (const areaId of areaIds) {
    adjacency.set(areaId, new Set());
  }

  for (const segment of boundarySegments) {
    const [leftId, rightId] = segment.clusterIds;

    if (typeof leftId !== "string" || typeof rightId !== "string" || leftId === rightId) {
      continue;
    }

    adjacency.get(leftId)?.add(rightId);
    adjacency.get(rightId)?.add(leftId);
  }

  return adjacency;
}

function colorGraphWithLimitedPalette(
  adjacency: ReadonlyMap<string, ReadonlySet<string>>,
  palette: readonly string[],
  options: {
    maxStates: number;
  },
) {
  const assignments = new Map<string, string>();
  const saturation = new Map<string, Set<string>>();
  let states = 0;

  for (const node of adjacency.keys()) {
    saturation.set(node, new Set());
  }

  function search(): boolean {
    if (assignments.size === adjacency.size) {
      return true;
    }

    states += 1;

    if (states > options.maxStates) {
      return false;
    }

    const nextNode = selectMostConstrainedNode(adjacency, assignments, saturation);

    if (!nextNode) {
      return true;
    }

    const usedColors = new Set(
      [...(adjacency.get(nextNode) ?? [])]
        .map((neighbor) => assignments.get(neighbor))
        .filter((color): color is string => Boolean(color)),
    );

    for (const color of palette) {
      if (usedColors.has(color)) {
        continue;
      }

      assignments.set(nextNode, color);
      const updatedNeighbors: string[] = [];

      for (const neighbor of adjacency.get(nextNode) ?? []) {
        if (assignments.has(neighbor)) {
          continue;
        }

        const neighborSaturation = saturation.get(neighbor);

        if (neighborSaturation && !neighborSaturation.has(color)) {
          neighborSaturation.add(color);
          updatedNeighbors.push(neighbor);
        }
      }

      if (search()) {
        return true;
      }

      assignments.delete(nextNode);

      for (const neighbor of updatedNeighbors) {
        saturation.get(neighbor)?.delete(color);
      }
    }

    return false;
  }

  return search() ? assignments : null;
}

function colorGraphGreedily(
  adjacency: ReadonlyMap<string, ReadonlySet<string>>,
  palette: readonly string[],
) {
  const assignments = new Map<string, string>();
  const orderedNodes = [...adjacency.keys()].sort((left, right) => {
    const degreeDifference = (adjacency.get(right)?.size ?? 0) - (adjacency.get(left)?.size ?? 0);

    return degreeDifference !== 0 ? degreeDifference : left.localeCompare(right);
  });

  for (const node of orderedNodes) {
    const usedColors = new Set(
      [...(adjacency.get(node) ?? [])]
        .map((neighbor) => assignments.get(neighbor))
        .filter((color): color is string => Boolean(color)),
    );
    const color = palette.find((candidate) => !usedColors.has(candidate));

    assignments.set(node, color ?? palette[palette.length - 1]!);
  }

  return assignments;
}

function getGreedyColorCount(adjacency: ReadonlyMap<string, ReadonlySet<string>>) {
  let maxColorIndex = 0;
  const assignments = new Map<string, number>();
  const orderedNodes = [...adjacency.keys()].sort((left, right) => {
    const degreeDifference = (adjacency.get(right)?.size ?? 0) - (adjacency.get(left)?.size ?? 0);

    return degreeDifference !== 0 ? degreeDifference : left.localeCompare(right);
  });

  for (const node of orderedNodes) {
    const usedIndexes = new Set(
      [...(adjacency.get(node) ?? [])]
        .map((neighbor) => assignments.get(neighbor))
        .filter((index): index is number => typeof index === "number"),
    );
    let colorIndex = 0;

    while (usedIndexes.has(colorIndex)) {
      colorIndex += 1;
    }

    assignments.set(node, colorIndex);
    maxColorIndex = Math.max(maxColorIndex, colorIndex);
  }

  return maxColorIndex + 1;
}

function selectMostConstrainedNode(
  adjacency: ReadonlyMap<string, ReadonlySet<string>>,
  assignments: ReadonlyMap<string, string>,
  saturation: ReadonlyMap<string, ReadonlySet<string>>,
) {
  let bestNode: string | null = null;
  let bestSaturation = -1;
  let bestDegree = -1;

  for (const node of adjacency.keys()) {
    if (assignments.has(node)) {
      continue;
    }

    const nodeSaturation = saturation.get(node)?.size ?? 0;
    const nodeDegree = adjacency.get(node)?.size ?? 0;

    if (
      nodeSaturation > bestSaturation ||
      (nodeSaturation === bestSaturation && nodeDegree > bestDegree) ||
      (nodeSaturation === bestSaturation &&
        nodeDegree === bestDegree &&
        (bestNode === null || node.localeCompare(bestNode) < 0))
    ) {
      bestNode = node;
      bestSaturation = nodeSaturation;
      bestDegree = nodeDegree;
    }
  }

  return bestNode;
}

function createFallbackPalette(size: number) {
  return Array.from({ length: size }, (_, index) => {
    const hue = (index * 137.508) % 360;
    return hslToHex(hue, 72, 54);
  });
}

function darkenHexColor(color: string, amount: number) {
  const [red, green, blue] = hexToRgb(color);

  return rgbToHex(red * (1 - amount), green * (1 - amount), blue * (1 - amount));
}

function blendHexColors(colors: readonly string[]) {
  const totals = colors.reduce<[number, number, number]>(
    (accumulator, color) => {
      const [red, green, blue] = hexToRgb(color);

      return [accumulator[0] + red, accumulator[1] + green, accumulator[2] + blue];
    },
    [0, 0, 0],
  );

  return rgbToHex(totals[0] / colors.length, totals[1] / colors.length, totals[2] / colors.length);
}

function hslToHex(hue: number, saturation: number, lightness: number) {
  const normalizedSaturation = saturation / 100;
  const normalizedLightness = lightness / 100;
  const chroma = (1 - Math.abs(2 * normalizedLightness - 1)) * normalizedSaturation;
  const huePrime = hue / 60;
  const secondary = chroma * (1 - Math.abs((huePrime % 2) - 1));
  const match = normalizedLightness - chroma / 2;

  const [red, green, blue] =
    huePrime < 1
      ? [chroma, secondary, 0]
      : huePrime < 2
        ? [secondary, chroma, 0]
        : huePrime < 3
          ? [0, chroma, secondary]
          : huePrime < 4
            ? [0, secondary, chroma]
            : huePrime < 5
              ? [secondary, 0, chroma]
              : [chroma, 0, secondary];

  return rgbToHex((red + match) * 255, (green + match) * 255, (blue + match) * 255);
}

function hexToRgb(color: string) {
  const normalized = color.replace("#", "");

  if (normalized.length !== 6) {
    return [15, 23, 42] as const;
  }

  return [
    Number.parseInt(normalized.slice(0, 2), 16),
    Number.parseInt(normalized.slice(2, 4), 16),
    Number.parseInt(normalized.slice(4, 6), 16),
  ] as const;
}

function rgbToHex(red: number, green: number, blue: number) {
  return `#${[red, green, blue]
    .map((channel) =>
      Math.max(0, Math.min(255, Math.round(channel)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}
