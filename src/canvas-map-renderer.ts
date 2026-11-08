import type {
  MapRenderCircle,
  MapRenderDirectionMarker,
  MapRenderLine,
  MapRenderPolygon,
  MapVectorRenderFrame,
  MapVectorRenderPrimitive,
} from "./map-render-frame";
import type {
  MapScreenCircle,
  MapScreenDirectionMarker,
  MapScreenInteractionState,
  MapScreenLine,
  MapScreenPoint as SharedMapScreenPoint,
  MapScreenPolygon,
  MapScreenProject,
  MapScreenRenderFrame,
  MapScreenRenderPrimitive,
} from "./map-screen-render-frame";

export type MapScreenPoint = SharedMapScreenPoint;
export type MapRenderProject = MapScreenProject;
export type CanvasCircleScenePrimitive<TFeature = unknown> = MapScreenCircle<TFeature>;
export type CanvasDirectionMarkerScenePrimitive<TFeature = unknown> =
  MapScreenDirectionMarker<TFeature>;
export type CanvasLineScenePrimitive<TFeature = unknown> = MapScreenLine<TFeature>;
export type CanvasPolygonScenePrimitive<TFeature = unknown> = MapScreenPolygon<TFeature>;
export type CanvasMapScenePrimitive<TFeature = unknown> = MapScreenRenderPrimitive<TFeature>;
export type CanvasMapScene<TFeature = unknown> = MapScreenRenderFrame<TFeature>;

export type CanvasMapDrawOptions = MapScreenInteractionState & {
  hoveredFeatureId?: string | null;
  /** Style images and camera for `fill-pattern` and `line-pattern`; absent draws neither. */
  patterns?: CanvasMapPatterns;
  selectedFeatureId?: string | null;
};

/** One style image as Canvas draws it (`sdf` images are left out, needing a tinted atlas). */
export type CanvasMapPatternImage = {
  height: number;
  pixelRatio: number;
  sdf: boolean;
  source: CanvasImageSource;
  width: number;
};

/** The style's sprite images and what patterns are placed with (#350). */
export type CanvasMapPatterns = {
  images: (id: string) => CanvasMapPatternImage | null;
  project: MapRenderProject;
  zoom: number;
};

export function createCanvasMapScene<TFeature = unknown>(
  frame: MapVectorRenderFrame<TFeature>,
  project: MapRenderProject,
  size: { height: number; width: number },
): CanvasMapScene<TFeature> {
  const primitives: Array<CanvasMapScenePrimitive<TFeature>> = [];
  for (const primitive of frame.primitives) {
    const projected = projectPrimitive(primitive, project);
    if (projected) primitives.push(projected);
  }
  return {
    height: Math.max(0, size.height),
    primitives,
    width: Math.max(0, size.width),
  };
}

/**
 * Internal projector for immutable Maps-owned render primitives. A new camera
 * callback, explicit camera revision or viewport size invalidates screen coordinates,
 * not source geometry. Camera presentation does not need a React render.
 * Weak keys do not retain primitives belonging to removed/replaced layers.
 */
