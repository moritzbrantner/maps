import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  ClusteredMap,
  createMapScopedTimelineClock,
  MapScopedTimelineControls,
  TemporalClusteredMap,
  TemporalHeatMap,
  type MapScopedTimelineClock,
  type MapSurfaceController,
  type TemporalMapTrack,
} from ".";
import { createManualTimelineScheduler } from "./test-timeline-scheduler";

const flatMock = vi.hoisted(() => {
  type Handler = (...args: unknown[]) => void;
  type Layer = {
    latLng?: [number, number];
    latLngs?: unknown;
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
    fitBoundsCalls = 0;
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

    fitBounds() {
      this.fitBoundsCalls += 1;
    }

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

  function createLayer(
    type: string,
    latLng?: [number, number],
    options?: Record<string, unknown>,
    latLngs?: unknown,
  ) {
    const layer: Layer & {
      addTo: (group: MockLayerGroup) => typeof layer;
      on: () => typeof layer;
    } = {
      latLng,
      latLngs,
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
    getFitBoundsCallCount: () =>
      maps.reduce((total, map) => total + map.fitBoundsCalls, 0),
    imageOverlay: (_url: string, latLngs: unknown, options: Record<string, unknown>) =>
      createLayer("imageOverlay", undefined, options, latLngs),
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

vi.mock("flat", () => flatMock);

afterEach(() => {
  flatMock.reset();
});

function getRenderedLayersByType(type: string) {
  return flatMock
    .getLayerGroups()
    .flatMap((group) => group.layers)
    .filter((layer) => layer.type === type);
}

function getRenderedGeoJsonLayersByType(type: string) {
  return getRenderedLayersByType(type).filter(
    (layer) => layer.options?.className === "mb-maps__geojson-feature",
  );
}

describe("@moritzbrantner/maps TemporalClusteredMap", () => {
  test("renders clustered points on the globe display", async () => {
    render(
      <ClusteredMap
        initialViewState={{ center: [13, 52], zoom: 2 }}
        mapDisplay="globe"
        mapLabel="Warehouse globe"
        points={[
          {
            id: "berlin",
            label: "Berlin",
            latitude: 52,
            longitude: 13,
          },
        ]}
      />,
    );

    const map = screen.getByLabelText("Warehouse globe");

    await waitFor(() => {
      expect(map.getAttribute("data-map-ready")).toBe("true");
      expect(map.querySelector(".mb-maps__canvas")).toBeTruthy();
      expect(map.querySelector(".mb-maps__globe")).toBeFalsy();
      expect(flatMock.getMaps()).toHaveLength(1);
      expect(flatMock.getLayerGroups().flatMap((group) => group.layers)).toEqual([
        expect.objectContaining({
          options: expect.objectContaining({
            className: "mb-maps__point-marker",
          }),
        }),
      ]);
    });
  });

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

    const pointMarker = flatMock
      .getLayerGroups()[0]
      ?.layers.find((layer) => layer.options?.className === "mb-maps__point-marker");

    expect(pointMarker).toMatchObject({
      latLng: [15, 30],
      type: "circleMarker",
    });
  });

  test("keeps a fixed viewport during timeline seeking when fit to data is disabled", async () => {
    const onViewStateChange = vi.fn();
    let controller: MapSurfaceController | null = null;
    const tracks: TemporalMapTrack[] = [
      {
        id: "courier-viewport",
        label: "Courier viewport",
        frames: [
          {
            latitude: 51,
            longitude: -0.1,
            time: 0,
          },
          {
            latitude: 60,
            longitude: 24,
            time: 120,
          },
        ],
      },
    ];

    render(
      <TemporalClusteredMap
        defaultTime={0}
        fitToData={false}
        initialViewState={{ center: [8.8, 51], zoom: 4.2 }}
        mapLabel="Stable timeline"
        onMapControllerReady={(nextController) => {
          controller = nextController;
        }}
        onViewStateChange={onViewStateChange}
        showAttributionControl={false}
        timeStep={1}
        tracks={tracks}
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Stable timeline").getAttribute("data-map-ready")).toBe("true");
    });
    await waitFor(() => {
      expect(controller).not.toBeNull();
    });

    expect(flatMock.getFitBoundsCallCount()).toBe(0);

    fireEvent.change(screen.getByRole("slider", { name: "Timeline" }), {
      target: {
        value: "70",
      },
    });

    expect((screen.getByRole("slider", { name: "Timeline" }) as HTMLInputElement).value).toBe(
      "70",
    );
    await waitFor(() => {
      const pointMarker = flatMock
        .getLayerGroups()[0]
        ?.layers.find((layer) => layer.options?.className === "mb-maps__point-marker");

      expect(pointMarker?.latLng?.[0]).toBeCloseTo(56.25, 6);
      expect(pointMarker?.latLng?.[1]).toBeCloseTo(13.958333, 6);
    });
    expect(flatMock.getFitBoundsCallCount()).toBe(0);

    act(() => {
      controller!.setViewState({ center: [9, 52], zoom: 5 }, "programmatic");
    });

    expect(onViewStateChange).toHaveBeenLastCalledWith(
      { center: [9, 52], zoom: 5 },
      { display: "flat", reason: "programmatic" },
    );
  });

  test("derives temporal points from GeoJSON and renders synchronized geometry overlays", async () => {
    render(
      <TemporalClusteredMap
        defaultTime={0}
        geoJson={{
          features: [
            {
              geometry: {
                coordinates: [20, 10],
                type: "Point",
              },
              id: "courier-geojson",
              properties: {
                time: 0,
                trackId: "courier-geojson",
              },
              type: "Feature",
            },
            {
              geometry: {
                coordinates: [
                  [
                    [18, 8],
                    [22, 8],
                    [22, 12],
                    [18, 8],
                  ],
                ],
                type: "Polygon",
              },
              id: "service-zone",
              properties: {
                time: 0,
                trackId: "service-zone",
              },
              type: "Feature",
            },
          ],
          type: "FeatureCollection",
        }}
        mapLabel="GeoJSON timeline"
        showAttributionControl={false}
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("GeoJSON timeline").getAttribute("data-map-ready")).toBe("true");
    });

    expect(
      flatMock
        .getLayerGroups()
        .flatMap((group) => group.layers)
        .map((layer) => layer.type),
    ).toEqual(expect.arrayContaining(["polygon", "circleMarker"]));
  });

  test("extends clustered playback range with temporal GeoJSON overlay frames", async () => {
    render(
      <TemporalClusteredMap
        defaultTime={0}
        geoJson={{
          features: [
            {
              geometry: {
                coordinates: [
                  [20, 20],
                  [30, 30],
                ],
                type: "LineString",
              },
              properties: {
                time: 20,
                trackId: "late-corridor",
              },
              type: "Feature",
            },
            {
              geometry: {
                coordinates: [
                  [25, 25],
                  [35, 35],
                ],
                type: "LineString",
              },
              properties: {
                time: 30,
                trackId: "late-corridor",
              },
              type: "Feature",
            },
          ],
          type: "FeatureCollection",
        }}
        showAttributionControl={false}
        tracks={[
          {
            id: "courier-short",
            frames: [
              { latitude: 0, longitude: 0, time: 0 },
              { latitude: 10, longitude: 10, time: 10 },
            ],
          },
        ]}
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Interactive timeline map").getAttribute("data-map-ready")).toBe(
        "true",
      );
    });

    expect((screen.getByRole("slider", { name: "Timeline" }) as HTMLInputElement).max).toBe("30");
  });

  test("plays temporal GeoJSON overlays without point tracks", async () => {
    render(
      <TemporalClusteredMap
        geoJson={{
          features: [
            {
              geometry: {
                coordinates: [
                  [
                    [0, 0],
                    [4, 0],
                    [4, 4],
                    [0, 4],
                    [0, 0],
                  ],
                ],
                type: "Polygon",
              },
              properties: {
                time: 20,
                trackId: "overlay-only",
              },
              type: "Feature",
            },
            {
              geometry: {
                coordinates: [
                  [
                    [2, 2],
                    [6, 2],
                    [6, 6],
                    [2, 6],
                    [2, 2],
                  ],
                ],
                type: "Polygon",
              },
              properties: {
                time: 30,
                trackId: "overlay-only",
              },
              type: "Feature",
            },
          ],
          type: "FeatureCollection",
        }}
        showAttributionControl={false}
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Interactive timeline map").getAttribute("data-map-ready")).toBe(
        "true",
      );
    });

    const slider = screen.getByRole("slider", { name: "Timeline" }) as HTMLInputElement;

    expect(slider.min).toBe("20");
    expect(slider.max).toBe("30");
    expect((screen.getByRole("button", { name: "Play" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect(getRenderedGeoJsonLayersByType("polygon")).toHaveLength(1);
  });

  test("hides, interpolates, and removes temporal GeoJSON overlays while seeking", async () => {
    render(
      <TemporalClusteredMap
        defaultTime={0}
        geoJson={{
          features: [
            {
              geometry: {
                coordinates: [
                  [
                    [0, 0],
                    [4, 0],
                    [4, 4],
                    [0, 4],
                    [0, 0],
                  ],
                ],
                type: "Polygon",
              },
              properties: {
                time: 20,
                trackId: "changing-zone",
              },
              type: "Feature",
            },
            {
              geometry: {
                coordinates: [
                  [
                    [10, 10],
                    [14, 10],
                    [14, 14],
                    [10, 14],
                    [10, 10],
                  ],
                ],
                type: "Polygon",
              },
              properties: {
                time: 30,
                trackId: "changing-zone",
              },
              type: "Feature",
            },
            {
              geometry: {
                coordinates: [
                  [
                    [10, 10],
                    [14, 10],
                    [14, 14],
                    [10, 14],
                    [10, 10],
                  ],
                ],
                type: "Polygon",
              },
              properties: {
                time: 40,
                trackId: "changing-zone",
                visible: false,
              },
              type: "Feature",
            },
          ],
          type: "FeatureCollection",
        }}
        showAttributionControl={false}
        tracks={[
          {
            id: "courier-window",
            frames: [
              { latitude: 0, longitude: 0, time: 0 },
              { latitude: 10, longitude: 10, time: 40 },
            ],
          },
        ]}
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Interactive timeline map").getAttribute("data-map-ready")).toBe(
        "true",
      );
    });

    expect(getRenderedGeoJsonLayersByType("polygon")).toHaveLength(0);

    fireEvent.change(screen.getByRole("slider", { name: "Timeline" }), {
      target: {
        value: "25",
      },
    });

    await waitFor(() => {
      const interpolatedRing = getRenderedGeoJsonLayersByType("polygon")[0]?.latLngs as
        | Array<Array<[number, number]>>
        | undefined;

      expect(interpolatedRing?.[0]?.[0]).toEqual([5, 5]);
      expect(interpolatedRing?.[0]?.[1]).toEqual([5, 9]);
    });

    fireEvent.change(screen.getByRole("slider", { name: "Timeline" }), {
      target: {
        value: "40",
      },
    });

    await waitFor(() => {
      expect(getRenderedGeoJsonLayersByType("polygon")).toHaveLength(0);
    });
  });

  test("extends heat map playback range with temporal GeoJSON overlay frames", async () => {
    render(
      <TemporalHeatMap
        defaultTime={0}
        geoJson={{
          features: [
            {
              geometry: {
                coordinates: [
                  [
                    [20, 20],
                    [30, 20],
                    [30, 30],
                    [20, 30],
                    [20, 20],
                  ],
                ],
                type: "Polygon",
              },
              properties: {
                time: 20,
                trackId: "heat-zone",
              },
              type: "Feature",
            },
            {
              geometry: {
                coordinates: [
                  [
                    [25, 25],
                    [35, 25],
                    [35, 35],
                    [25, 35],
                    [25, 25],
                  ],
                ],
                type: "Polygon",
              },
              properties: {
                time: 30,
                trackId: "heat-zone",
              },
              type: "Feature",
            },
          ],
          type: "FeatureCollection",
        }}
        showAttributionControl={false}
        tracks={[
          {
            id: "heat-point-short",
            frames: [
              { latitude: 0, longitude: 0, time: 0 },
              { latitude: 10, longitude: 10, time: 10 },
            ],
          },
        ]}
      />,
    );

    await waitFor(() => {
      expect(
        screen.getByLabelText("Interactive temporal heat map").getAttribute("data-map-ready"),
      ).toBe("true");
    });

    expect((screen.getByRole("slider", { name: "Timeline" }) as HTMLInputElement).max).toBe("30");
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

    fireEvent.click(screen.getByRole("button", { name: "Next time step" }));

    expect((screen.getByRole("slider", { name: "Timeline" }) as HTMLInputElement).value).toBe("20");
    expect(screen.getAllByText("Minute 20").length).toBeGreaterThan(0);
    await waitFor(() => {
      expect(onTimeChange).toHaveBeenLastCalledWith(20);
    });

    fireEvent.click(screen.getByRole("button", { name: "Jump to start" }));

    expect((screen.getByRole("slider", { name: "Timeline" }) as HTMLInputElement).value).toBe("0");
    expect(screen.getAllByText("Minute 0").length).toBeGreaterThan(0);
  });
});

