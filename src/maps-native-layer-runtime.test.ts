// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { build } from "esbuild";
import { createMapsNativeLayerRuntime } from "./maps-native-layer-runtime";
import { createCanvasMapSceneProjector, hitTestCanvasMapScene } from "./canvas-map-renderer";
import type { PointLayerProps } from "./point-layer";
import type { FlowLayerProps } from "./flow-layer";
import type { MapRenderLine } from "./map-render-frame";

const project = ([x, y]: [number, number]) => ({ x, y });
const size = { width: 600, height: 400 };

describe("native Map Layer invalidation", () => {
  it("changes paint and picking without renormalizing or reprojecting point data", () => {
    const runtime = createMapsNativeLayerRuntime();
    const prepare = createCanvasMapSceneProjector();
    const projection = vi.fn(project);
    const filter = vi.fn(() => true);
    const points = [{ id: "point", longitude: 100, latitude: 100 }];
    const props: PointLayerProps = { points, filterPoint: filter, pointRadius: 2 };
    const before = runtime.pointFrame(props, "points");
    prepare(before, projection, size);
    projection.mockClear();
    filter.mockClear();
    const after = runtime.pointFrame({ ...props, pointRadius: 20, pointColor: "red" }, "points");
    const scene = prepare(after, projection, size);
    expect(projection).not.toHaveBeenCalled();
    expect(filter).not.toHaveBeenCalled();
    expect(before.primitives[0]).toMatchObject({ radius: 2 });
    expect(after.primitives[0]).toMatchObject({ radius: 20, fillColor: "red" });
    expect(hitTestCanvasMapScene(scene, { x: 115, y: 100 })?.renderPrimitive.featureId).toBe(
      "point",
    );
    const renamed = runtime.pointFrame({ ...props, getFeatureId: () => "renamed" }, "points");
    expect(renamed.primitives[0]!.featureId).toBe("renamed");
    expect(filter).not.toHaveBeenCalled();
    runtime.pointFrame({ ...props, filterPoint: () => false }, "points");
    expect(
      runtime.pointFrame({ ...props, filterPoint: () => false }, "points").primitives,
    ).toHaveLength(0);
    runtime.retain(new Set());
    runtime.pointFrame(props, "points");
    expect(filter).toHaveBeenCalledOnce();
    const changed = runtime.pointFrame(
      { ...props, points: [{ ...points[0]!, longitude: 200 }] },
      "points",
    );
    expect(changed.primitives[0]).toMatchObject({ center: [200, 100] });
    runtime.clear();
  });

  it("retains flow paths through paint, marker and interaction changes without mutating old frames", () => {
    const runtime = createMapsNativeLayerRuntime();
    const prepare = createCanvasMapSceneProjector();
    const projection = vi.fn(project);
    const weight = vi.fn(() => 5);
    const color = vi.fn(() => "blue");
    const props: FlowLayerProps = {
      flows: [{ id: "flow", from: [20, 20], to: [180, 100] }],
      getWeight: weight,
      getFlowColor: color,
      flowShape: { type: "arc", segments: 24 },
      showEndpoints: false,
    };
    const entry = runtime.flowFeatures(props, "flows")[0]!;
    const original = entry.paint(0.72, false).line;
    const first = prepare({ kind: "vector", primitives: [original] }, projection, size);
    projection.mockClear();
    weight.mockClear();
    color.mockClear();
    const repeated = runtime.flowFeatures(
      { ...props, flowShape: { type: "arc", segments: 24 } },
      "flows",
    )[0]!;
    expect(repeated).toBe(entry);
    const selected = entry.paint(0.95, true).line;
    const next = prepare({ kind: "vector", primitives: [selected] }, projection, size);
    expect(projection).not.toHaveBeenCalled();
    expect(weight).not.toHaveBeenCalled();
    expect(color).not.toHaveBeenCalled();
    expect(original.strokeOpacity).toBe(0.72);
    expect(selected.strokeWidth).toBe(original.strokeWidth + 1.5);
    expect(first.primitives[0]).toHaveProperty(
      "points",
      next.primitives[0]!.kind === "line" ? next.primitives[0]!.points : [],
    );
    const marked = runtime.flowFeatures(
      { ...props, showDirection: true, showEndpoints: true },
      "flows",
    )[0]!;
    expect(marked.paint(0.8, false).marker).not.toBeNull();
    expect(marked.endpoints.map((p) => p.primitiveId)).toEqual([
      '["flows","flow","endpoint","to"]',
      '["flows","flow","endpoint","from"]',
    ]);
    expect(marked.paint(0.8, false).line.coordinates).toBe(original.coordinates);
    expect(weight).not.toHaveBeenCalled();
    expect(color).not.toHaveBeenCalled();
    const repainted = runtime.flowFeatures(
      { ...props, getFlowColor: () => "red", getFeatureId: () => "new-id" },
      "flows",
    )[0]!;
    expect(repainted.paint(0.72, false).line).toMatchObject({
      featureId: "new-id",
      strokeColor: "red",
    });
    expect(repainted.paint(0.72, false).line.coordinates).toBe(original.coordinates);
    const reshaped = runtime.flowFeatures({ ...props, flowShape: "s-curve" }, "flows")[0]!;
    expect(reshaped.paint(0.72, false).line.coordinates).not.toEqual(original.coordinates);
    expect(weight).not.toHaveBeenCalled();
    expect(runtime.flowFeatures({ ...props, getWeight: () => 0 }, "flows")).toHaveLength(0);
    const wider = runtime.flowFeatures({ ...props, minWidth: 20, maxWidth: 20 }, "flows")[0]!;
    expect(wider.paint(0.72, false).line.strokeWidth).toBe(20);
    runtime.clear();
    weight.mockClear();
    runtime.flowFeatures(props, "flows");
    expect(weight).toHaveBeenCalledOnce();
  });

  it("invalidates all projected caches on camera changes, including previously unprojectable geometry", () => {
    const prepare = createCanvasMapSceneProjector();
    const runtime = createMapsNativeLayerRuntime();
    const entry = runtime.flowFeatures({ flows: [{ id: "f", from: [1, 2], to: [3, 4] }] }, "f")[0]!;
    let visible = false;
    const projection = vi.fn((p: [number, number]) => (visible ? project(p) : null));
    const frame = { kind: "vector" as const, primitives: [entry.paint(0.7, false).line] };
    expect(prepare(frame, projection, size).primitives).toHaveLength(0);
    visible = true;
    expect(prepare(frame, projection, size, 1).primitives).toHaveLength(1);
    projection.mockClear();
    const paint = {
      ...frame,
      primitives: [{ ...frame.primitives[0]!, strokeWidth: 2 } as MapRenderLine],
    };
    prepare(paint, projection, size, 1);
    expect(projection).not.toHaveBeenCalled();
    prepare(paint, projection, { ...size, width: 900 }, 1);
    expect(projection).toHaveBeenCalledTimes(2);
  });

  it("keeps the browser host and retained layer runtime free of React runtime imports", async () => {
    const result = await build({
      entryPoints: ["src/maps-browser-runtime.ts", "src/maps-native-layer-runtime.ts"],
      bundle: true,
      write: false,
      metafile: true,
      outdir: "unused",
      platform: "browser",
      format: "esm",
      packages: "external",
      logLevel: "silent",
    });
    const imports = Object.values(result.metafile!.inputs).flatMap((input) =>
      input.imports.map((dependency) => dependency.path),
    );
    expect(imports.filter((path) => /^(react|react-dom)(\/|$)/.test(path))).toEqual([]);
  });
});