export function createCanvasMapSceneProjector<TFeature = unknown>() {
  let previousProject: MapRenderProject | undefined;
  let previousWidth: number | undefined;
  let previousHeight: number | undefined;
  let previousRevision: number | undefined;
  let coordinates = new WeakMap<readonly [number, number][], MapScreenPoint[] | null>();
  let points = new WeakMap<[number, number], MapScreenPoint | null>();
  const projectCoordinate: MapRenderProject = (coordinate) => {
    if (points.has(coordinate)) return points.get(coordinate)!;
    const point = projectPoint(previousProject!, coordinate);
    points.set(coordinate, point);
    return point;
  };
  let projected = new WeakMap<
    MapVectorRenderPrimitive<TFeature>,
    CanvasMapScenePrimitive<TFeature> | null
  >();

  return (
    frame: MapVectorRenderFrame<TFeature>,
    project: MapRenderProject,
    size: { height: number; width: number },
    projectionRevision = 0,
  ): CanvasMapScene<TFeature> => {
    if (
      previousRevision !== projectionRevision ||
      previousProject !== project ||
      previousWidth !== size.width ||
      previousHeight !== size.height
    ) {
      projected = new WeakMap();
      coordinates = new WeakMap();
      points = new WeakMap();
      previousRevision = projectionRevision;
      previousProject = project;
      previousWidth = size.width;
      previousHeight = size.height;
    }
    preprojectPackedCoordinates(frame.primitives, project, points, coordinates);

    const primitives: Array<CanvasMapScenePrimitive<TFeature>> = [];
    for (const primitive of frame.primitives) {
      let result: CanvasMapScenePrimitive<TFeature> | null;
      if (projected.has(primitive)) {
        result = projected.get(primitive) ?? null;
      } else {
        result = projectPrimitive(primitive, projectCoordinate, coordinates);
        projected.set(primitive, result);
      }
      if (result) primitives.push(result);
    }
    return {
      height: Math.max(0, size.height),
      primitives,
      width: Math.max(0, size.width),
    };
  };
}

export function hitTestCanvasMapScene<TFeature = unknown>(
  scene: CanvasMapScene<TFeature>,
  point: MapScreenPoint,
): CanvasMapScenePrimitive<TFeature> | null {
  for (let index = scene.primitives.length - 1; index >= 0; index -= 1) {
    const candidate = scene.primitives[index]!;
    if (!candidate.renderPrimitive.interactive) continue;

    if (hitPrimitive(candidate, point)) {
      return candidate;
    }
  }

  return null;
}

/** Every interactive primitive under the point, topmost first (MapLibre `queryRenderedFeatures`). */
export function hitTestCanvasMapSceneAll<TFeature = unknown>(
  scene: CanvasMapScene<TFeature>,
  point: MapScreenPoint,
): CanvasMapScenePrimitive<TFeature>[] {
  const hits: CanvasMapScenePrimitive<TFeature>[] = [];
  for (let index = scene.primitives.length - 1; index >= 0; index -= 1) {
    const candidate = scene.primitives[index]!;
    if (candidate.renderPrimitive.interactive && hitPrimitive(candidate, point)) {
      hits.push(candidate);
    }
  }
  return hits;
}

export function drawCanvasMapScene<TFeature = unknown>(
  context: CanvasRenderingContext2D,
  scene: CanvasMapScene<TFeature>,
  options: CanvasMapDrawOptions = {},
) {
  context.clearRect(0, 0, scene.width, scene.height);

  for (const primitive of scene.primitives) {
    drawCanvasMapPrimitive(context, primitive, options);
  }
}

export function drawCanvasMapPrimitive<TFeature = unknown>(
  context: CanvasRenderingContext2D,
  primitive: CanvasMapScenePrimitive<TFeature>,
  options: CanvasMapDrawOptions = {},
) {
  drawPrimitive(context, primitive, options);
}

/**
 * The MapLibre runtime's point and cluster label: a `.mb-maps__cluster-count` marker
 * (bold 12px, 16px line box, grid-centered) inside `.maplibregl-map`, whose font it inherits.
 */
export const MARKER_LABEL_FONT = 'bold 12px "Helvetica Neue", Arial, Helvetica, sans-serif';
const MARKER_LABEL_LINE_HEIGHT = 16;
/** The marker's `iconSize`, centered on the point (`iconAnchor` is half of it). */
const MARKER_LABEL_BOX = 36;

/** CSS layout snaps offsets down to 1/64 px (Blink's LayoutUnit). */
function layoutUnit(value: number) {
  return Math.floor(value * 64) / 64;
}

/**
 * Draws a label exactly where MapLibre lays out the HTML marker text (#310): the marker snaps
 * to whole pixels (`Marker` without subpixel positioning), CSS centers the line box, so the
 * baseline sits at the box top plus the half-leading plus the font ascent, and a label wider
 * than the marker grows its grid track from the marker's left edge.
 */
