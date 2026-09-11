import { StrictMode } from "react";
import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

const aggregationMock = vi.hoisted(() => {
  const resources: Array<{ dispose: ReturnType<typeof vi.fn> }> = [];
  const createPointAggregationIndex = vi.fn(() => {
    const resource = {
      dispose: vi.fn(),
      getClusterExpansionZoom: vi.fn(),
      getClusterLeaves: vi.fn(() => []),
      getPointById: vi.fn(() => null),
      getViewportAggregation: vi.fn(),
    };

    resources.push(resource);
    return resource;
  });

  return { createPointAggregationIndex, resources };
});

vi.mock("./aggregation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./aggregation")>();

  return {
    ...actual,
    createPointAggregationIndex: aggregationMock.createPointAggregationIndex,
  };
});

import { CanvasPointClusterLayer } from "./canvas-point-cluster-layer";

afterEach(() => {
  aggregationMock.createPointAggregationIndex.mockClear();
  aggregationMock.resources.length = 0;
});

describe("CanvasPointClusterLayer aggregation index lifetime", () => {
  test("keeps the committed index live across Strict Mode effect replay and disposes it on unmount", async () => {
    const { unmount } = render(
      <StrictMode>
        <CanvasPointClusterLayer
          points={[{ id: "berlin", latitude: 52.52, longitude: 13.405 }]}
        />
      </StrictMode>,
    );

    await act(async () => {
      await Promise.resolve();
    });

    const liveResource = aggregationMock.resources.at(-1);

    expect(liveResource).toBeTruthy();
    expect(liveResource?.dispose).not.toHaveBeenCalled();
    for (const resource of aggregationMock.resources.slice(0, -1)) {
      expect(resource.dispose).toHaveBeenCalledTimes(1);
    }

    unmount();
    await act(async () => {
      await Promise.resolve();
    });

    expect(liveResource?.dispose).toHaveBeenCalledTimes(1);
  });
});
