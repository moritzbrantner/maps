import { describe, expect, test, vi } from "vitest";

import { drawCanvasSky } from "./canvas-sky";

function mockContext() {
  const stops: Array<[number, string]> = [];
  return {
    clearRect: vi.fn(),
    createLinearGradient: vi.fn(() => ({
      addColorStop: (at: number, color: string) => stops.push([at, color]),
    })),
    fillRect: vi.fn(),
    fillStyle: "" as unknown,
    stops,
  };
}

describe("drawCanvasSky", () => {
  test("a transparent sky clears the band above the horizon and paints nothing", () => {
    const context = mockContext();
    drawCanvasSky(
      context as unknown as CanvasRenderingContext2D,
      { horizonBlend: 192, horizonColor: [0, 0, 0, 0], horizonY: 76, skyColor: [0, 0, 0, 0] },
      720,
      10,
    );
    expect(context.clearRect).toHaveBeenCalledWith(0, 0, 720, 86);
    expect(context.fillRect).not.toHaveBeenCalled();
  });

  test("a colored sky fades from the horizon color to the sky color", () => {
    const context = mockContext();
    drawCanvasSky(
      context as unknown as CanvasRenderingContext2D,
      { horizonBlend: 100, horizonColor: [1, 1, 1, 1], horizonY: 76, skyColor: [0, 0, 1, 1] },
      720,
      0,
    );
    expect(context.createLinearGradient).toHaveBeenCalledWith(0, 76, 0, -24);
    expect(context.stops[0]).toEqual([0, "rgba(255,255,255,1)"]);
    expect(context.stops.at(-1)).toEqual([1, "rgba(0,0,255,1)"]);
    expect(context.fillRect).toHaveBeenCalledWith(0, 0, 720, 76);
  });
});