export function drawMarkerLabel(
  context: CanvasRenderingContext2D,
  label: string,
  x: number,
  y: number,
) {
  context.globalAlpha = 1;
  context.fillStyle = "#ffffff";
  context.font = MARKER_LABEL_FONT;
  context.textAlign = "left";
  context.textBaseline = "alphabetic";
  const metrics = context.measureText(label);
  const ascent = Math.round(metrics.fontBoundingBoxAscent);
  const descent = Math.round(metrics.fontBoundingBoxDescent);
  const top = Math.round(y) - MARKER_LABEL_LINE_HEIGHT / 2;
  const baseline = top + (MARKER_LABEL_LINE_HEIGHT - ascent - descent) / 2 + ascent;
  const inset = layoutUnit(Math.max(0, (MARKER_LABEL_BOX - metrics.width) / 2));
  context.fillText(label, Math.round(x) - MARKER_LABEL_BOX / 2 + inset, baseline);
}

export function drawCanvasMapLabels<TFeature = unknown>(
  context: CanvasRenderingContext2D,
  scene: CanvasMapScene<TFeature>,
) {
  context.clearRect(0, 0, scene.width, scene.height);
  for (const primitive of scene.primitives) {
    if (primitive.kind !== "circle") continue;
    const label = (primitive.renderPrimitive as MapRenderCircle<TFeature>).label;
    if (label) drawMarkerLabel(context, label, primitive.x, primitive.y);
  }
}

function preprojectPackedCoordinates<TFeature>(
  primitives: readonly MapVectorRenderPrimitive<TFeature>[],
  project: MapRenderProject,
  points: WeakMap<[number, number], MapScreenPoint | null>,
  coordinateArrays: WeakMap<readonly [number, number][], MapScreenPoint[] | null>,
) {
  const projectPacked = project.projectPacked;
  if (!projectPacked) return;

  const pending: Array<[number, number]> = [];
  const seen = new Set<[number, number]>();
  const queuePoint = (coordinate: [number, number]) => {
    if (points.has(coordinate) || seen.has(coordinate)) return;
    seen.add(coordinate);
    pending.push(coordinate);
  };
  const queueCoordinates = (values: readonly [number, number][]) => {
    if (coordinateArrays.has(values)) return;
    for (const coordinate of values) queuePoint(coordinate);
  };

  for (const primitive of primitives) {
    switch (primitive.kind) {
      case "circle":
        queuePoint(primitive.center);
        break;
      case "direction-marker":
        queuePoint(primitive.anchor);
        queuePoint(primitive.previous);
        break;
      case "line":
        queueCoordinates(primitive.coordinates);
        break;
      case "polygon":
        for (const ring of primitive.rings) queueCoordinates(ring);
        break;
    }
  }
  if (pending.length === 0) return;

  const packed = new Float64Array(pending.length * 2);
  for (let index = 0; index < pending.length; index += 1) {
    const coordinate = pending[index]!;
    packed[index * 2] = coordinate[0];
    packed[index * 2 + 1] = coordinate[1];
  }

  let result: Float64Array | null;
  try {
    result = projectPacked(packed);
  } catch {
    // Preserve the scalar path as a correctness fallback if an older/custom
    // projector exposes a broken packed implementation.
    return;
  }
  if (!result || result.length !== packed.length) return;

  for (let index = 0; index < pending.length; index += 1) {
    const x = result[index * 2]!;
    const y = result[index * 2 + 1]!;
    points.set(pending[index]!, Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null);
  }
}

