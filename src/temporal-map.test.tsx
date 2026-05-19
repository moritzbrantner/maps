import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { TemporalClusteredMap, type TemporalMapTrack } from ".";

const leafletMock = vi.hoisted(() => {
  type Handler = (...args: unknown[]) => void;
  type Layer = {
    latLng?: [number, number];
    options?: Record<string, unknown>;
    type: string;
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

    off() {}

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

  function createLayer(type: string, latLng?: [number, number], options?: Record<string, unknown>) {
    const layer: Layer & {
      addTo: (group: MockLayerGroup) => typeof layer;
      on: () => typeof layer;
    } = {
      latLng,
      options,
      type,
      addTo(group: MockLayerGroup) {
        group.addLayer(this);
        return this;
      },
      on() {
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
    polygon: (_latLngs: unknown, options: Record<string, unknown>) =>
      createLayer("polygon", undefined, options),
    polyline: (_latLngs: unknown, options: Record<string, unknown>) =>
      createLayer("polyline", undefined, options),
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

describe("@moritzbrantner/maps TemporalClusteredMap", () => {
  test("renders timeline controls and slices track points into the map overlay", async () => {
    const tracks: TemporalMapTrack<{ status: string }>[] = [
      {
        id: "courier-1",
        label: "Courier 1",
        frames: [
          {
            latitude: 10,
            longitude: 20,
            metrics: {
              load: 2,
            },
            properties: {
              status: "dispatching",
            },
            time: 0,
          },
          {
            latitude: 20,
            longitude: 40,
            metrics: {
              load: 6,
            },
            properties: {
              status: "en-route",
            },
            time: 10,
          },
        ],
      },
    ];

    render(
      <TemporalClusteredMap
        defaultTime={5}
        formatTimeLabel={(time) => `T${time}`}
        mapLabel="Courier timeline"
        showAttributionControl={false}
        timeStep={5}
        tracks={tracks}
      />,
    );

    expect(screen.getByLabelText("Courier timeline").getAttribute("data-map-ready")).toBe("false");
    expect((screen.getByRole("button", { name: "Play" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect(screen.getByText("T5")).toBeTruthy();
    expect((screen.getByRole("slider", { name: "Timeline" }) as HTMLInputElement).value).toBe("5");

    await waitFor(() => {
      expect(screen.getByLabelText("Courier timeline").getAttribute("data-map-ready")).toBe("true");
    });

    const pointMarker = leafletMock
      .getLayerGroups()[0]
      ?.layers.find((layer) => layer.options?.className === "mb-maps__point-marker");

    expect(pointMarker).toMatchObject({
      latLng: [15, 30],
      type: "circleMarker",
    });
  });

  test("snaps slider changes and reports the active time", async () => {
    const onTimeChange = vi.fn();
    const tracks: TemporalMapTrack[] = [
      {
        id: "courier-2",
        frames: [
          {
            latitude: 0,
            longitude: 0,
            time: 0,
          },
          {
            latitude: 10,
            longitude: 10,
            time: 20,
          },
        ],
      },
    ];

    render(
      <TemporalClusteredMap
        defaultTime={0}
        formatTimeLabel={(time) => `Minute ${time}`}
        onTimeChange={onTimeChange}
        timeStep={10}
        tracks={tracks}
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Interactive timeline map").getAttribute("data-map-ready")).toBe(
        "true",
      );
    });

    fireEvent.change(screen.getByRole("slider", { name: "Timeline" }), {
      target: {
        value: "17",
      },
    });

    expect((screen.getByRole("slider", { name: "Timeline" }) as HTMLInputElement).value).toBe("10");
    expect(screen.getByText("Minute 10")).toBeTruthy();
    await waitFor(() => {
      expect(onTimeChange).toHaveBeenLastCalledWith(10);
    });
  });
});