/**
 * #172 Correct: an independent, deliberately straightforward sampler. It shares no code with
 * the prepared playback index: a linear scan over each track's sorted valid keyframes.
 */
function naiveSample(tracks: readonly TemporalMapTrack[], time: number) {
  const samples: Array<{ id: string; latitude: number; longitude: number }> = [];

  tracks.forEach((track, trackIndex) => {
    const frames = track.frames
      .filter((frame) => [frame.time, frame.latitude, frame.longitude].every(Number.isFinite))
      .slice()
      .sort((left, right) => left.time - right.time);
    let previous: (typeof frames)[number] | undefined;
    let next: (typeof frames)[number] | undefined;

    for (const frame of frames) {
      if (frame.time <= time) {
        previous = frame;
      } else {
        next = frame;
        break;
      }
    }

    if (!previous || previous.visible === false) {
      return;
    }

    const progress = next && previous.time !== time ? (time - previous.time) / (next.time - previous.time) : 0;
    const target = next ?? previous;

    samples.push({
      id: String(track.id ?? trackIndex),
      latitude: previous.latitude + (target.latitude - previous.latitude) * progress,
      longitude: previous.longitude + (target.longitude - previous.longitude) * progress,
    });
  });

  return samples;
}

const PARITY_TRACKS: TemporalMapTrack[] = [
  {
    frames: [
      { latitude: 10, longitude: 20, time: 0 },
      { latitude: 30, longitude: 60, time: 40 },
      { latitude: 0, longitude: 80, time: 100 },
    ],
    id: "track-a",
  },
  {
    // Admitted at 20, removed by an invisible keyframe at 60.
    frames: [
      { latitude: -20, longitude: -40, time: 20 },
      { latitude: -10, longitude: -20, time: 45 },
      { latitude: -10, longitude: -20, time: 60, visible: false },
    ],
    id: "track-b",
  },
  {
    // Ends early and holds its last keyframe.
    frames: [
      { latitude: 40, longitude: 0, time: 0 },
      { latitude: 50, longitude: 10, time: 50 },
    ],
    id: "track-c",
  },
];
const PARITY_SELECTED_ID = "track-b";