function projectPrimitive<TFeature>(
  primitive: MapVectorRenderPrimitive<TFeature>,
  project: MapRenderProject,
  cache?: WeakMap<readonly [number, number][], MapScreenPoint[] | null>,
): CanvasMapScenePrimitive<TFeature> | null {
  switch (primitive.kind) {
    case "circle": {
      const center = projectPoint(project, primitive.center);
      if (!isFinitePoint(center)) return null;
      return { kind: "circle", renderPrimitive: primitive, x: center.x, y: center.y };
    }
    case "direction-marker": {
      const anchor = projectPoint(project, primitive.anchor);
      const previous = projectPoint(project, primitive.previous);
      if (!isFinitePoint(anchor) || !isFinitePoint(previous)) return null;
      return {
        angle: Math.atan2(anchor.y - previous.y, anchor.x - previous.x),
        kind: "direction-marker",
        renderPrimitive: primitive,
        x: anchor.x,
        y: anchor.y,
      };
    }
    case "line": {
      // A pitched camera's near plane can hide some vertices of a long line (#350): the
      // visible part draws and picks, as the GPU clips MapLibre's tile geometry.
      const points =
        projectCoordinates(primitive.coordinates, project, cache) ??
        projectVisibleLineRun(primitive.coordinates, project);
      if (!points || points.length < 2) return null;
      return { kind: "line", points, renderPrimitive: primitive };
    }
    case "polygon": {
      const rings = primitive.rings.map((ring) => projectCoordinates(ring, project, cache));
      if (rings.some((ring) => !ring || ring.length < 3)) return null;
      return {
        kind: "polygon",
        renderPrimitive: primitive,
        rings: rings as MapScreenPoint[][],
      };
    }
  }
}

function projectCoordinates(
  coordinates: readonly [number, number][],
  project: MapRenderProject,
  cache?: WeakMap<readonly [number, number][], MapScreenPoint[] | null>,
): MapScreenPoint[] | null {
  if (cache?.has(coordinates)) return cache.get(coordinates)!;
  const points: MapScreenPoint[] = [];
  for (const coordinate of coordinates) {
    const point = projectPoint(project, coordinate);
    if (!isFinitePoint(point)) {
      cache?.set(coordinates, null);
      return null;
    }
    points.push(point);
  }
  cache?.set(coordinates, points);
  return points;
}

/**
 * The longest run of projectable vertices of a line, with each end extended along its
 * segment to the last projectable point towards the hidden neighbour. A line that cannot
 * be projected at all is `null`.
 */
function projectVisibleLineRun(
  coordinates: readonly [number, number][],
  project: MapRenderProject,
): MapScreenPoint[] | null {
  let best: MapScreenPoint[] | null = null;
  let run: MapScreenPoint[] = [];
  const finish = () => {
    if (run.length > (best?.length ?? 0)) best = run;
    run = [];
  };
  for (let index = 0; index < coordinates.length; index += 1) {
    const coordinate = coordinates[index]!;
    const point = projectPoint(project, coordinate);
    if (isFinitePoint(point)) {
      const previous = coordinates[index - 1];
      if (run.length === 0 && previous) {
        const edge = projectLastVisible(coordinate, previous, project);
        if (edge) run.push(edge);
      }
      run.push(point);
    } else if (run.length > 0) {
      const edge = projectLastVisible(coordinates[index - 1]!, coordinate, project);
      if (edge) run.push(edge);
      finish();
    }
  }
  finish();
  return best;
}

/** Bisects `visible -> hidden` for the projectable point nearest the hidden end. */
function projectLastVisible(
  visible: readonly [number, number],
  hidden: readonly [number, number],
  project: MapRenderProject,
): MapScreenPoint | null {
  let low = 0;
  let high = 1;
  let result: MapScreenPoint | null = null;
  for (let iteration = 0; iteration < 12; iteration += 1) {
    const t = (low + high) / 2;
    const point = projectPoint(project, [
      visible[0] + (hidden[0] - visible[0]) * t,
      visible[1] + (hidden[1] - visible[1]) * t,
    ]);
    if (isFinitePoint(point)) {
      low = t;
      result = point;
    } else {
      high = t;
    }
  }
  return result;
}

function projectPoint(
  project: MapRenderProject,
  coordinate: [longitude: number, latitude: number],
): MapScreenPoint | null {
  try {
    return project(coordinate);
  } catch {
    return null;
  }
}

function isFinitePoint(point: MapScreenPoint | null): point is MapScreenPoint {
  return point !== null && Number.isFinite(point.x) && Number.isFinite(point.y);
}

