import { createMapsBrowserRuntime } from "../../src/maps-browser-runtime";
import { createMapsNativeLayerRuntime } from "../../src/maps-native-layer-runtime";
import {
  createCanvasMapSceneProjector,
  drawCanvasMapScene,
  hitTestCanvasMapScene,
  type CanvasMapScene,
} from "../../src/canvas-map-renderer";
import {
  points,
  initialCamera,
  observeNativeMap,
  probe,
  pointColor,
  filterPoint,
} from "./native-map-probe";

await observeNativeMap();
const base = document.querySelector<HTMLCanvasElement>("#base")!;
const fallback = document.querySelector<HTMLCanvasElement>("#fallback")!;
const layers = document.querySelector<HTMLCanvasElement>("#layers")!;
const map = document.querySelector<HTMLElement>("#map")!;
const data = createMapsNativeLayerRuntime();
const projectScene = createCanvasMapSceneProjector();
const project = Object.assign(
  (coordinate: [number, number]) => host.controller!.project(coordinate),
  { projectPacked: (coordinates: Float64Array) => host.controller!.projectPacked(coordinates) },
);
let scene: CanvasMapScene | null = null;
let revision = 0;
const host = createMapsBrowserRuntime(base, fallback, {
  mapStyle: { tiles: false },
  viewState: initialCamera,
  onCameraFrame() {
    const controller = host.controller;
    if (!controller) return;
    const rect = base.getBoundingClientRect();
    const ratio = devicePixelRatio;
    const width = Math.round(rect.width);
    const height = Math.round(rect.height);
    if (layers.width !== width * ratio) layers.width = width * ratio;
    if (layers.height !== height * ratio) layers.height = height * ratio;
    scene = projectScene(
      data.pointFrame({ points, getPointColor: pointColor, filterPoint, pointRadius: 2 }, "native"),
      project,
      { width, height },
      ++revision,
    );
    const gpu = controller.renderApplicationFrame(scene);
    layers.dataset.mapOverlayBackend = gpu ? "wgpu" : "canvas2d";
    const ctx = layers.getContext("2d")!;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    if (gpu) ctx.clearRect(0, 0, width, height);
    else drawCanvasMapScene(ctx, scene);
  },
  onViewStateChange() {
    probe.changes++;
  },
  onReady() {
    probe.readyCount++;
    map.dataset.ready = "true";
  },
  onError(error) {
    map.dataset.error = String(error);
  },
});
await host.ready;
probe.command = (state) => host.controller!.setViewState(state);
base.addEventListener("pointermove", (event) => {
  if (!scene || base.hasPointerCapture(event.pointerId)) return;
  const rect = base.getBoundingClientRect();
  const pick = hitTestCanvasMapScene(scene, {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  });
  document.getElementById("picked")!.textContent = pick
    ? `Picked ${pick.renderPrimitive.featureId}`
    : "No selection";
});
document.getElementById("zoom")!.onclick = () => {
  const camera = host.controller!.getViewState();
  host.controller!.setViewState({ ...camera, zoom: camera.zoom + 0.2 });
};
document.getElementById("dispose")!.onclick = () => {
  host.dispose();
  data.clear();
  scene = null;
  map.dataset.ready = "false";
};
