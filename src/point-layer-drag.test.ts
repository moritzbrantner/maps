import { describe, expect, test, vi } from "vitest";

import { bindFlatPointDrag } from "./point-layer";

type Handler = (event?: Record<string, unknown>) => void;

function layer() {
  const handlers = new Map<string, Handler>();
  return {
    handlers,
    latLng: null as [number, number] | null,
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
      return this;
    },
    setLatLng(latLng: [number, number]) {
      this.latLng = latLng;
    },
  };
}

describe("flat point drag (#204)", () => {
  test("moves a point's label with the dragged circle", () => {
    const marker = layer();
    const label = layer();
    const mapHandlers = new Map<string, Handler>();
    const map = {
      dragging: { disable: vi.fn(), enable: vi.fn() },
      getContainer: () => ({ style: { cursor: "" } }),
      off: vi.fn(),
      on: (event: string, handler: Handler) => mapHandlers.set(event, handler),
    };
    const onFeatureDragEnd = vi.fn();
    bindFlatPointDrag(marker, {
      coordinates: [-74, 40],
      feature: "store-1",
      followers: () => [label],
      map,
      onFeatureDragEnd,
    });

    marker.handlers.get("mousedown")?.({ latlng: { lat: 40, lng: -74 }, point: { x: 0, y: 0 } });
    mapHandlers.get("mousemove")?.({ latlng: { lat: 41, lng: -73 }, point: { x: 20, y: 0 } });
    // An uncontrolled drag never rerenders the points: the label follows imperatively.
    expect(marker.latLng).toEqual([41, -73]);
    expect(label.latLng).toEqual([41, -73]);

    mapHandlers.get("mouseup")?.({ latlng: { lat: 42, lng: -72 }, point: { x: 40, y: 0 } });
    expect(label.latLng).toEqual([42, -72]);
    expect(onFeatureDragEnd).toHaveBeenCalledWith("store-1", [-72, 42]);
  });
});