function drawPrimitive<TFeature>(
  context: CanvasRenderingContext2D,
  scenePrimitive: CanvasMapScenePrimitive<TFeature>,
  options: CanvasMapDrawOptions,
) {
  const primitive = scenePrimitive.renderPrimitive;
  const selected = options.selectedPrimitiveIds
    ? options.selectedPrimitiveIds.has(primitive.primitiveId)
    : options.selectedFeatureId === primitive.featureId;
  const hovered = options.hoveredPrimitiveIds
    ? options.hoveredPrimitiveIds.has(primitive.primitiveId)
    : options.hoveredFeatureId === primitive.featureId;

  switch (scenePrimitive.kind) {
    case "circle":
      drawCircle(
        context,
        scenePrimitive,
        primitive as MapRenderCircle<TFeature>,
        selected,
        hovered,
      );
      return;
    case "direction-marker":
      drawDirectionMarker(context, scenePrimitive, primitive as MapRenderDirectionMarker<TFeature>);
      return;
    case "line":
      drawLine(
        context,
        scenePrimitive,
        primitive as MapRenderLine<TFeature>,
        selected,
        hovered,
        options.patterns,
      );
      return;
    case "polygon":
      drawPolygon(
        context,
        scenePrimitive,
        primitive as MapRenderPolygon<TFeature>,
        selected,
        hovered,
        options.patterns,
      );
  }
}

function drawDirectionMarker<TFeature>(
  context: CanvasRenderingContext2D,
  scene: CanvasDirectionMarkerScenePrimitive<TFeature>,
  primitive: MapRenderDirectionMarker<TFeature>,
) {
  const size = Math.max(0, primitive.size);
  context.save();
  context.translate(scene.x, scene.y);
  context.rotate(scene.angle);
  context.beginPath();
  context.moveTo(size * 0.38, 0);
  context.lineTo(size * -0.62, size * -0.42);
  context.lineTo(size * -0.62, size * 0.42);
  context.closePath();
  context.fillStyle = primitive.color;
  context.globalAlpha = primitive.opacity;
  context.fill();
  context.restore();
}

function drawCircle<TFeature>(
  context: CanvasRenderingContext2D,
  scene: CanvasCircleScenePrimitive<TFeature>,
  primitive: MapRenderCircle<TFeature>,
  selected: boolean,
  hovered: boolean,
) {
  context.beginPath();
  context.arc(scene.x, scene.y, primitive.radius, 0, Math.PI * 2);
  context.fillStyle = primitive.fillColor;
  context.globalAlpha = primitive.fillOpacity;
  context.fill();
  // MapLibre circles (#309): the stroke lies outside the radius.
  const strokeWidth = interactionStrokeWidth(primitive.strokeWidth, selected, hovered);
  if (strokeWidth > 0) {
    context.beginPath();
    context.arc(scene.x, scene.y, primitive.radius + strokeWidth / 2, 0, Math.PI * 2);
    context.globalAlpha = primitive.strokeOpacity;
    context.lineWidth = strokeWidth;
    context.strokeStyle = primitive.strokeColor;
    context.stroke();
  }
  context.globalAlpha = 1;

  if (primitive.label) drawMarkerLabel(context, primitive.label, scene.x, scene.y);
}

function drawLine<TFeature>(
  context: CanvasRenderingContext2D,
  scene: CanvasLineScenePrimitive<TFeature>,
  primitive: MapRenderLine<TFeature>,
  selected: boolean,
  hovered: boolean,
  patterns: CanvasMapPatterns | undefined,
) {
  if (primitive.linePattern) {
    // A missing image (or sprite) leaves the line out, as MapLibre does until it loads.
    const image = patterns?.images(primitive.linePattern);
    if (patterns && image && !image.sdf) {
      drawPatternedLine(
        context,
        scene,
        image,
        patterns.zoom,
        interactionStrokeWidth(primitive.strokeWidth, selected, hovered),
        primitive.strokeOpacity,
      );
    }
    return;
  }
  traceLine(context, scene.points, false);
  const width = interactionStrokeWidth(primitive.strokeWidth, selected, hovered);
  context.globalAlpha = primitive.strokeOpacity;
  context.lineCap = primitive.lineCap ?? "round";
  context.lineJoin = primitive.lineJoin ?? "round";
  context.miterLimit = primitive.lineMiterLimit ?? 2;
  context.lineWidth = width;
  context.strokeStyle = primitive.strokeColor;
  // MapLibre dash lengths are in line widths.
  const dashes = primitive.lineDasharray ?? [];
  if (dashes.length > 0) context.setLineDash(dashes.map((dash) => dash * width));
  context.stroke();
  if (dashes.length > 0) context.setLineDash([]);
  context.globalAlpha = 1;
}

