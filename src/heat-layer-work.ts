/**
 * Deterministic work counters of a first-party heat/scalar Map Layer (#171 phase 2).
 *
 * Each counter is owned by the resource that decides the work, so the counts describe
 * what actually executed rather than what a caller requested:
 *
 * - {@link HeatLayerDataWork} belongs to one mounted HeatLayer (published on its descriptor).
 *   It counts the camera-independent artifacts: the density source index and its bounds
 *   queries, and the scalar-field grid (interpolation), field image and contours.
 * - {@link HeatLayerSurfaceWork} belongs to one `MapsHeatLayerRenderState`. It counts the
 *   camera-path work: density surface planning, source lowering, cache-key signatures,
 *   rasterizations, raster reuse and raster uploads.
 *
 * The counters are evidence, not policy: nothing reads them to decide work. There is no
 * WASM bridge on these paths while TypeScript is the computational authority, so bridge
 * bytes are not counted here; they belong to a measured Rust authority transfer.
 */
export type HeatLayerDataWork = {
  /** Density source indexes built (weights, filtering and normalization over every point). */
  sourceIndexBuilds: number;
  /** Points accepted into those indexes. */
  sourceIndexPoints: number;
  /** Bounds queries answered by a source index. */
  sourceQueries: number;
  /** Bounds queries answered from the index's last-bounds cache. */
  sourceQueryCacheHits: number;
  /** Scalar-field grids interpolated. */
  fieldGridBuilds: number;
  /** Grid cells produced by those interpolations. */
  fieldGridCells: number;
  /** Retained grids reused for a new image/contour request (async field path). */
  fieldGridReuses: number;
  /** Field raster images built from a grid. */
  fieldImageBuilds: number;
  /** Pixels of those images. */
  fieldImagePixels: number;
  /** Contour collections traced from a grid. */
  fieldContourBuilds: number;
  /** Superseded async field results discarded without being published. */
  fieldResultsDiscarded: number;
};

export type HeatLayerSurfaceWork = {
  /** Density surface plans produced (each lowers its sources unless it reuses the raster). */
  surfacePlans: number;
  /** Sources lowered into raster/metric space by those plans. */
  surfaceSourcesLowered: number;
  /** Sources hashed into a plan's data signature (cache key). */
  surfaceSignatureSources: number;
  /** Frames that reused the committed or pending density raster. */
  surfaceRasterReuses: number;
  /** Density rasters rasterized (sync, or async requests started). */
  surfaceRasterizations: number;
  /** Pixels of those rasterizations. */
  surfaceRasterPixels: number;
  /** Superseded async density rasters discarded without being committed. */
  surfaceResultsDiscarded: number;
  /** Raster images (density or field) handed to the pixel backend for decode/upload. */
  rasterUploads: number;
  /** Pixels of those uploads. */
  rasterUploadPixels: number;
};

export function createHeatLayerDataWork(): HeatLayerDataWork {
  return {
    fieldContourBuilds: 0,
    fieldGridBuilds: 0,
    fieldGridCells: 0,
    fieldGridReuses: 0,
    fieldImageBuilds: 0,
    fieldImagePixels: 0,
    fieldResultsDiscarded: 0,
    sourceIndexBuilds: 0,
    sourceIndexPoints: 0,
    sourceQueries: 0,
    sourceQueryCacheHits: 0,
  };
}

export function createHeatLayerSurfaceWork(): HeatLayerSurfaceWork {
  return {
    rasterUploadPixels: 0,
    rasterUploads: 0,
    surfacePlans: 0,
    surfaceRasterizations: 0,
    surfaceRasterPixels: 0,
    surfaceRasterReuses: 0,
    surfaceResultsDiscarded: 0,
    surfaceSignatureSources: 0,
    surfaceSourcesLowered: 0,
  };
}
