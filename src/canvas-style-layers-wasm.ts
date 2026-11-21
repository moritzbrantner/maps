import { importMapsWasmModule, type MapsWasmModuleBase } from "./aggregation-wasm";
import {
  clearStyleLayerTarget,
  compositeStyleLayers,
  createStyleLayerTarget,
  rasterizeStyleLayers,
  styleLayerViewportScissor,
  type StyleLayerTarget,
  type StyleLayerTexture,
} from "./canvas-style-layers";
import type {
  MapsRasterRenderCamera,
  MapsRasterTileId,
  MapsRasterTilePlacement,
} from "./flat-runtime-wasm";
import type { MapsTilesetFeature } from "./maps-tileset-style";
import { packMapsTileDraws } from "./wgpu-base-map-wasm";

/** `MapsStyleLayerFrames` (`crates/maps-wasm/src/style_layer_frames.rs`). */
type MapsStyleLayerFramesWasm = {
  setVectorLayers(layers: string): void;
  addGlyphs(stack: string, start: number, bytes: Uint8Array): void;
  missingGlyphRanges(): string[];
  addSprite(json: string, rgba: Uint8Array, width: number, height: number): number;
  setVectorSource(source: string): void;
  setVectorMaxZoom(maxZoom: number): void;
  setMapMaxZoom(maxZoom: number): void;
  takeStyleRelayout(): string[] | undefined;
  queryRenderedFeatures(x: number, y: number, layers: string[]): string;
  uploadVectorTile(z: number, x: number, y: number, bytes: Uint8Array): void;
  evictVectorTile(z: number, x: number, y: number): void;
  evictVectorSourceTile(source: string, z: number, x: number, y: number): void;
  isActive(): boolean;
  frame(tileDraws: Float64Array, width: number, height: number, now: number): void;
  draws(): Uint32Array;
  circles(): Float32Array;
  glyphs(): Float32Array;
  lines(): Float32Array;
  fills(): Float32Array;
  outlines(): Float32Array;
  tileFrames(): Float32Array;
  crossfade(): Float32Array;
  isCrossFading(): boolean;
  glyphAtlasInfo(): Float64Array;
  glyphAtlas(): Uint8Array;
  imageAtlasInfo(): Float64Array;
  imageAtlas(): Uint8Array;
  dashAtlasInfo(): Float64Array;
  dashAtlas(): Uint8Array;
  free?: () => void;
};

type MapsStyleLayerFramesModule = MapsWasmModuleBase & {
  MapsStyleLayerFrames?: new () => MapsStyleLayerFramesWasm;
};

/**
 * Tileset style layers (`MapView tilesetLayers`) on the Canvas2D fallback (#346). Holds the
 * same style-layer state the wgpu renderer holds (layers, glyphs, sprite, vector tiles), so the
 * host feeds both backends through one seam; `draw` composites the frame Rust laid out and
 * placed for the wgpu programs, rasterized by `canvas-style-layers.ts`.
 */
export type MapsCanvasStyleLayers = {
  setVectorSource(source: string): void;
  setVectorMaxZoom(maxZoom: number): void;
  setVectorLayers(layers: string): void;
  /** The Map View's maximum zoom, bounding how deep style layers split source tiles. */
  setMapMaxZoom(maxZoom: number): void;
  /** As the wgpu renderer's: errors of tiles laid out again past the source's maximum zoom. */
  takeStyleRelayout(): string[] | undefined;
  /**
   * MapLibre's `queryRenderedFeatures` at a viewport point (CSS px) over circle and symbol
   * style layers, against what the last Canvas frame drew, topmost first.
   */
  queryRenderedFeatures(point: { x: number; y: number }, layers: readonly string[]): MapsTilesetFeature[];
  addGlyphs(stack: string, start: number, bytes: Uint8Array): void;
  missingGlyphRanges(): string[];
  addSprite(json: string, rgba: Uint8Array, width: number, height: number): number;
  uploadVectorTile(tile: MapsRasterTileId, bytes: Uint8Array): number;
  evictVectorTile(tile: MapsRasterTileId): void;
  evictVectorSourceTile(source: string, tile: MapsRasterTileId): void;
  /** Whether any style layer is configured. */
  isActive(): boolean;
  /** Whether the last frame drew patterns mid cross-fade: the host renders again. */
  isCrossFading(): boolean;
  /**
   * Draws the style layers of a frame over `canvas` (whose backing store is the render
   * surface: the viewport grown by `surfaceMargin` CSS px per side).
   */
  draw(
    canvas: HTMLCanvasElement,
    placements: readonly MapsRasterTilePlacement[],
    renderCamera: MapsRasterRenderCamera,
    surfaceMargin: number,
    viewportClip: { height: number; width: number } | null,
    now: number,
  ): void;
  dispose(): void;
};