function drawPolygon<TFeature>(
  context: CanvasRenderingContext2D,
  scene: CanvasPolygonScenePrimitive<TFeature>,
  primitive: MapRenderPolygon<TFeature>,
  selected: boolean,
  hovered: boolean,
  patterns: CanvasMapPatterns | undefined,
) {
  context.beginPath();
  for (const ring of scene.rings) {
    traceLine(context, ring, true, false);
  }
  // A missing image (or sprite) leaves the fill out, as MapLibre does until it loads.
  const fillStyle = primitive.fillPattern
    ? polygonFillPattern(context, scene, primitive, patterns)
    : primitive.fillColor;
  if (fillStyle) {
    context.fillStyle = fillStyle;
    context.globalAlpha = primitive.fillOpacity;
    context.fill("evenodd");
  }
  const strokeWidth = interactionStrokeWidth(primitive.strokeWidth, selected, hovered);
  // Canvas ignores lineWidth = 0 and would reuse the previous shape's width.
  if (strokeWidth > 0) {
    context.globalAlpha = primitive.strokeOpacity;
    context.lineJoin = "round";
    context.lineWidth = strokeWidth;
    context.strokeStyle = primitive.strokeColor;
    context.stroke();
  }
  context.globalAlpha = 1;
}

/** MapLibre's GeoJSON tile size, whose grid (at the floored zoom) patterns are placed on. */
const PATTERN_TILE_SIZE = 512;

function patternTileZoom(zoom: number) {
  return Math.max(0, Math.floor(zoom + 1e-9));
}

/** A coordinate in pixels at the tile zoom, from the world's north-west corner (+y south). */
function patternWorldPixel([longitude, latitude]: readonly [number, number], tileZoom: number) {
  const size = PATTERN_TILE_SIZE * 2 ** tileZoom;
  const radians = (Math.min(Math.max(latitude, -85.051129), 85.051129) * Math.PI) / 180;
  return {
    x: ((longitude + 180) / 360) * size,
    y: (0.5 - Math.log(Math.tan(Math.PI / 4 + radians / 2)) / (2 * Math.PI)) * size,
  };
}

/**
 * MapLibre's `fill-pattern` as a Canvas pattern (#350): repeating on the tile grid in pixels
 * at the floored zoom, like the retained and projected paths. The transform is the local
 * affine of the projection at the polygon's first vertex, exact under a bearing and an
 * approximation under pitch, which a 2D pattern cannot follow. `null` draws no fill.
 */
