export type MapRenderCoordinate = [longitude: number, latitude: number];

export type MapRenderFeatureIdentity<TFeature = unknown> = {
  feature: TFeature;
  id: string;
  interactive: boolean;
};

export type MapCircleRenderItem<TFeature = unknown> = MapRenderFeatureIdentity<TFeature> & {
  coordinates: MapRenderCoordinate;
  fillColor: string;
  fillOpacity: number;
  label: string | null;
  radius: number;
  strokeColor: string;
  strokeWidth: number;
};

export type MapLineRenderItem<TFeature = unknown> = MapRenderFeatureIdentity<TFeature> & {
  coordinates: MapRenderCoordinate[];
  strokeColor: string;
  strokeOpacity: number;
  strokeWidth: number;
};

export type MapPolygonRenderItem<TFeature = unknown> = MapRenderFeatureIdentity<TFeature> & {
  fillColor: string;
  fillOpacity: number;
  rings: MapRenderCoordinate[][];
  strokeColor: string;
  strokeOpacity: number;
  strokeWidth: number;
};

export type MapCircleRenderBatch<TFeature = unknown> = {
  items: Array<MapCircleRenderItem<TFeature>>;
  kind: "circles";
};

export type MapLineRenderBatch<TFeature = unknown> = {
  items: Array<MapLineRenderItem<TFeature>>;
  kind: "lines";
};

export type MapPolygonRenderBatch<TFeature = unknown> = {
  items: Array<MapPolygonRenderItem<TFeature>>;
  kind: "polygons";
};

export type MapRenderBatch<TFeature = unknown> =
  | MapCircleRenderBatch<TFeature>
  | MapLineRenderBatch<TFeature>
  | MapPolygonRenderBatch<TFeature>;

/**
 * Private Maps-owned renderer-neutral frame.
 *
 * Batch order is paint order. Geographic coordinates, visual policy, feature
 * identity and interactivity are already resolved before a renderer sees the
 * frame. Canvas2D/WebGPU may project, draw and pick these primitives, but must
 * not derive map-domain truth or invent feature identity.
 */
export type MapRenderFrame<TFeature = unknown> = {
  batches: Array<MapRenderBatch<TFeature>>;
  kind: "map-render-frame";
};

export function createMapRenderFrame<TFeature = unknown>(
  batches: readonly MapRenderBatch<TFeature>[],
): MapRenderFrame<TFeature> {
  return {
    batches: batches.map(cloneBatch),
    kind: "map-render-frame",
  };
}

function cloneBatch<TFeature>(batch: MapRenderBatch<TFeature>): MapRenderBatch<TFeature> {
  switch (batch.kind) {
    case "circles":
      return { kind: batch.kind, items: [...batch.items] };
    case "lines":
      return { kind: batch.kind, items: [...batch.items] };
    case "polygons":
      return { kind: batch.kind, items: [...batch.items] };
  }
}
