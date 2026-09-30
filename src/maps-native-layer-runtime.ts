import type { PointLayerProps, PointLayerFeature } from "./point-layer";
import type { FlowLayerProps, FlowLayerFeature } from "./flow-layer";
import { createPointLayerFeatures } from "./point-layer-data";
import { createFlowLayerFeatures, createFlowPathCoordinates } from "./flow-layer-data";
import {
  createCircleVectorRenderFrame,
  type MapRenderCircle,
  type MapRenderLine,
  type MapRenderDirectionMarker,
  type MapVectorRenderFrame,
} from "./map-render-frame";

type Inputs = readonly unknown[];
const same = (a: Inputs | undefined, b: Inputs) =>
  a?.length === b.length && b.every((value, index) => Object.is(value, a[index]));

type PointState<P> = {
  source?: Inputs;
  features: PointLayerFeature<P>[];
  paint?: Inputs;
  frame?: MapVectorRenderFrame<PointLayerFeature<P>>;
};
type FlowStyle = { id: string; color: string; center: [number, number] };
type PreparedFlow<P> = {
  feature: FlowLayerFeature<P>;
  featureId: string;
  center: [number, number];
  endpoints: MapRenderCircle<FlowLayerFeature<P>>[];
  paint(
    opacity: number,
    selected: boolean,
  ): {
    line: MapRenderLine<FlowLayerFeature<P>>;
    marker: MapRenderDirectionMarker<FlowLayerFeature<P>> | null;
  };
};
type FlowState<P> = {
  source?: Inputs;
  features: FlowLayerFeature<P>[];
  pathInputs?: Inputs;
  paths: [number, number][][];
  styleInputs?: Inputs;
  styles: FlowStyle[];
  renderInputs?: Inputs;
  prepared: PreparedFlow<P>[];
};

/** Retained Maps data/style preparation; no React or browser lifecycle dependencies.
 * Callers publish immutable datasets and accessors. Camera and interaction are
 * deliberately absent from source keys. Removed layers release their data.
 */
export function createMapsNativeLayerRuntime<P = Record<string, unknown>>() {
  const points = new Map<string, PointState<P>>();
  const flows = new Map<string, FlowState<P>>();
  return {
    pointFrame(props: PointLayerProps<P>, prefix: string) {
      let state = points.get(prefix);
      const source = [props.points, props.filterPoint];
      if (!state || !same(state.source, source)) {
        state = { source, features: createPointLayerFeatures(props.points, props) };
        points.set(prefix, state);
      }
      const paint = [
        props.getFeatureId,
        props.getPointColor,
        props.getPointRadius,
        props.pointColor,
        props.pointRadius,
      ];
      if (!state.frame || !same(state.paint, paint)) {
        const frame = createCircleVectorRenderFrame(state.features, {
          getCoordinates: (feature) => feature.coordinates,
          getFeatureId: (feature) => props.getFeatureId?.(feature) || feature.point.id,
          getFillColor: (feature) =>
            props.getPointColor?.(feature) ?? props.pointColor ?? "#0f172a",
          getRadius: (feature) => props.getPointRadius?.(feature) ?? props.pointRadius ?? 6,
          primitivePrefix: prefix,
        });
        // Borrow the owned immutable coordinates across paint-only replacements.
        for (const primitive of frame.primitives) {
          if (primitive.kind === "circle") primitive.center = primitive.feature.coordinates;
        }
        state.paint = paint;
        state.frame = frame;
      }
      return state.frame;
    },
    flowFeatures(props: FlowLayerProps<P>, prefix: string) {
      let state = flows.get(prefix);
      const source = [
        props.flows,
        props.getWeight,
        props.weightMetric,
        props.minWidth,
        props.maxWidth,
        props.maxWeight,
      ];
      if (!state || !same(state.source, source)) {
        state = {
          source,
          features: createFlowLayerFeatures(props.flows, props),
          paths: [],
          styles: [],
          prepared: [],
        };
        flows.set(prefix, state);
      }
      const shape = props.flowShape ?? "straight";
      const pathInputs = [
        state.features,
        ...(typeof shape === "string"
          ? [shape, undefined, undefined, undefined]
          : [shape.type ?? "arc", shape.bend, shape.direction, shape.segments]),
      ];
      if (!same(state.pathInputs, pathInputs)) {
        state.paths = state.features.map((feature) => createFlowPathCoordinates(feature, shape));
        state.pathInputs = pathInputs;
      }
      const styleInputs = [state.features, props.getFeatureId, props.getFlowColor, props.flowColor];
      if (!same(state.styleInputs, styleInputs)) {
        state.styles = state.features.map((feature) => ({
          id: props.getFeatureId?.(feature) || feature.flow.id,
          color: props.getFlowColor?.(feature) ?? props.flowColor ?? "#0f766e",
          center: [
            (feature.flow.from[0] + feature.flow.to[0]) / 2,
            (feature.flow.from[1] + feature.flow.to[1]) / 2,
          ],
        }));
        state.styleInputs = styleInputs;
      }
      const renderInputs = [
        state.paths,
        state.styles,
        props.showDirection ?? false,
        props.directionMarker ?? "arrow",
        props.showEndpoints ?? true,
      ];
      if (!same(state.renderInputs, renderInputs)) {
        state.prepared = state.features.map((feature, index) =>
          prepareFlow(feature, state!.paths[index]!, state!.styles[index]!, props, prefix),
        );
        state.renderInputs = renderInputs;
      }
      return state.prepared;
    },
    retain(active: ReadonlySet<string>) {
      for (const key of points.keys()) if (!active.has(key)) points.delete(key);
      for (const key of flows.keys()) if (!active.has(key)) flows.delete(key);
    },
    clear() {
      points.clear();
      flows.clear();
    },
  };
}