function polygonFillPattern<TFeature>(
  context: CanvasRenderingContext2D,
  scene: CanvasPolygonScenePrimitive<TFeature>,
  primitive: MapRenderPolygon<TFeature>,
  patterns: CanvasMapPatterns | undefined,
): CanvasPattern | null {
  const anchor = primitive.rings[0]?.[0];
  const screen = scene.rings[0]?.[0];
  const image = primitive.fillPattern ? patterns?.images(primitive.fillPattern) : null;
  if (!patterns || !image || image.sdf || !anchor || !screen) return null;

  const tileZoom = patternTileZoom(patterns.zoom);
  const step = 1e-3;
  const east: [number, number] = [anchor[0] + step, anchor[1]];
  const north: [number, number] = [anchor[0], anchor[1] + step];
  const eastScreen = projectPoint(patterns.project, east);
  const northScreen = projectPoint(patterns.project, north);
  if (!isFinitePoint(eastScreen) || !isFinitePoint(northScreen)) return null;

  const origin = patternWorldPixel(anchor, tileZoom);
  const eastWorld = patternWorldPixel(east, tileZoom);
  const northWorld = patternWorldPixel(north, tileZoom);
  // Screen CSS px per pixel at the tile zoom, along x and along y.
  const a = (eastScreen.x - screen.x) / (eastWorld.x - origin.x);
  const b = (eastScreen.y - screen.y) / (eastWorld.x - origin.x);
  const c = (northScreen.x - screen.x) / (northWorld.y - origin.y);
  const d = (northScreen.y - screen.y) / (northWorld.y - origin.y);
  // Whole periods drop out, as `PatternVertex` does, so the translation stays small.
  const displayWidth = image.width / image.pixelRatio;
  const displayHeight = image.height / image.pixelRatio;
  const phaseX = origin.x - Math.floor(origin.x / displayWidth) * displayWidth;
  const phaseY = origin.y - Math.floor(origin.y / displayHeight) * displayHeight;

  const pattern = context.createPattern(image.source, "repeat");
  pattern?.setTransform(
    new DOMMatrix([
      a / image.pixelRatio,
      b / image.pixelRatio,
      c / image.pixelRatio,
      d / image.pixelRatio,
      screen.x - a * phaseX - c * phaseY,
      screen.y - b * phaseX - d * phaseY,
    ]),
  );
  return pattern;
}

/**
 * MapLibre's `line-pattern` on Canvas (#350): per segment, the image spans the line's width
 * and repeats along it by the screen distance at the floored zoom. Unlike the GPU paths it
 * measures on the screen and from the line's start, so under pitch and across GeoJSON tiles
 * it is an approximation, and joins between segments are not mitred.
 */
function drawPatternedLine<TFeature>(
  context: CanvasRenderingContext2D,
  scene: CanvasLineScenePrimitive<TFeature>,
  image: CanvasMapPatternImage,
  zoom: number,
  width: number,
  opacity: number,
) {
  if (width <= 0) return;
  const pattern = context.createPattern(image.source, "repeat");
  if (!pattern) return;
  const tileToScreen = 2 ** (zoom - patternTileZoom(zoom));
  // One image period along the line: its aspect ratio at the line's width, in screen px.
  const period = (image.width / image.height) * width * tileToScreen;
  // MapLibre samples one texel past the image on every side; a repeating pattern wraps there
  // like the atlas padding (one extra row and column of the image, either side).
  const alongScale = period / (image.width + 2);
  // The image spans half a physical pixel past each edge, as the GPU strip's antialiasing does.
  const halfWidth = width / 2 + 0.5 / (context.getTransform?.().a || 1);
  const acrossScale = (2 * halfWidth) / (image.height + 2);
  const edge = width / 2;
  context.globalAlpha = opacity;
  context.fillStyle = pattern;
  let distance = 0;
  for (let index = 0; index + 1 < scene.points.length; index += 1) {
    const start = scene.points[index]!;
    const end = scene.points[index + 1]!;
    const length = Math.hypot(end.x - start.x, end.y - start.y);
    if (length === 0) continue;
    const along = { x: (end.x - start.x) / length, y: (end.y - start.y) / length };
    // The image's top row is on the line's right-hand side (MapLibre's `v_normal.y` of -1).
    const across = { x: -along.y, y: along.x };
    const phase = distance % period;
    pattern.setTransform(
      new DOMMatrix([
        along.x * alongScale,
        along.y * alongScale,
        -across.x * acrossScale,
        -across.y * acrossScale,
        start.x + along.x * (alongScale - phase) + across.x * (halfWidth - acrossScale),
        start.y + along.y * (alongScale - phase) + across.y * (halfWidth - acrossScale),
      ]),
    );
    context.beginPath();
    // The strip fades over its outer pixel; a box-filtered edge at the half width matches.
    context.moveTo(start.x + across.x * edge, start.y + across.y * edge);
    context.lineTo(end.x + across.x * edge, end.y + across.y * edge);
    context.lineTo(end.x - across.x * edge, end.y - across.y * edge);
    context.lineTo(start.x - across.x * edge, start.y - across.y * edge);
    context.closePath();
    context.fill();
    distance += length;
  }
  context.globalAlpha = 1;
}

