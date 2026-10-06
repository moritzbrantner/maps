/**
 * Chromium arguments that keep a SwiftShader WebGPU device alive. With
 * `--use-gl=swiftshader` instead, Chromium destroys the WebGPU device right after the first
 * frame and every "wgpu" spec silently measures the Canvas fallback (#198).
 *
 * Graphite would also run 2D canvases on emulated SwiftShader GPU, where rasterizing a
 * dense vector tile takes seconds. The last flag keeps 2D canvases on the CPU raster path (#199).
 */
export const WEBGPU_SWIFTSHADER_ARGS = [
  "--enable-unsafe-swiftshader",
  "--enable-unsafe-webgpu",
  "--enable-skia-graphite",
  "--skia-graphite-dawn-backend=swiftshader",
  "--use-angle=swiftshader",
  "--disable-accelerated-2d-canvas",
];