function renderedPointMarkers() {
  return getRenderedLayersByType("circleMarker")
    .filter((layer) => String(layer.options?.className).includes("mb-maps__point-marker"))
    .map((layer) => ({
      latitude: layer.latLng![0],
      longitude: layer.latLng![1],
      selected: String(layer.options?.className).includes("mb-maps__feature--selected"),
    }));
}

function expectedPointMarkers(time: number) {
  return naiveSample(PARITY_TRACKS, time).map((sample) => ({
    latitude: expect.closeTo(sample.latitude, 9),
    longitude: expect.closeTo(sample.longitude, 9),
    selected: sample.id === PARITY_SELECTED_ID,
  }));
}

describe("Map-Scoped Timeline parity (#172)", () => {
  // Every target is a multiple of the 2.5-unit playback step, so playback lands on it exactly.
  const targets = [0, 12.5, 20, 35, 47.5, 60, 72.5, 100];
  const FRAME_MS = 250;

  async function renderParityMap() {
    const frames = createManualTimelineScheduler();
    const clock = createMapScopedTimelineClock({
      loop: false,
      playbackRate: 10,
      scheduler: frames.scheduler,
    });

    render(
      <TemporalClusteredMap
        fitToData={false}
        mapLabel="Parity timeline"
        selectedFeatureId={PARITY_SELECTED_ID}
        showAttributionControl={false}
        timeline={clock}
        tracks={PARITY_TRACKS}
      />,
    );
    await waitFor(() => {
      expect(screen.getByLabelText("Parity timeline").getAttribute("data-map-ready")).toBe("true");
    });

    let timestamp = 0;
    const observe = async (time: number) => {
      expect(clock.getSnapshot().activeTime).toBe(time);
      await waitFor(() => {
        expect(renderedPointMarkers()).toEqual(expectedPointMarkers(time));
      });
      return renderedPointMarkers();
    };
    const playTo = async (time: number) => {
      if (!clock.getSnapshot().isPlaying) {
        act(() => clock.play());
        act(() => frames.frame((timestamp += FRAME_MS)));
      }
      while (clock.getSnapshot().time < time) {
        act(() => frames.frame((timestamp += FRAME_MS)));
      }
      return observe(time);
    };
    const seek = (time: number) => {
      act(() => clock.seek(time));
      return observe(time);
    };

    return { clock, frames, playTo, seek };
  }

  test("direct seek, forward playback and backward seek with resume sample identically", async () => {
    const { clock, frames, playTo, seek } = await renderParityMap();
    const direct = new Map<number, ReturnType<typeof renderedPointMarkers>>();

    for (const time of targets) {
      direct.set(time, await seek(time));
    }

    // Forward playback from the start reaches every target with the directly seeked state.
    await seek(0);
    for (const time of targets.slice(1)) {
      expect(await playTo(time)).toEqual(direct.get(time));
    }
    expect(clock.getSnapshot().isPlaying).toBe(false);
    expect(frames.pending).toBe(false);

    // Backward seek while playing, then pause, resume and play forward again.
    await seek(0);
    expect(await playTo(72.5)).toEqual(direct.get(72.5));
    expect(await seek(20)).toEqual(direct.get(20));
    act(() => clock.pause());
    expect(await seek(12.5)).toEqual(direct.get(12.5));
    for (const time of [20, 35, 47.5, 60]) {
      expect(await playTo(time)).toEqual(direct.get(time));
    }
  });

  test("TemporalClusteredMap and TemporalHeatMap sample one shared clock and frame loop", async () => {
    const frames = createManualTimelineScheduler();
    const clock: MapScopedTimelineClock = createMapScopedTimelineClock({
      playbackRate: 10,
      scheduler: frames.scheduler,
    });

    render(
      <>
        <TemporalClusteredMap
          fitToData={false}
          mapLabel="Shared points"
          showAttributionControl={false}
          showPlaybackControls={false}
          timeline={clock}
          tracks={PARITY_TRACKS.slice(0, 1)}
        />
        <TemporalHeatMap
          fitToData={false}
          mapLabel="Shared heat"
          showAttributionControl={false}
          showPlaybackControls={false}
          timeline={clock}
          tracks={PARITY_TRACKS.slice(1)}
        />
        <MapScopedTimelineControls timeline={clock} timelineLabel="Shared timeline" />
      </>,
    );

    // The merged range spans both consumers' data.
    expect(clock.getSnapshot().timeRange).toEqual({ end: 100, start: 0 });

    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    const requestsBefore = frames.requests;
    act(() => frames.frame(0));
    act(() => frames.frame(FRAME_MS));
    act(() => frames.frame(FRAME_MS * 2));

    // One frame request per frame for both Map Views: no per-layer loop.
    expect(frames.requests - requestsBefore).toBe(3);
    expect(clock.getSnapshot().time).toBe(5);
    expect((screen.getByRole("slider", { name: "Shared timeline" }) as HTMLInputElement).value).toBe("5");

    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(frames.pending).toBe(false);
    expect(clock.getSnapshot()).toMatchObject({ isPlaying: false, time: 5 });
  });

  test("application-controlled time drives the compatibility currentTime prop", async () => {
    const onTimeChange = vi.fn();
    const { rerender } = render(
      <TemporalClusteredMap
        currentTime={20}
        mapLabel="Controlled timeline"
        onTimeChange={onTimeChange}
        showAttributionControl={false}
        tracks={PARITY_TRACKS}
      />,
    );

    expect((screen.getByRole("slider", { name: "Timeline" }) as HTMLInputElement).value).toBe("20");

    fireEvent.change(screen.getByRole("slider", { name: "Timeline" }), { target: { value: "40" } });

    await waitFor(() => {
      expect(onTimeChange).toHaveBeenLastCalledWith(40);
    });
    // The application has not accepted the request yet, so the map keeps its time.
    expect((screen.getByRole("slider", { name: "Timeline" }) as HTMLInputElement).value).toBe("20");

    rerender(
      <TemporalClusteredMap
        currentTime={40}
        mapLabel="Controlled timeline"
        onTimeChange={onTimeChange}
        showAttributionControl={false}
        tracks={PARITY_TRACKS}
      />,
    );

    expect((screen.getByRole("slider", { name: "Timeline" }) as HTMLInputElement).value).toBe("40");
  });
});
