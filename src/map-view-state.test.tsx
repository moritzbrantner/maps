import { act, renderHook } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";

import { useControllableMapViewState } from "./map-view-state";

describe("useControllableMapViewState runtime constraints", () => {
  test("retains and updates a renderer-derived minimum zoom above maxZoom", () => {
    const onViewStateChange = vi.fn();
    const { result } = renderHook(() =>
      useControllableMapViewState({
        defaultViewState: { center: [0, 0], zoom: 5 },
        display: "flat",
        maxZoom: 5,
        onViewStateChange,
      }),
    );

    act(() => {
      result.current.setViewState({ center: [0, 0], zoom: 8 }, "initial");
    });
    expect(result.current.viewState.zoom).toBe(8);

    act(() => {
      result.current.setViewState({ center: [1, 2], zoom: 6 }, "zoom");
    });
    expect(result.current.viewState).toEqual({ center: [1, 2], zoom: 6 });

    act(() => {
      result.current.setViewState({ center: [3, 4], zoom: 10 }, "programmatic");
    });
    expect(result.current.viewState).toEqual({ center: [3, 4], zoom: 6 });

    act(() => {
      result.current.setViewState({ center: [3, 4], zoom: 5 }, "prop-change");
    });
    expect(result.current.viewState).toEqual({ center: [3, 4], zoom: 5 });
  });

  test("reports the renderer-derived effective zoom for controlled state", () => {
    const onViewStateChange = vi.fn();
    const { result, rerender } = renderHook(
      ({ viewState }) =>
        useControllableMapViewState({
          display: "flat",
          maxZoom: 5,
          onViewStateChange,
          viewState,
        }),
      { initialProps: { viewState: { center: [0, 0] as [number, number], zoom: 5 } } },
    );

    act(() => {
      result.current.setViewState({ center: [0, 0], zoom: 8 }, "initial");
    });
    expect(result.current.viewState.zoom).toBe(8);

    rerender({ viewState: { center: [0, 0], zoom: 10 } });
    expect(result.current.viewState.zoom).toBe(8);
  });
});
