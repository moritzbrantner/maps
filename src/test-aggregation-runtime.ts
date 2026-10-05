import type { MapMetricRecord, ViewportAggregationQuery } from "./aggregation";
import type {
  MapsAggregationRuntimeFeature,
  MapsAggregationRuntimeOptions,
  MapsAggregationRuntimePoint,
  MapsAggregationWasmRuntime,
} from "./aggregation-runtime";

type GridCluster = {
  center: [number, number];
  key: string;
  members: MapsAggregationRuntimePoint[];
  zoom: number;
};

/**
 * Test double for the Maps aggregation WASM runtime, for unit tests that run without the
 * compiled Rust module. It groups points within the clustering radius at the queried zoom. It is not a semantic reference: the Rust index owns clustering.
 */
export function createGridAggregationRuntimeForTests(): MapsAggregationWasmRuntime {
  return {
    createIndex(points, options) {
      const clustersById = new Map<number, GridCluster>();
      const clusterIdsByKey = new Map<string, number>();
      const pointLookup = new Map(points.map((point) => [point.id, point]));

      const clusterId = (cluster: GridCluster) => {
        let id = clusterIdsByKey.get(cluster.key);

        if (id === undefined) {
          // Like Supercluster, cluster ids never collide with point indices.
          id = points.length + clusterIdsByKey.size;
          clusterIdsByKey.set(cluster.key, id);
          clustersById.set(id, cluster);
        }

        return id;
      };
      const requireCluster = (id: number) => {
        const cluster = clustersById.get(id);

        if (!cluster) {
          throw new Error(`invalid cluster id ${id}`);
        }

        return cluster;
      };
      const expansionZoom = (cluster: GridCluster) => {
        for (let zoom = cluster.zoom + 1; zoom <= options.maxZoom; zoom += 1) {
          if (groupWithinRadius(cluster.members, zoom, options).length > 1) {
            return zoom;
          }
        }

        return options.maxZoom + 1;
      };

      return {
        dispose() {},
        getClusterExpansionZoom(id) {
          return expansionZoom(requireCluster(id));
        },
        getClusterLeaves(id, limit = 10, offset = 0) {
          return requireCluster(id).members.slice(offset, offset + limit);
        },
        getPointById(pointId) {
          return pointLookup.get(pointId) ?? null;
        },
        getViewportAggregation(query) {
          const zoom = Math.max(options.minZoom, Math.round(query.zoom));
          const groups =
            zoom > options.maxZoom
              ? points.map((point) => [point])
              : groupWithinRadius(points, zoom, options);
          const metricKeys = collectMetricKeys(points);
          const features: MapsAggregationRuntimeFeature[] = [];

          for (const members of groups) {
            const center = centerOf(members);

            if (!containsCoordinate(query.bounds, center)) {
              continue;
            }

            if (members.length === 1) {
              const [point] = members;
              features.push({
                coordinates: [point!.longitude, point!.latitude],
                kind: "point",
                metrics: point!.metrics,
                pointId: point!.id,
              });
              continue;
            }

            const cluster: GridCluster = {
              center,
              key: `${zoom}:${members.map((member) => member.id).join(",")}`,
              members,
              zoom,
            };

            features.push({
              clusterId: clusterId(cluster),
              coordinates: center,
              expansionZoom: expansionZoom(cluster),
              kind: "cluster",
              metrics: sumMetrics(members, metricKeys),
              pointCount: members.length,
              pointCountAbbreviated: String(members.length),
            });
          }

          return {
            features,
            summary: {
              bounds: query.bounds,
              metrics: sumMetrics(
                features.flatMap((feature) =>
                  feature.kind === "cluster"
                    ? requireCluster(feature.clusterId).members
                    : [pointLookup.get(feature.pointId)!],
                ),
                metricKeys,
              ),
              visibleClusterCount: features.filter((feature) => feature.kind === "cluster").length,
              visiblePointCount: features.reduce(
                (count, feature) => count + (feature.kind === "cluster" ? feature.pointCount : 1),
                0,
              ),
              visibleUnclusteredCount: features.filter((feature) => feature.kind === "point").length,
              zoom: query.zoom,
            },
          };
        },
      };
    },
  };
}

// Greedy radius grouping, like Supercluster: each unassigned point claims the unassigned points
// within the clustering radius (in degrees at this zoom), found through a grid of radius-sized cells.
function groupWithinRadius(
  points: readonly MapsAggregationRuntimePoint[],
  zoom: number,
  options: MapsAggregationRuntimeOptions,
) {
  const radius = (360 / 2 ** zoom) * (options.radius / options.extent);
  const cellOf = (value: number) => Math.floor(value / radius);
  const cells = new Map<string, number[]>();

  points.forEach((point, index) => {
    const key = `${cellOf(point.longitude)}:${cellOf(point.latitude)}`;
    const cell = cells.get(key);

    if (cell) {
      cell.push(index);
    } else {
      cells.set(key, [index]);
    }
  });

  const assigned = new Uint8Array(points.length);
  const groups: MapsAggregationRuntimePoint[][] = [];

  points.forEach((point, index) => {
    if (assigned[index]) {
      return;
    }

    const group = [point];
    assigned[index] = 1;

    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        const neighbours =
          cells.get(`${cellOf(point.longitude) + dx}:${cellOf(point.latitude) + dy}`) ?? [];

        for (const neighbourIndex of neighbours) {
          const neighbour = points[neighbourIndex]!;

          if (
            !assigned[neighbourIndex] &&
            Math.hypot(neighbour.longitude - point.longitude, neighbour.latitude - point.latitude) <=
              radius
          ) {
            assigned[neighbourIndex] = 1;
            group.push(neighbour);
          }
        }
      }
    }

    groups.push(group);
  });

  return groups;
}

function centerOf(points: readonly MapsAggregationRuntimePoint[]): [number, number] {
  const longitude = points.reduce((sum, point) => sum + point.longitude, 0) / points.length;
  const latitude = points.reduce((sum, point) => sum + point.latitude, 0) / points.length;

  return [longitude, latitude];
}

function containsCoordinate(
  [west, south, east, north]: ViewportAggregationQuery["bounds"],
  [longitude, latitude]: [number, number],
) {
  const withinLatitude = latitude >= south && latitude <= north;

  return west <= east
    ? withinLatitude && longitude >= west && longitude <= east
    : withinLatitude && (longitude >= west || longitude <= east);
}

function collectMetricKeys(points: readonly MapsAggregationRuntimePoint[]) {
  return [...new Set(points.flatMap((point) => Object.keys(point.metrics)))].sort();
}

function sumMetrics(
  points: readonly MapsAggregationRuntimePoint[],
  metricKeys: readonly string[],
): MapMetricRecord {
  const totals: MapMetricRecord = Object.fromEntries(metricKeys.map((key) => [key, 0]));

  for (const point of points) {
    for (const key of metricKeys) {
      totals[key]! += point.metrics[key] ?? 0;
    }
  }

  return totals;
}