function prepareFlow<P>(
  feature: FlowLayerFeature<P>,
  coordinates: [number, number][],
  style: FlowStyle,
  props: FlowLayerProps<P>,
  prefix: string,
): PreparedFlow<P> {
  const id = (kind: string, endpoint?: string) =>
    JSON.stringify(endpoint ? [prefix, style.id, kind, endpoint] : [prefix, style.id, kind]);
  let line: MapRenderLine<FlowLayerFeature<P>> = {
    coordinates,
    feature,
    featureId: style.id,
    interactive: true,
    kind: "line",
    primitiveId: id("line"),
    strokeColor: style.color,
    strokeOpacity: 0.72,
    strokeWidth: feature.width,
  };
  let marker: MapRenderDirectionMarker<FlowLayerFeature<P>> | null =
    props.showDirection && (props.directionMarker ?? "arrow") !== "none" && coordinates.length >= 2
      ? {
          anchor: coordinates[coordinates.length - 1]!,
          previous: coordinates[coordinates.length - 2]!,
          color: style.color,
          feature,
          featureId: style.id,
          interactive: false,
          kind: "direction-marker",
          opacity: 0.72,
          primitiveId: id("direction-marker"),
          size: Math.min(22, Math.max(9, feature.width * 1.35)),
        }
      : null;
  const endpoint = (to: boolean): MapRenderCircle<FlowLayerFeature<P>> => ({
    center: to ? feature.flow.to : feature.flow.from,
    feature,
    featureId: style.id,
    fillColor: style.color,
    fillOpacity: to ? 0.95 : 0.9,
    interactive: false,
    kind: "circle",
    label: null,
    primitiveId: id("endpoint", to ? "to" : "from"),
    radius: Math.max(to ? 4 : 3, feature.width * (to ? 0.75 : 0.55)),
    strokeColor: "#ffffff",
    strokeOpacity: 1,
    strokeWidth: 1.5,
  });
  return {
    feature,
    featureId: style.id,
    center: style.center,
    endpoints: (props.showEndpoints ?? true) ? [endpoint(true), endpoint(false)] : [],
    paint(opacity, selected) {
      const width = selected ? feature.width + 1.5 : feature.width;
      // Never mutate a primitive belonging to an already-presented frame.
      if (line.strokeOpacity !== opacity || line.strokeWidth !== width) {
        line = { ...line, strokeOpacity: opacity, strokeWidth: width };
      }
      if (marker && marker.opacity !== opacity) marker = { ...marker, opacity };
      return { line, marker };
    },
  };
}
