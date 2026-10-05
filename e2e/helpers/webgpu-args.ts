/**
 * Chromium arguments that keep a SwiftShader WebGPU device alive. With
 * `--use-gl=swiftshader` instead, Chromium destroys the WebGPU device right after the first
 * frame and every "wgpu" spec silently measures the Canvas fallback (#198).
 */
export const WEBGPU_SWIFTSHADER_ARGS = [
  "--enable-unsafe-swiftshader",
  "--enable-unsafe-webgpu",
  "--enable-skia-graphite",
  "--skia-graphite-dawn-backend=swiftshader",
  "--use-angle=swiftshader",
];
