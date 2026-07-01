import type {
  GeoJsonEditMode,
  GeoJsonEditorSelection,
  MapPoint,
  PointMapFeature,
  TemporalGeoJsonGeometryFeatureCollection,
  TemporalGeoJsonInterpolationStrategy,
  TemporalGeoJsonSupportedGeometry,
  TemporalMapTrack,
} from "@moritzbrantner/maps";

export type DemoPointProperties = {
  city: string;
  region: string;
};

export type DemoPointGeoJsonProperties = DemoPointProperties & {
  demand: number;
  label: string;
};

export type DemoFlowGeoJsonProperties = {
  label: string;
  trips: number;
};

export type DemoGeoJsonProperties = {
  groupId?: string;
  kind: string;
  label: string;
  time: number;
  trackId: string;
  visible?: boolean;
};

export type DemoTimelineProperties = {
  corridor: string;
  status: "loading" | "in-transit" | "handoff" | "arrived";
};

export type DemoTimelineStop = {
  city: string;
  demand: number;
  delayMinutes: number;
  latitude: number;
  longitude: number;
  status: DemoTimelineProperties["status"];
  time: number;
};

export type DemoView =
  | "clusters"
  | "points"
  | "heat"
  | "flows"
  | "composed"
  | "temporal"
  | "interpolation"
  | "history"
  | "globe"
  | "geojson"
  | "editor";

export type DemoInterpolationGeometryType = TemporalGeoJsonSupportedGeometry["type"];
export type DemoInterpolationKeyframeId = "start" | "end";
export type DemoInterpolationGeometryPair = Record<
  DemoInterpolationKeyframeId,
  TemporalGeoJsonSupportedGeometry
>;

export type DemoGeometryInterpolationExample = {
  defaultStrategy: TemporalGeoJsonInterpolationStrategy;
  description: string;
  geometryType: DemoInterpolationGeometryType;
  id: string;
  kind?: "geometry";
  label: string;
  pair: DemoInterpolationGeometryPair;
};

export type DemoTopologyInterpolationExample = {
  description: string;
  endCollection: TemporalGeoJsonGeometryFeatureCollection<DemoGeoJsonProperties>;
  geometryType: "Polygon";
  id: string;
  kind: "topology";
  label: string;
  startCollection: TemporalGeoJsonGeometryFeatureCollection<DemoGeoJsonProperties>;
};

export type DemoInterpolationExample =
  | DemoGeometryInterpolationExample
  | DemoTopologyInterpolationExample;

export type DemoInterpolationHandle = {
  label: string;
  path: number[];
};

export type DemoLayerKind = "clusters" | "points" | "bubbles" | "heat" | "flows";

export type DemoLayerConfig = {
  color: string;
  enabled: boolean;
  id: string;
  kind: DemoLayerKind;
  name: string;
};

export type DemoDataset = {
  points: Array<MapPoint<DemoPointProperties>>;
  regions: string[];
};

export type EditablePointContext = {
  onCreatePoint: (coordinates: [longitude: number, latitude: number]) => void;
  onDeletePoint: (feature: PointMapFeature<DemoPointProperties>) => void;
  onMovePoint: (
    feature: PointMapFeature<DemoPointProperties>,
    coordinates: [longitude: number, latitude: number],
  ) => void;
  onSelectPoint: (feature: PointMapFeature<DemoPointProperties> | null) => void;
  points: Array<MapPoint<DemoPointProperties>>;
  selectedPointId: string | null;
};

export type DemoEditorMode = GeoJsonEditMode;
export type DemoEditorSelection = GeoJsonEditorSelection;
export type DemoTemporalTrack = TemporalMapTrack<DemoTimelineProperties>;
