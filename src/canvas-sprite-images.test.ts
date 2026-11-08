import { afterEach, describe, expect, it, vi } from "vitest";

import { createCanvasSpriteImages } from "./canvas-sprite-images";

class TestImageData {
  constructor(
    readonly data: Uint8ClampedArray,
    readonly width: number,
    readonly height: number,
  ) {}
}

function stubCanvases() {
  const contexts: { putImageData: ReturnType<typeof vi.fn> }[] = [];
  class TestOffscreenCanvas {
    constructor(
      readonly width: number,
      readonly height: number,
    ) {}
    getContext() {
      const context = { putImageData: vi.fn() };
      contexts.push(context);
      return context;
    }
  }
  vi.stubGlobal("OffscreenCanvas", TestOffscreenCanvas);
  vi.stubGlobal("ImageData", TestImageData);
  return contexts;
}

describe("Canvas sprite images (#350)", () => {
  afterEach(() => vi.unstubAllGlobals());

  // A 3 x 2 sheet: one pixel per value, RGBA.
  const sheet = {
    height: 2,
    json: JSON.stringify({
      hatch: { height: 1, pixelRatio: 2, width: 2, x: 1, y: 1 },
      off: { height: 1, width: 2, x: 2, y: 0 },
      stars: { height: 1, sdf: true, width: 1, x: 0, y: 0 },
    }),
    rgba: new Uint8Array(Array.from({ length: 24 }, (_, value) => value)),
    width: 3,
  };

  it("cuts the named image from the sheet with its density, once", () => {
    const contexts = stubCanvases();
    const images = createCanvasSpriteImages(sheet);

    const hatch = images("hatch")!;
    expect(hatch).toMatchObject({ height: 1, pixelRatio: 2, sdf: false, width: 2 });
    expect(contexts).toHaveLength(1);
    const pixels = contexts[0]!.putImageData.mock.calls[0]![0] as TestImageData;
    // Row 1, columns 1 and 2 of the sheet.
    expect(Array.from(pixels.data)).toEqual([16, 17, 18, 19, 20, 21, 22, 23]);
    expect(images("hatch")).toBe(hatch);
    expect(contexts).toHaveLength(1);
  });

  it("marks SDF images and rejects missing and out-of-sheet ones", () => {
    stubCanvases();
    const images = createCanvasSpriteImages(sheet);
    expect(images("stars")?.sdf).toBe(true);
    expect(images("off")).toBeNull();
    expect(images("absent")).toBeNull();
  });
});
