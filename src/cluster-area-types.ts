export type Coordinate = [longitude: number, latitude: number];
export type Bounds = [west: number, south: number, east: number, north: number];

export type ClusterVoronoiInput = {
  clusterId: number | string;
  coordinates: Coordinate;
  boundary?: readonly Coordinate[];
};

export type ClusterVoronoiBoundarySegment = {
  clusterIds: [number | string, number | string | null];
  coordinates: Coordinate[];
};

export type ClusterVoronoiRegion = {
  clusterId: number | string;
  polygons: Coordinate[][][];
};