function traceLine(
  context: CanvasRenderingContext2D,
  points: readonly MapScreenPoint[],
  close: boolean,
  beginPath = true,
) {
  if (beginPath) context.beginPath();
  const first = points[0];
  if (!first) return;
  context.moveTo(first.x, first.y);
  for (let index = 1; index < points.length; index += 1) {
    const point = points[index]!;
    context.lineTo(point.x, point.y);
  }
  if (close) context.closePath();
}

function interactionStrokeWidth(base: number, selected: boolean, hovered: boolean) {
  return Math.max(0, base + (selected ? 1.5 : hovered ? 1 : 0));
}

function hitPrimitive<TFeature>(
  primitive: CanvasMapScenePrimitive<TFeature>,
  point: MapScreenPoint,
) {
  switch (primitive.kind) {
    case "circle": {
      // MapLibre's circle query extent: the radius plus the stroke drawn outside it.
      const circle = primitive.renderPrimitive as MapRenderCircle<TFeature>;
      const radius = circle.radius + circle.strokeWidth;
      const dx = point.x - primitive.x;
      const dy = point.y - primitive.y;
      return dx * dx + dy * dy <= radius * radius;
    }
    case "direction-marker":
      return false;
    case "line": {
      const tolerance = Math.max(
        4,
        (primitive.renderPrimitive as MapRenderLine<TFeature>).strokeWidth / 2 + 2,
      );
      return isWithinPolylineTolerance(point, primitive.points, tolerance * tolerance);
    }
    case "polygon": {
      const renderPrimitive = primitive.renderPrimitive as MapRenderPolygon<TFeature>;
      if (pointInRings(point, primitive.rings)) return true;
      const tolerance = Math.max(4, renderPrimitive.strokeWidth / 2 + 2);
      return primitive.rings.some((ring) =>
        isWithinPolylineTolerance(point, ring, tolerance * tolerance, true),
      );
    }
  }
}

function pointInRings(point: MapScreenPoint, rings: readonly MapScreenPoint[][]) {
  let inside = false;
  for (const ring of rings) {
    if (pointInRing(point, ring)) inside = !inside;
  }
  return inside;
}

function pointInRing(point: MapScreenPoint, ring: readonly MapScreenPoint[]) {
  let inside = false;
  for (let current = 0, previous = ring.length - 1; current < ring.length; previous = current++) {
    const a = ring[current]!;
    const b = ring[previous]!;
    const crosses =
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

/** Picking needs any matching segment, not the minimum distance over the whole path. */
function isWithinPolylineTolerance(
  point: MapScreenPoint,
  points: readonly MapScreenPoint[],
  squaredTolerance: number,
  closed = false,
) {
  for (let index = 1; index < points.length; index += 1) {
    if (squaredDistanceToSegment(point, points[index - 1]!, points[index]!) <= squaredTolerance) {
      return true;
    }
  }
  // Canvas closes polygon rings even when the source does not repeat the first point.
  return (
    closed &&
    points.length >= 2 &&
    squaredDistanceToSegment(point, points[points.length - 1]!, points[0]!) <= squaredTolerance
  );
}

function squaredDistanceToSegment(
  point: MapScreenPoint,
  start: MapScreenPoint,
  end: MapScreenPoint,
) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (dx === 0 && dy === 0) return squaredDistance(point, start);
  const t = Math.max(
    0,
    Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy)),
  );
  // Preserve the distance arithmetic without allocating a closest-point object per segment.
  const offsetX = point.x - (start.x + t * dx);
  const offsetY = point.y - (start.y + t * dy);
  return offsetX * offsetX + offsetY * offsetY;
}

function squaredDistance(left: MapScreenPoint, right: MapScreenPoint) {
  const dx = left.x - right.x;
  const dy = left.y - right.y;
  return dx * dx + dy * dy;
}
