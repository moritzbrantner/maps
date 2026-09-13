from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    if new in text:
        return
    if old not in text:
        raise SystemExit(f"expected patch anchor missing in {path}: {old[:120]!r}")
    file.write_text(text.replace(old, new, 1))


replace_once(
    "Cargo.toml",
    'wasm-bindgen = "=0.2.128"\n',
    'wasm-bindgen = "=0.2.128"\n'
    'wasm-bindgen-futures = "=0.4.77"\n'
    'web-sys = { version = "=0.3.105", features = ["HtmlCanvasElement", "ImageBitmap"] }\n'
    'wgpu = { version = "=30.0.1", default-features = false, features = ["std", "webgpu", "wgsl"] }\n',
)

replace_once(
    "crates/maps-wasm/Cargo.toml",
    '[target.\'cfg(all(target_arch = "wasm32", target_os = "unknown"))\'.dependencies]\n'
    'getrandom = { workspace = true, features = ["wasm_js"] }\n',
    '[target.\'cfg(all(target_arch = "wasm32", target_os = "unknown"))\'.dependencies]\n'
    'getrandom = { workspace = true, features = ["wasm_js"] }\n'
    'wasm-bindgen-futures.workspace = true\n'
    'web-sys.workspace = true\n'
    'wgpu.workspace = true\n',
)

replace_once(
    "crates/maps-wasm/src/lib.rs",
    "mod engine_scenario;\n",
    'mod engine_scenario;\n'
    '#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]\n'
    'mod wgpu_base_map;\n',
)

