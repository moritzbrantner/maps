import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, expect, test } from "@playwright/test";
import { WEBGPU_SWIFTSHADER_ARGS } from "./helpers/webgpu-args";

const SHADER_DIRECTORY = fileURLToPath(
  new URL("../crates/maps-wasm/src/shaders/", import.meta.url),
);

// Same Dawn/SwiftShader setup as the wgpu runtime smoke tests.
// naga accepts this; Tint rejects a function whose last statement is `discard`.
// It proves the browser compiler is the one judging the shaders below.
const TINT_ONLY_REJECTION = `
@fragment
fn fs_main(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
  if position.x > 0.0 {
    return vec4<f32>(1.0);
  }
  discard;
}
`;

type CompilationResult = { errors: string[]; name: string };

// Minimal WebGPU surface used below; the repository does not ship @webgpu/types.
type ShaderDevice = {
  createShaderModule(descriptor: { code: string; label: string }): {
    getCompilationInfo(): Promise<{
      messages: readonly { lineNum: number; linePos: number; message: string; type: string }[];
    }>;
  };
  destroy(): void;
  popErrorScope(): Promise<{ message: string } | null>;
  pushErrorScope(filter: "validation"): void;
};
type ShaderGpu = {
  requestAdapter(): Promise<{ requestDevice(): Promise<ShaderDevice> } | null>;
};

test("Maps WGSL shaders compile in the browser's Tint compiler @smoke", async ({ baseURL }) => {
  const shaders = readdirSync(SHADER_DIRECTORY)
    .filter((file) => file.endsWith(".wgsl"))
    .sort()
    .map((file) => ({ code: readFileSync(join(SHADER_DIRECTORY, file), "utf8"), name: file }));
  expect(shaders.length).toBeGreaterThan(0);

  const browser = await chromium.launch({ args: WEBGPU_SWIFTSHADER_ARGS });
  try {
    const page = await browser.newPage();
    // A blank same-origin page gives a secure context without booting the demo.
    const blankUrl = new URL("/__wgsl-validation", baseURL).href;
    await page.route(blankUrl, (route) =>
      route.fulfill({ body: "<!doctype html><title>WGSL</title>", contentType: "text/html" }),
    );
    await page.goto(blankUrl);

    const results = await page.evaluate(
      async (sources): Promise<CompilationResult[] | string> => {
        const gpu = (navigator as Navigator & { gpu?: ShaderGpu }).gpu;
        const adapter = await gpu?.requestAdapter();
        if (!adapter) return "WebGPU adapter unavailable";
        const device = await adapter.requestDevice();
        const compiled: CompilationResult[] = [];
        for (const { code, name } of sources) {
          device.pushErrorScope("validation");
          const info = await device.createShaderModule({ code, label: name }).getCompilationInfo();
          const scopeError = await device.popErrorScope();
          compiled.push({
            errors: [
              ...info.messages
                .filter((message) => message.type === "error")
                .map((message) => `${message.lineNum}:${message.linePos} ${message.message}`),
              ...(scopeError ? [scopeError.message] : []),
            ],
            name,
          });
        }
        device.destroy();
        return compiled;
      },
      [...shaders, { code: TINT_ONLY_REJECTION, name: "tint-only-rejection" }],
    );

    // Missing WebGPU is unavailable evidence, never a pass.
    if (typeof results === "string") throw new Error(results);

    const control = results.pop();
    expect(control?.errors.length, "Tint control shader must be rejected").toBeGreaterThan(0);
    expect(results).toEqual(shaders.map(({ name }) => ({ errors: [], name })));
  } finally {
    await browser.close();
  }
});
