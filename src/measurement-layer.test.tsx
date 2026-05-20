import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  ClusteredMap,
  FlowMap,
  HeatMap,
  PointMap,
  TemporalClusteredMap,
  TemporalHeatMap,
  type MapBeeLineMeasurement,
  type TemporalMapTrack,
} from ".";

const leafletMock = vi.hoisted(() => {
  type Handler = (...args: unknown[]) => void;
  type Layer = {
    handlers: Map<string, Handler[]>;
    latLng?: [number, number];
    latLngs?: unknown;
    options?: Record<string, unknown>;
    tooltip?: {
      content: string;
      latLng?: [number, number];
      options?: Record<string, unknown>;
    };
    type: string;
    fire: (event: string, payload?: unknown) => void;
  };

  const maps: MockMap[] = [];
  const layerGroups: MockLayerGroup[] = [];

  class MockLayerGroup {
    layers: Layer[] = [];

    constructor() {
      layerGroups.push(this);
    }

    addLayer(layer: Layer) {
      this.layers.push(layer);
    }

    addTo() {
      return this;
    }

    clearLayers() {
      this.layers = [];
    }
  }

  class MockMap {
    handlers = new Map<string, Handler[]>();
    removed = false;
    zoom = 6;

    constructor() {
      maps.push(this);
    }

    container = {
      clientHeight: 640,
      clientWidth: 960,
      style: {
        cursor: "",
      },
    };

    containerPointToLatLng([x, y]: [number, number]) {
      return {
        lat: 90 - y / 2,
        lng: x / 2 - 180,
      };
    }

    fire(event: string, payload?: unknown) {
      for (const handler of this.handlers.get(event) ?? []) {
        handler(payload);
      }
    }

    fitBounds() {}

    getBounds() {
      return {
        getEast: () => 180,
        getNorth: () => 90,
        getSouth: () => -90,
        getWest: () => -180,
      };
    }

    getContainer() {
      return this.container;
    }

    getZoom() {
      return this.zoom;
    }

    latLngToContainerPoint([lat, lng]: [number, number]) {
      return {
        x: (lng + 180) * 2,
        y: (90 - lat) * 2,
      };
    }

    off(event: string, handler: Handler) {
      const handlers = this.handlers.get(event) ?? [];

      this.handlers.set(
        event,
        handlers.filter((current) => current !== handler),
      );
    }

    on(event: string, handler: Handler) {
      const handlers = this.handlers.get(event) ?? [];

      handlers.push(handler);
      this.handlers.set(event, handlers);
    }

    remove() {
      this.removed = true;
    }

    setView(_latLng: [number, number], zoom: number) {
      this.zoom = zoom;
    }
  }

  function createLayer(
    type: string,
    latLng?: [number, number],
    options?: Record<string, unknown>,
    latLngs?: unknown,
  ) {
    const layer: Layer & {
      addTo: (group: MockLayerGroup) => typeof layer;
      bindTooltip: (content: string, tooltipOptions?: Record<string, unknown>) => typeof layer;
      on: (event: string, handler: Handler) => typeof layer;
      openTooltip: (latLng?: [number, number]) => typeof layer;
    } = {
      handlers: new Map<string, Handler[]>(),
      latLng,
      latLngs,
      options,
      type,
      addTo(group: MockLayerGroup) {
        group.addLayer(this);
        return this;
      },
      bindTooltip(content: string, tooltipOptions?: Record<string, unknown>) {
        this.tooltip = {
          content,
          options: tooltipOptions,
        };
        return this;
      },
      fire(event: string, payload?: unknown) {
        for (const handler of this.handlers.get(event) ?? []) {
          handler(payload);
        }
      },
      on(event: string, handler: Handler) {
        const handlers = this.handlers.get(event) ?? [];

        handlers.push(handler);
        this.handlers.set(event, handlers);
        return this;
      },
      openTooltip(latLng?: [number, number]) {
        if (this.tooltip) {
          this.tooltip.latLng = latLng;
        }

        return this;
      },
    };

    return layer;
  }

  return {
    circleMarker: (latLng: [number, number], options: Record<string, unknown>) =>
      createLayer("circleMarker", latLng, options),
    divIcon: (options: Record<string, unknown>) => options,
    getLayerGroups: () => layerGroups,
    getMaps: () => maps,
    layerGroup: () => new MockLayerGroup(),
    map: () => new MockMap(),
    marker: (latLng: [number, number], options: Record<string, unknown>) =>
      createLayer("marker", latLng, options),
    polygon: (latLngs: unknown, options: Record<string, unknown>) =>
      createLayer("polygon", undefined, options, latLngs),
    polyline: (latLngs: unknown, options: Record<string, unknown>) =>
      createLayer("polyline", undefined, options, latLngs),
    reset: () => {
      maps.length = 0;
      layerGroups.length = 0;
    },
    tileLayer: () => ({
      addTo() {
        return this;
      },
    }),
  };
});