canvas_path = Path("src/canvas-flat-runtime.tsx")
canvas = canvas_path.read_text()
if 'from "./wgpu-base-map-wasm"' not in canvas:
    canvas = canvas.replace(
        'import { useEffect, useRef } from "react";',
        'import { useEffect, useRef, useState } from "react";',
        1,
    )
    anchor = '} from "./flat-runtime-wasm";\n'
    if anchor not in canvas:
        raise SystemExit("flat-runtime import anchor missing")
    canvas = canvas.replace(
        anchor,
        anchor
        + 'import {\n'
        + '  loadMapsWgpuBaseMapRenderer,\n'
        + '  type MapsWgpuBaseMapRenderer,\n'
        + '} from "./wgpu-base-map-wasm";\n',
        1,
    )
    canvas = canvas.replace(
        '  const canvasRef = useRef<HTMLCanvasElement | null>(null);\n'
        '  const runtimeRef = useRef<MapsFlatRasterRuntime | null>(null);',
        '  const canvasRef = useRef<HTMLCanvasElement | null>(null);\n'
        '  const fallbackCanvasRef = useRef<HTMLCanvasElement | null>(null);\n'
        '  const rendererRef = useRef<MapsWgpuBaseMapRenderer | null>(null);\n'
        '  const runtimeRef = useRef<MapsFlatRasterRuntime | null>(null);\n'
        '  const [baseRenderer, setBaseRenderer] = useState<"pending" | "wgpu" | "canvas2d">(\n'
        '    "pending",\n'
        '  );',
        1,
    )
    canvas = canvas.replace(
        '      const canvas = canvasRef.current;\n'
        '      if (!canvas) return;\n\n'
        '      const size = getCanvasCssSize(canvas);',
        '      const canvas = canvasRef.current;\n'
        '      const fallbackCanvas = fallbackCanvasRef.current;\n'
        '      if (!canvas || !fallbackCanvas) return;\n\n'
        '      resizeCanvasBackingStore(canvas);\n'
        '      resizeCanvasBackingStore(fallbackCanvas);\n'
        '      const size = getCanvasCssSize(canvas);',
        1,
    )
    old_init = '''      runtimeRef.current = runtime;
      resizeCanvasBackingStore(canvas);

      const syncFrame = createFrameSynchronizer({
        canvas,
        images: imagesRef.current,
        loads: loadsRef.current,
        runtime,
        source: () => sourceRef.current,
        onError: (error) => onErrorRef.current?.(error),
      });'''
    new_init = '''      let renderer: MapsWgpuBaseMapRenderer | null = null;
      try {
        renderer = await loadMapsWgpuBaseMapRenderer(canvas, wasmPackage);
      } catch {
        renderer = null;
      }

      if (cancelled) {
        renderer?.dispose();
        runtime.dispose();
        return;
      }

      runtimeRef.current = runtime;
      rendererRef.current = renderer;
      setBaseRenderer(renderer ? "wgpu" : "canvas2d");

      const activateCanvasFallback = () => {
        rendererRef.current?.dispose();
        rendererRef.current = null;
        setBaseRenderer("canvas2d");
      };

      const syncFrame = createFrameSynchronizer({
        canvas,
        fallbackCanvas,
        images: imagesRef.current,
        loads: loadsRef.current,
        renderer: () => rendererRef.current,
        runtime,
        source: () => sourceRef.current,
        onError: (error) => onErrorRef.current?.(error),
        onRendererFailure: activateCanvasFallback,
      });'''
    if old_init not in canvas:
        raise SystemExit("runtime initialization anchor missing")
    canvas = canvas.replace(old_init, new_init, 1)
    canvas = canvas.replace(
        '        resizeCanvasBackingStore(canvas);\n'
        '        runtime.resize(nextSize.width, nextSize.height);',
        '        resizeCanvasBackingStore(canvas);\n'
        '        resizeCanvasBackingStore(fallbackCanvas);\n'
        '        try {\n'
        '          rendererRef.current?.resize(canvas.width, canvas.height);\n'
        '        } catch {\n'
        '          activateCanvasFallback();\n'
        '        }\n'
        '        runtime.resize(nextSize.width, nextSize.height);',
        1,
    )
    canvas = canvas.replace(
        '      runtimeRef.current?.dispose();\n'
        '      runtimeRef.current = null;',
        '      rendererRef.current?.dispose();\n'
        '      rendererRef.current = null;\n'
        '      runtimeRef.current?.dispose();\n'
        '      runtimeRef.current = null;',
        1,
    )
    canvas = canvas.replace(
        '  return (\n    <canvas\n',
        '  return (\n    <>\n      <canvas\n',
        1,
    )
    canvas = canvas.replace(
        '      data-flat-runtime="maps"\n'
        '      ref={canvasRef}',
        '      data-flat-runtime="maps"\n'
        '      data-map-base-renderer={baseRenderer}\n'
        '      data-map-base-tiles="0"\n'
        '      ref={canvasRef}',
        1,
    )
    tail = '''      }}
    />
  );
}

function createFrameSynchronizer({'''
    replacement_tail = '''      }}
    />
      <canvas
        aria-hidden="true"
        className="mb-maps__canvas mb-maps__canvas-flat"
        data-map-base-fallback="canvas2d"
        ref={fallbackCanvasRef}
        style={{
          pointerEvents: "none",
          touchAction: "none",
          visibility: baseRenderer === "canvas2d" ? "visible" : "hidden",
        }}
      />
    </>
  );
}

function createFrameSynchronizer({'''
    if tail not in canvas:
        raise SystemExit("component tail anchor missing")
    canvas = canvas.replace(tail, replacement_tail, 1)

    start = canvas.index("function createFrameSynchronizer({")
    end = canvas.index("\nfunction frameViewState", start)
    synchronizer = r'''function createFrameSynchronizer({
  canvas,
  fallbackCanvas,
  images,
  loads,
  renderer,
  runtime,
  source,
  onError,
  onRendererFailure,
}: {
  canvas: HTMLCanvasElement;
  fallbackCanvas: HTMLCanvasElement;
  images: Map<string, ImageBitmap>;
  loads: Map<string, ActiveTileLoad>;
  renderer: () => MapsWgpuBaseMapRenderer | null;
  runtime: MapsFlatRasterRuntime;
  source: () => ReturnType<typeof resolveTileLayerOptions>;
  onError: (error: unknown) => void;
  onRendererFailure: () => void;
}) {
  function failRenderer() {
    onRendererFailure();
  }

  function renderFrame(frame: MapsFlatRasterFrame) {
    const currentRenderer = renderer();
    if (currentRenderer) {
      try {
        const drawnTiles = currentRenderer.render(
          frame.placements,
          frame.camera.width,
          frame.camera.height,
        );
        canvas.dataset.mapBaseTiles = String(drawnTiles);
        return;
      } catch {
        failRenderer();
      }
    }

    canvas.dataset.mapBaseTiles = String(drawCanvasFrame(fallbackCanvas, images, frame));
  }

  function syncFrame(): MapsFlatRasterFrame {
    let frame = runtime.frame();

    for (const tile of frame.cancellations) {
      loads.get(tile.key)?.abort.abort();
      loads.delete(tile.key);
    }
    for (const tile of frame.evictions) {
      const currentRenderer = renderer();
      if (currentRenderer) {
        try {
          currentRenderer.evictTile(tile.key);
        } catch {
          failRenderer();
        }
      }
      images.get(tile.key)?.close();
      images.delete(tile.key);
    }

    const currentSource = source();
    if (!currentSource) {
      while (frame.requests.length > 0) {
        for (const tile of frame.requests) runtime.markLoaded(tile);
        frame = runtime.frame();
      }
      renderFrame(frame);
      return frame;
    }

    renderFrame(frame);

    for (const tile of frame.requests) {
      if (loads.has(tile.key) || images.has(tile.key)) continue;
      const abort = new AbortController();
      loads.set(tile.key, { abort, tile });

      loadRasterTile(buildRasterTileUrl(currentSource.url, tile), abort.signal)
        .then((image) => {
          loads.delete(tile.key);
          if (abort.signal.aborted) {
            image.close();
            return;
          }

          images.set(tile.key, image);
          const currentRenderer = renderer();
          if (currentRenderer) {
            try {
              currentRenderer.uploadTile(tile.key, image);
            } catch {
              failRenderer();
            }
          }
          runtime.markLoaded(tile);
          syncFrame();
        })
        .catch((error) => {
          loads.delete(tile.key);
          if (abort.signal.aborted) return;
          runtime.markFailed(tile);
          onError(error);
        });
    }

    return frame;
  }

  return syncFrame;
}
'''
    canvas = canvas[:start] + synchronizer + canvas[end:]
    canvas = canvas.replace(
        'function drawFrame(\n'
        '  canvas: HTMLCanvasElement,\n'
        '  images: Map<string, ImageBitmap>,\n'
        '  frame: MapsFlatRasterFrame,\n'
        ') {',
        'function drawCanvasFrame(\n'
        '  canvas: HTMLCanvasElement,\n'
        '  images: Map<string, ImageBitmap>,\n'
        '  frame: MapsFlatRasterFrame,\n'
        ') {',
        1,
    )
    canvas = canvas.replace(
        '  const context = canvas.getContext("2d");\n'
        '  if (!context) return;',
        '  const context = canvas.getContext("2d");\n'
        '  if (!context) return 0;',
        1,
    )
    canvas = canvas.replace(
        '  for (const placement of frame.placements) {\n'
        '    const image = images.get(placement.tile.key);\n'
        '    if (!image) continue;\n'
        '    context.drawImage(',
        '  let drawnTiles = 0;\n'
        '  for (const placement of frame.placements) {\n'
        '    const image = images.get(placement.tile.key);\n'
        '    if (!image) continue;\n'
        '    context.drawImage(',
        1,
    )
    canvas = canvas.replace(
        '      placement.screenHeight,\n'
        '    );\n'
        '  }\n'
        '}\n\n'
        'function resizeCanvasBackingStore',
        '      placement.screenHeight,\n'
        '    );\n'
        '    drawnTiles += 1;\n'
        '  }\n\n'
        '  return drawnTiles;\n'
        '}\n\n'
        'function resizeCanvasBackingStore',
        1,
    )
    canvas_path.write_text(canvas)


