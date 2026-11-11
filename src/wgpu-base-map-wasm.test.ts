import { beforeEach, expect, test, vi } from "vitest";

import { loadMapsWgpuBaseMapRenderer } from "./wgpu-base-map-wasm";

const wasm = vi.hoisted(() => ({
  createRenderer: vi.fn(),
  importModule: vi.fn(),
  webGpu: true,
}));
// The real adapter owns the canvas; only the external WASM/device edge is replaced.
vi.mock("./aggregation-wasm", () => ({
  importMapsWasmModule: wasm.importModule,
  isMapsWebGpuAvailable: () => wasm.webGpu,
}));

beforeEach(() => {
  wasm.createRenderer.mockReset();
  wasm.importModule.mockReset();
  wasm.importModule.mockImplementation(async () => ({
    createWgpuBaseMapRenderer: wasm.createRenderer,
  }));
  wasm.webGpu = true;
});

test("without WebGPU the renderer module is never fetched and the host falls back", async () => {
  const canvas = document.createElement("canvas");
  wasm.webGpu = false;

  await expect(loadMapsWgpuBaseMapRenderer(canvas)).rejects.toThrow("WebGPU is unavailable");

  expect(wasm.importModule).not.toHaveBeenCalled();
  expect(canvas.style.opacity).toBe("0");
});

test("the renderer loads the full renderer module", async () => {
  wasm.createRenderer.mockResolvedValueOnce(device());
  await loadMapsWgpuBaseMapRenderer(document.createElement("canvas"), "/wasm/maps_wasm.js");
  expect(wasm.importModule).toHaveBeenCalledWith("renderer", "/wasm/maps_wasm.js");
});

function device() {
  return {
    free: vi.fn(),
    evictTile: vi.fn(),
    isDeviceLost: vi.fn(() => false),
    renderPacked: vi.fn(() => 0),
    resize: vi.fn(),
    uploadTile: vi.fn(),
  };
}

test("disposing an older renderer cannot hide its live replacement on the same canvas", async () => {
  const canvas = document.createElement("canvas");
  const oldDevice = device();
  const currentDevice = device();
  wasm.createRenderer.mockResolvedValueOnce(oldDevice).mockResolvedValueOnce(currentDevice);
  const older = await loadMapsWgpuBaseMapRenderer(canvas);
  const current = await loadMapsWgpuBaseMapRenderer(canvas);

  older.dispose();

  expect(oldDevice.free).toHaveBeenCalledTimes(1);
  expect(currentDevice.free).not.toHaveBeenCalled();
  expect(canvas.style.opacity).toBe("1");
  expect(() => older.resize(100, 100)).toThrow("superseded");
  expect(oldDevice.resize).not.toHaveBeenCalled();
  expect(canvas.style.opacity).toBe("1");
  expect(current.isDeviceLost()).toBe(false);
  current.dispose();
  expect(canvas.style.opacity).toBe("0");
});

test("late completion of an older device cannot take canvas visibility from the replacement", async () => {
  const canvas = document.createElement("canvas");
  const oldDevice = device();
  const currentDevice = device();
  let completeOld: () => void = () => {
    throw new Error("device gate not initialized");
  };
  const oldGate = new Promise<void>((resolve) => {
    completeOld = resolve;
  });
  wasm.createRenderer
    .mockImplementationOnce(async () => {
      await oldGate;
      return oldDevice;
    })
    .mockResolvedValueOnce(currentDevice);

  const olderLoading = loadMapsWgpuBaseMapRenderer(canvas);
  await vi.waitFor(() => expect(wasm.createRenderer).toHaveBeenCalledTimes(1));
  const current = await loadMapsWgpuBaseMapRenderer(canvas);
  completeOld();
  const older = await olderLoading;
  older.dispose();

  expect(canvas.style.opacity).toBe("1");
  expect(current.isDeviceLost()).toBe(false);
  expect(oldDevice.free).toHaveBeenCalledTimes(1);
  expect(currentDevice.free).not.toHaveBeenCalled();
  current.dispose();
});

test("a superseded device initialization failure cannot hide the current canvas", async () => {
  const canvas = document.createElement("canvas");
  const currentDevice = device();
  let failOld: () => void = () => {
    throw new Error("device gate not initialized");
  };
  const oldGate = new Promise<void>((_, reject) => {
    failOld = () => reject(new Error("device unavailable"));
  });
  wasm.createRenderer
    .mockImplementationOnce(async () => {
      await oldGate;
      return device();
    })
    .mockResolvedValueOnce(currentDevice);

  const olderLoading = loadMapsWgpuBaseMapRenderer(canvas);
  await vi.waitFor(() => expect(wasm.createRenderer).toHaveBeenCalledTimes(1));
  const current = await loadMapsWgpuBaseMapRenderer(canvas);
  failOld();
  await expect(olderLoading).rejects.toThrow("device unavailable");

  expect(canvas.style.opacity).toBe("1");
  expect(current.isDeviceLost()).toBe(false);
  current.dispose();
});

test("a current device failure hides its canvas so the host can select its fallback", async () => {
  const canvas = document.createElement("canvas");
  const currentDevice = device();
  wasm.createRenderer.mockResolvedValueOnce(currentDevice);
  const current = await loadMapsWgpuBaseMapRenderer(canvas);
  currentDevice.resize.mockImplementationOnce(() => {
    throw new Error("device unavailable");
  });

  expect(() => current.resize(100, 100)).toThrow("device unavailable");
  expect(canvas.style.opacity).toBe("0");
  current.dispose();
});