vi.mock("leaflet", () => leafletMock);

afterEach(() => {
  leafletMock.reset();
});

describe("@moritzbrantner/maps bee-line measurement layer", () => {
  test("PointMap creates a measurement after two map clicks", async () => {
    const onMeasurementCreate = vi.fn();

    render(
      <PointMap
        measurementMode="bee-line"
        onMeasurementCreate={onMeasurementCreate}
        points={[]}
      />,
    );

    const map = await waitForReadyMap("Interactive point map");

    act(() => {
      map.fire("click", { latlng: { lat: 52.52, lng: 13.405 } });
      map.fire("click", { latlng: { lat: 48.8566, lng: 2.3522 } });
    });

    expect(onMeasurementCreate).toHaveBeenCalledTimes(1);
    expect(onMeasurementCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        formattedDistance: "877.5 km",
        from: [13.405, 52.52],
        to: [2.3522, 48.8566],
      }),
    );
  });

  test("draft callback receives start point, moving endpoint, then null after completion", async () => {
    const onMeasurementDraftChange = vi.fn();

    render(
      <PointMap
        measurementMode="bee-line"
        onMeasurementDraftChange={onMeasurementDraftChange}
        points={[]}
      />,
    );

    const map = await waitForReadyMap("Interactive point map");

    act(() => {
      map.fire("click", { latlng: { lat: 10, lng: 20 } });
      map.fire("mousemove", { latlng: { lat: 11, lng: 21 } });
      map.fire("click", { latlng: { lat: 12, lng: 22 } });
    });

    expect(onMeasurementDraftChange).toHaveBeenNthCalledWith(1, { from: [20, 10] });
    expect(onMeasurementDraftChange).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        from: [20, 10],
        to: [21, 11],
      }),
    );
    expect(onMeasurementDraftChange).toHaveBeenLastCalledWith(null);
  });

  test("completed measurements prop renders a measurement polyline and label", async () => {
    const measurements: MapBeeLineMeasurement[] = [
      {
        id: "berlin-paris",
        from: [13.405, 52.52],
        to: [2.3522, 48.8566],
      },
    ];

    render(<PointMap measurements={measurements} points={[]} />);

    await waitForReadyMap("Interactive point map");

    const measurementLayer = leafletMock.getLayerGroups()[1];
    const line = measurementLayer?.layers.find(
      (layer) => layer.options?.className === "mb-maps__measurement-line",
    );

    expect(line).toMatchObject({
      tooltip: {
        content: "877.5 km",
      },
      type: "polyline",
    });
  });

  test("Escape clears an active draft", async () => {
    const onMeasurementDraftChange = vi.fn();

    render(
      <PointMap
        measurementMode="bee-line"
        onMeasurementDraftChange={onMeasurementDraftChange}
        points={[]}
      />,
    );

    const map = await waitForReadyMap("Interactive point map");

    act(() => {
      map.fire("click", { latlng: { lat: 10, lng: 20 } });
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });

    expect(onMeasurementDraftChange).toHaveBeenLastCalledWith(null);
  });

  test("data feature selection is suppressed while measuring", async () => {
    const onFeatureSelect = vi.fn();

    render(
      <PointMap
        measurementMode="bee-line"
        onFeatureSelect={onFeatureSelect}
        points={[
          {
            id: "store",
            latitude: 10,
            longitude: 20,
          },
        ]}
      />,
    );

    await waitForReadyMap("Interactive point map");

    const pointMarker = leafletMock
      .getLayerGroups()[0]
      ?.layers.find((layer) => layer.options?.className === "mb-maps__point-marker");

    expect(pointMarker?.options?.interactive).toBe(false);

    act(() => {
      pointMarker?.fire("click");
    });

    expect(onFeatureSelect).not.toHaveBeenCalled();
  });

  test("ClusteredMap, FlowMap, and HeatMap create a measurement layer without breaking overlays", async () => {
    const clustered = render(
      <ClusteredMap
        measurementMode="bee-line"
        points={[
          {
            id: "point",
            latitude: 10,
            longitude: 20,
          },
        ]}
      />,
    );
    await waitForReadyMap("Interactive map");
    expect(leafletMock.getLayerGroups()).toHaveLength(2);
    expect(leafletMock.getLayerGroups()[0]?.layers.length).toBeGreaterThan(0);
    clustered.unmount();
    leafletMock.reset();

    const flow = render(
      <FlowMap
        flows={[
          {
            id: "flow",
            from: [20, 10],
            to: [21, 11],
          },
        ]}
        measurementMode="bee-line"
      />,
    );
    await waitForReadyMap("Interactive flow map");
    expect(leafletMock.getLayerGroups()).toHaveLength(2);
    expect(leafletMock.getLayerGroups()[0]?.layers.length).toBeGreaterThan(0);
    flow.unmount();
    leafletMock.reset();

    render(
      <HeatMap
        measurementMode="bee-line"
        points={[
          {
            id: "heat",
            latitude: 10,
            longitude: 20,
          },
        ]}
      />,
    );
    await waitForReadyMap("Interactive heat map");
    expect(leafletMock.getLayerGroups()).toHaveLength(2);
    expect(leafletMock.getLayerGroups()[0]?.layers.length).toBeGreaterThan(0);
  });

  test("temporal wrappers pass measurement props through to their flat maps", async () => {
    const tracks: TemporalMapTrack[] = [
      {
        id: "track",
        frames: [
          {
            latitude: 10,
            longitude: 20,
            time: 0,
          },
        ],
      },
    ];
    const clusteredCreate = vi.fn();
    const heatCreate = vi.fn();

    const clustered = render(
      <TemporalClusteredMap
        measurementMode="bee-line"
        onMeasurementCreate={clusteredCreate}
        showPlaybackControls={false}
        tracks={tracks}
      />,
    );
    const clusteredMap = await waitForReadyMap("Interactive timeline map");

    act(() => {
      clusteredMap.fire("click", { latlng: { lat: 10, lng: 20 } });
      clusteredMap.fire("click", { latlng: { lat: 11, lng: 21 } });
    });

    expect(clusteredCreate).toHaveBeenCalledTimes(1);
    clustered.unmount();
    leafletMock.reset();

    render(
      <TemporalHeatMap
        measurementMode="bee-line"
        onMeasurementCreate={heatCreate}
        showPlaybackControls={false}
        tracks={tracks}
      />,
    );
    const heatMap = await waitForReadyMap("Interactive temporal heat map");

    act(() => {
      heatMap.fire("click", { latlng: { lat: 10, lng: 20 } });
      heatMap.fire("click", { latlng: { lat: 11, lng: 21 } });
    });

    expect(heatCreate).toHaveBeenCalledTimes(1);
  });
});

async function waitForReadyMap(label: string) {
  await waitFor(() => {
    expect(screen.getByLabelText(label).getAttribute("data-map-ready")).toBe("true");
  });

  return leafletMock.getMaps().at(-1)!;
}