demo_path = Path("demo/MapsRuntimeAcceptance.tsx")
demo = demo_path.read_text()
if "ACCEPTANCE_RASTER_TILE" not in demo:
    demo = demo.replace(
        'const INITIAL_VIEW_STATE: MapViewState = {',
        'const ACCEPTANCE_RASTER_TILE =\n'
        '  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";\n\n'
        'const INITIAL_VIEW_STATE: MapViewState = {',
        1,
    )
    demo = demo.replace(
        '        This path constructs the Rust/WASM camera, tile, and aggregation runtimes directly. It\n'
        '        intentionally uses no MapLibre instance and no raster network source so interaction evidence\n'
        '        stays deterministic.',
        '        This path constructs the Rust/WASM camera, tile, and aggregation runtimes directly. It\n'
        '        intentionally uses no MapLibre instance. A deterministic embedded raster tile exercises the\n'
        '        first-party base renderer without external network dependence.',
        1,
    )
    demo = demo.replace(
        '        mapStyle={{ tiles: false }}',
        '        mapStyle={{\n'
        '          maxZoom: 19,\n'
        '          minZoom: 0,\n'
        '          tileSize: 256,\n'
        '          tiles: ACCEPTANCE_RASTER_TILE,\n'
        '        }}',
        1,
    )
    demo_path.write_text(demo)


e2e_path = Path("e2e/maps-runtime.spec.ts")
e2e = e2e_path.read_text()
if "webGpuAdapterAvailable" not in e2e:
    e2e = e2e.replace(
        '  await expect(canvas).toBeVisible();\n'
        '  await expect(overlay).toHaveCount(1);',
        '  await expect(canvas).toBeVisible();\n'
        '  await expect(canvas).toHaveAttribute("data-map-base-renderer", /^(wgpu|canvas2d)$/);\n'
        '  await expect\n'
        '    .poll(async () => Number(await canvas.getAttribute("data-map-base-tiles")))\n'
        '    .toBeGreaterThan(0);\n'
        '  const webGpuAdapterAvailable = await page.evaluate(async () => {\n'
        '    if (!("gpu" in navigator)) return false;\n'
        '    try {\n'
        '      return Boolean(await navigator.gpu.requestAdapter());\n'
        '    } catch {\n'
        '      return false;\n'
        '    }\n'
        '  });\n'
        '  if (webGpuAdapterAvailable) {\n'
        '    await expect(canvas).toHaveAttribute("data-map-base-renderer", "wgpu");\n'
        '  }\n'
        '  await expect(overlay).toHaveCount(1);',
        1,
    )
    e2e_path.write_text(e2e)
