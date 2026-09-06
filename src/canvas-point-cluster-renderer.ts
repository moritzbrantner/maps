import type {
  MapPointClusterRenderFeature,
  MapPointClusterRenderFrame,
} from "./point-cluster-render-frame";

export type CanvasPointClusterSceneFeature<TProperties = Record<string, unknown>> = {
  renderFeature: MapPointClusterRenderFeature<TProperties>;
  x: number;
  y: number;
};

export type CanvasPointClusterScene<TProperties = Record<string, unknown>> = {
  features: Array<CanvasPointClusterSceneFeature<TProperties>>;
  height: number;
  width: number;
};

export type CanvasPointClusterDrawOptions = {
  hoveredFeatureId?: string | null;
  selectedFeatureId?: string | null;
};

export function createCanvasPointClusterScene<TProperties = Record<string, unknown>>(
  frame: MapPointClusterRenderFrame<TProperties>,
  project: (coordinate: [longitude: number, latitude: number]) => { x: number; y: number },
  size: { height: number; width: number },
): CanvasPointClusterScene<TProperties> {
  return {
    features: frame.features.flatMap((renderFeature) => {
      const projected = project(renderFeature.coordinates);

      if (!Number.isFinite(projected.x) || !Number.isFinite(projected.y)) {
        return [];
      }

      return [{ renderFeature, x: projected.x, y: projected.y }];
    }),
    height: Math.max(0, size.height),
    width: Math.max(0, size.width),
  };
}

export function hitTestCanvasPointClusterScene<TProperties = Record<string, unknown>>(
  scene: CanvasPointClusterScene<TProperties>,
  point: { x: number; y: number },
): CanvasPointClusterSceneFeature<TProperties> | null {
  for (let index = scene.features.length - 1; index >= 0; index -= 1) {
    const candidate = scene.features[index]!;
    const dx = point.x - candidate.x;
    const dy = point.y - candidate.y;
    const radius = Math.max(8, candidate.renderFeature.radius);

    if (dx * dx + dy * dy <= radius * radius) {
      return candidate;
    }
  }

  return null;
}

export function drawCanvasPointClusterScene<TProperties = Record<string, unknown>>(
  context: CanvasRenderingContext2D,
  scene: CanvasPointClusterScene<TProperties>,
  options: CanvasPointClusterDrawOptions = {},
) {
  context.clearRect(0, 0, scene.width, scene.height);
  context.textAlign = "center";
  context.textBaseline = "middle";

  for (const candidate of scene.features) {
    const { renderFeature, x, y } = candidate;
    const selected = options.selectedFeatureId === renderFeature.id;
    const hovered = options.hoveredFeatureId === renderFeature.id;

    context.beginPath();
    context.arc(x, y, renderFeature.radius, 0, Math.PI * 2);
    context.fillStyle = renderFeature.fillColor;
    context.globalAlpha = hovered ? 1 : 0.92;
    context.fill();
    context.globalAlpha = 1;
    context.lineWidth = selected ? 4 : hovered ? 3 : 2;
    context.strokeStyle = "#ffffff";
    context.stroke();

    if (renderFeature.kind === "cluster") {
      context.fillStyle = "#ffffff";
      context.font = "600 12px system-ui, sans-serif";
      context.fillText(renderFeature.label, x, y);
    }
  }
}