export async function loadMapsCanvasStyleLayers(
  packageName?: string,
): Promise<MapsCanvasStyleLayers> {
  const wasmModule = await importMapsWasmModule<MapsStyleLayerFramesModule>("core", packageName);
  const Constructor = wasmModule.MapsStyleLayerFrames;
  if (!Constructor) throw new Error("Maps WASM style layer frames are unavailable.");
  const frames = new Constructor();
  let disposed = false;
  let tileDraws = new Float64Array(64);
  let target: StyleLayerTarget | null = null;
  let scratch: HTMLCanvasElement | null = null;
  // Atlases are copied out of WASM only when their revision changed.
  const atlases = new Map<string, { revision: number; texture: StyleLayerTexture | null }>();
  const atlas = (
    name: string,
    info: () => Float64Array,
    data: () => Uint8Array,
    channels: 1 | 4,
  ): StyleLayerTexture | null => {
    const [revision = 0, width = 0, height = 0] = info();
    const cached = atlases.get(name);
    if (cached && cached.revision === revision) return cached.texture;
    const texture = width > 0 && height > 0 ? { channels, data: data(), height, width } : null;
    atlases.set(name, { revision, texture });
    return texture;
  };
  const live = () => {
    if (disposed) throw new Error("Maps Canvas style layers have been disposed.");
  };

  return {
    setVectorSource(source) {
      live();
      frames.setVectorSource(source);
    },
    setVectorMaxZoom(maxZoom) {
      live();
      frames.setVectorMaxZoom(maxZoom);
    },
    setVectorLayers(layers) {
      live();
      frames.setVectorLayers(layers);
    },
    setMapMaxZoom(maxZoom) {
      live();
      frames.setMapMaxZoom(maxZoom);
    },
    takeStyleRelayout() {
      live();
      return frames.takeStyleRelayout() ?? undefined;
    },
    queryRenderedFeatures(point, layers) {
      live();
      return JSON.parse(
        frames.queryRenderedFeatures(point.x, point.y, [...layers]),
      ) as MapsTilesetFeature[];
    },
    addGlyphs(stack, start, bytes) {
      live();
      frames.addGlyphs(stack, start, bytes);
    },
    missingGlyphRanges() {
      live();
      return frames.missingGlyphRanges();
    },
    addSprite(json, rgba, width, height) {
      live();
      return frames.addSprite(json, rgba, width, height);
    },
    uploadVectorTile(tile, bytes) {
      live();
      frames.uploadVectorTile(tile.z, tile.x, tile.y, bytes);
      return 0;
    },
    evictVectorTile(tile) {
      live();
      frames.evictVectorTile(tile.z, tile.x, tile.y);
    },
    evictVectorSourceTile(source, tile) {
      live();
      frames.evictVectorSourceTile(source, tile.z, tile.x, tile.y);
    },
    isActive() {
      return !disposed && frames.isActive();
    },
    isCrossFading() {
      return !disposed && frames.isCrossFading();
    },
    draw(canvas, placements, renderCamera, surfaceMargin, viewportClip, now) {
      live();
      if (!frames.isActive()) return;
      const { width, height } = canvas;
      const packed = packMapsTileDraws(
        tileDraws,
        placements,
        renderCamera,
        surfaceMargin,
        viewportClip,
      );
      tileDraws = packed.buffer;
      frames.frame(packed.draws, width, height, now);
      const draws = frames.draws();
      if (draws.length === 0) return;
      if (!target || target.width !== width || target.height !== height) {
        target = createStyleLayerTarget(width, height);
      } else {
        clearStyleLayerTarget(target);
      }
      const scissor = viewportClip
        ? styleLayerViewportScissor(viewportClip, surfaceMargin, { height, width })
        : undefined;
      rasterizeStyleLayers(
        target,
        {
          circles: frames.circles(),
          crossfade: frames.crossfade(),
          draws,
          fills: frames.fills(),
          glyphs: frames.glyphs(),
          lines: frames.lines(),
          outlines: frames.outlines(),
          tileFrames: frames.tileFrames(),
        },
        {
          dash: atlas("dash", () => frames.dashAtlasInfo(), () => frames.dashAtlas(), 1),
          glyph: atlas("glyph", () => frames.glyphAtlasInfo(), () => frames.glyphAtlas(), 1),
          image: atlas("image", () => frames.imageAtlasInfo(), () => frames.imageAtlas(), 4),
        },
        scissor,
      );
      const context = canvas.getContext("2d");
      if (!context) return;
      scratch ??= document.createElement("canvas");
      compositeStyleLayers(context, target, scratch);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      target = null;
      scratch = null;
      atlases.clear();
      frames.free?.();
    },
  };
}
