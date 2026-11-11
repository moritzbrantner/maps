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
  /** Uploaded raster images that finished decoding and became drawable. */
  rasterImagesDecoded: number;
  /** Heat rasters drawn into the overlay (one per visible raster per presented frame). */
  rasterDraws: number;
  /**
   * Clipped affine triangles those draws submitted to Canvas. Geographic rasters are split until
   * the triangles follow the projection; screen-space rasters draw with one image call and none.
   */
  rasterDrawTriangles: number;
};

/** Running totals of every heat/scalar work set registered while observation is installed. */
export type HeatLayerWorkTotals = {
  data: HeatLayerDataWork;
  /** Mounted layers whose work is included (cumulative, unmounted layers stay counted). */
  layers: number;
  /** Render states whose work is included (cumulative). */
  renderStates: number;
  surface: HeatLayerSurfaceWork;
};

export type HeatLayerWorkObservation = {
  totals(): HeatLayerWorkTotals;
};

type HeatLayerWorkRegistry = {
  data: HeatLayerDataWork[];
  surface: HeatLayerSurfaceWork[];
};

let registry: HeatLayerWorkRegistry | null = null;

/**
 * Evidence-only observation for browser journeys (#171 phase 5): once installed, every work set
 * created afterwards is registered, so a page can read the totals without reaching into the Map
 * View. Nothing is registered (and nothing is retained) unless a page installs it; it is not
 * part of the public package API.
 */
export function observeHeatLayerWork(): HeatLayerWorkObservation {
  const observed = (registry ??= { data: [], surface: [] });
  return {
    totals() {
      const data = emptyDataWork();
      const surface = emptySurfaceWork();
      for (const work of observed.data) addWork(data, work);
      for (const work of observed.surface) addWork(surface, work);
      return {
        data,
        layers: observed.data.length,
        renderStates: observed.surface.length,
        surface,
      };
    },
  };
}

function addWork<T extends Record<keyof T, number>>(total: T, work: T) {
  for (const key of Object.keys(total) as (keyof T)[]) {
    (total[key] as number) += work[key];
  }
}

export function createHeatLayerDataWork(): HeatLayerDataWork {
  const work = emptyDataWork();
  registry?.data.push(work);
  return work;
}

export function createHeatLayerSurfaceWork(): HeatLayerSurfaceWork {
  const work = emptySurfaceWork();
  registry?.surface.push(work);
  return work;
}

function emptyDataWork(): HeatLayerDataWork {
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

function emptySurfaceWork(): HeatLayerSurfaceWork {
  return {
    rasterDrawTriangles: 0,
    rasterDraws: 0,
    rasterImagesDecoded: 0,
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
