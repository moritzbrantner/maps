import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  createMapScopedTimelineClock,
  createPointAggregationIndex,
  GeoJsonLayer,
  TemporalClusteredMap,
  TemporalHeatMap,
  type TemporalMapTrack,
  type VisibleAggregationSummary,
} from ".";
import {
  resetMapsAggregationRuntimeForTests,
  setMapsAggregationWasmRuntimeForTests,
} from "./aggregation-runtime";
import { observeHeatLayerWork } from "./heat-layer-work";
import { createGridAggregationRuntimeForTests } from "./test-aggregation-runtime";
import { sampleTemporalPointsNaively } from "./test-temporal-oracle";
import { createManualTimelineScheduler } from "./test-timeline-scheduler";
import { resetMapsTemporalWasmRuntimeForTests } from "./temporal-points-wasm";

/*
 * #172 phase D: temporal clustering and heat composed over static regions on the first-party
 * Flat Map (`flatRuntime="maps"`), sampled from one Map-Scoped Timeline clock.
 */

vi.mock("./canvas-flat-runtime", async () => {
  const React = await import("react");

  type ViewState = { center: [number, number]; zoom: number };
  type Controller = {
    fitBounds: () => void;
    getViewState: () => ViewState;
    getVisibleBounds: () => [number, number, number, number];
    getVisibleSpansFullWorld: () => boolean;
    project: (coordinates: [number, number]) => { x: number; y: number };
    projectPacked: (coordinates: Float64Array) => Float64Array;
    setViewState: (viewState: ViewState) => void;
    unproject: (x: number, y: number) => [number, number];
  };
  type Props = {
    viewState: ViewState;
    onControllerReady?: (controller: Controller | null) => void;
    onReady?: () => void;
  };

  function MockMapsCanvasFlatRuntime(props: Props) {
    React.useEffect(() => {
      const controller: Controller = {
        fitBounds() {},
        getViewState: () => props.viewState,
        getVisibleBounds: () => [-60, -40, 60, 40],
        getVisibleSpansFullWorld: () => false,
        project: ([longitude, latitude]) => ({
          x: 400 + longitude * 10,
          y: 300 - latitude * 10,
        }),
        projectPacked(coordinates) {
          const projected = new Float64Array(coordinates.length);
          for (let index = 0; index < coordinates.length; index += 2) {
            projected[index] = 400 + coordinates[index]! * 10;
            projected[index + 1] = 300 - coordinates[index + 1]! * 10;
          }
          return projected;
        },
        setViewState() {},
        unproject: (x, y) => [(x - 400) / 10, (300 - y) / 10],
      };

      props.onControllerReady?.(controller);
      props.onReady?.();
      return () => props.onControllerReady?.(null);
    }, []);

    return <canvas data-flat-runtime="maps" />;
  }

  return { MapsCanvasFlatRuntime: MockMapsCanvasFlatRuntime };
});

const heatWork = observeHeatLayerWork();

beforeEach(() => {
  setMapsAggregationWasmRuntimeForTests(createGridAggregationRuntimeForTests());
});

afterEach(() => {
  resetMapsAggregationRuntimeForTests();
  resetMapsTemporalWasmRuntimeForTests();
});

/**
 * Three couriers converge on (10, 10) at time 50 and separate again; a fourth is admitted at
 * time 60. At zoom 4 the converged couriers cluster and the separated ones do not.
 */
const TRACKS: TemporalMapTrack[] = [
  {
    frames: [
      { latitude: 10, longitude: -10, metrics: { cargo: 1 }, time: 0 },
      { latitude: 10, longitude: 30, metrics: { cargo: 1 }, time: 100 },
    ],
    id: "west",
    label: "West",
  },
  {
    frames: [
      { latitude: 10, longitude: 30, metrics: { cargo: 2 }, time: 0 },
      { latitude: 10, longitude: -10, metrics: { cargo: 2 }, time: 100 },
    ],
    id: "east",
    label: "East",
  },
  {
    frames: [
      { latitude: -10, longitude: 10, metrics: { cargo: 4 }, time: 0 },
      { latitude: 30, longitude: 10, metrics: { cargo: 4 }, time: 100 },
    ],
    id: "south",
    label: "South",
  },
  {
    frames: [
      { latitude: -20, longitude: -30, metrics: { cargo: 8 }, time: 60 },
      { latitude: -20, longitude: -20, metrics: { cargo: 8 }, time: 100 },
    ],
    id: "late",
    label: "Late",
  },
];

const STATIC_REGION: GeoJSON.FeatureCollection<GeoJSON.Polygon> = {
  features: [
    {
      geometry: {
        coordinates: [
          [
            [-40, -30],
            [40, -30],
            [40, 30],
            [-40, 30],
            [-40, -30],
          ],
        ],
        type: "Polygon",
      },
      id: "static-region",
      properties: {},
      type: "Feature",
    },
  ],
  type: "FeatureCollection",
};

const VIEW_STATE = { center: [0, 0] as [number, number], zoom: 4 };
const MAP_STYLE = { tiles: false } as const;
// Every target is a multiple of the 2.5-unit playback step, so playback lands on it exactly.
const TARGETS = [0, 25, 47.5, 50, 52.5, 60, 75, 100];
const FRAME_MS = 250;

/** Clustering of the independently sampled points at `time` over the Map View's viewport. */
function expectedSummary(
  time: number,
  viewport: Pick<VisibleAggregationSummary, "bounds" | "zoom">,
) {
  const index = createPointAggregationIndex(
    sampleTemporalPointsNaively(TRACKS, time),
  );
  try {
    return comparableSummary(index.getViewportAggregation(viewport).summary);
  } finally {
    index.dispose();
  }
}

function comparableSummary(summary: VisibleAggregationSummary) {
  return {
    cargo: Number((summary.metrics.cargo ?? 0).toFixed(6)),
    visibleClusterCount: summary.visibleClusterCount,
    visiblePointCount: summary.visiblePointCount,
    visibleUnclusteredCount: summary.visibleUnclusteredCount,
  };
}

function overlayOf(label: string) {
  return screen
    .getByLabelText(label)
    .querySelector<HTMLCanvasElement>(
      'canvas[data-map-overlay-runtime="maps"]',
    );
}

async function renderComposition() {
  const frames = createManualTimelineScheduler();
  const clock = createMapScopedTimelineClock({
    loop: false,
    playbackRate: 10,
    scheduler: frames.scheduler,
  });
  const summaries: VisibleAggregationSummary[] = [];

  const view = render(
    <>
      <TemporalClusteredMap
        defaultViewState={VIEW_STATE}
        fitToData={false}
        flatRuntime="maps"
        mapLabel="Temporal clusters"
        mapStyle={MAP_STYLE}
        onViewportAggregationChange={(summary) => summaries.push(summary)}
        selectedFeatureId="west"
        showAttributionControl={false}
        showPlaybackControls={false}
        timeline={clock}
        tracks={TRACKS}
      >
        <GeoJsonLayer featureCollection={STATIC_REGION} />
      </TemporalClusteredMap>
      <TemporalHeatMap
        defaultViewState={VIEW_STATE}
        fitToData={false}
        flatRuntime="maps"
        heatmapAsyncRender={false}
        mapLabel="Temporal heat"
        mapStyle={MAP_STYLE}
        showAttributionControl={false}
        showDataPoints
        showPlaybackControls={false}
        timeline={clock}
        tracks={TRACKS}
        weightMetric="cargo"
      >
        <GeoJsonLayer featureCollection={STATIC_REGION} />
      </TemporalHeatMap>
    </>,
  );

  await waitFor(() => {
    for (const label of ["Temporal clusters", "Temporal heat"]) {
      const map = screen.getByLabelText(label);
      expect(map.getAttribute("data-map-ready")).toBe("true");
      expect(map.getAttribute("data-map-runtime")).toBe("maps");
      expect(map.querySelector(".maplibregl-canvas")).toBeNull();
    }
  });

  let timestamp = 0;
  const observe = async (time: number) => {
    expect(clock.getSnapshot().activeTime).toBe(time);
    let observed!: {
      clusters: ReturnType<typeof comparableSummary>;
      heatPrimitives: string | null;
    };
    await waitFor(() => {
      const latest = summaries.at(-1);
      expect(latest).toBeDefined();
      // Clustering at the map-scoped time equals clustering the independent sample.
      expect(comparableSummary(latest!)).toEqual(
        expectedSummary(time, latest!),
      );
      // Heat data points: one per sampled point, plus the static region.
      expect(
        overlayOf("Temporal heat")?.getAttribute("data-map-overlay-primitives"),
      ).toBe(String(sampleTemporalPointsNaively(TRACKS, time).length + 1));
      observed = {
        clusters: comparableSummary(latest!),
        heatPrimitives: overlayOf("Temporal heat")!.getAttribute(
          "data-map-overlay-primitives",
        ),
      };
    });
    return observed;
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

  return { clock, frames, playTo, seek, summaries, view };
}

describe('temporal cluster and heat composition on flatRuntime="maps" (#172 phase D)', () => {
  test("clusters and heat over static regions follow one clock through seek, playback and resume", async () => {
    const { clock, frames, playTo, seek } = await renderComposition();
    const direct = new Map<number, Awaited<ReturnType<typeof seek>>>();

    for (const time of TARGETS) {
      direct.set(time, await seek(time));
    }
    // The converged couriers are one cluster; separated they are three points.
    expect(direct.get(50)!.clusters).toMatchObject({
      visibleClusterCount: 1,
      visiblePointCount: 3,
    });
    expect(direct.get(25)!.clusters).toMatchObject({
      visibleClusterCount: 0,
      visiblePointCount: 3,
    });
    expect(direct.get(75)!.clusters).toMatchObject({ visiblePointCount: 4 });

    // Forward playback reaches every target with the directly seeked composition.
    await seek(0);
    for (const time of TARGETS.slice(1)) {
      expect(await playTo(time)).toEqual(direct.get(time));
    }
    expect(clock.getSnapshot().isPlaying).toBe(false);
    expect(frames.pending).toBe(false);

    // Backward seek while playing, pause, resume.
    await seek(0);
    expect(await playTo(60)).toEqual(direct.get(60));
    expect(await seek(25)).toEqual(direct.get(25));
    act(() => clock.pause());
    expect(await seek(47.5)).toEqual(direct.get(47.5));
    for (const time of [50, 52.5, 75]) {
      expect(await playTo(time)).toEqual(direct.get(time));
    }
  });

  test("both Map Views share one frame loop and time changes rebuild only the heat source", async () => {
    const { clock, frames, seek } = await renderComposition();
    await seek(25);
    const before = heatWork.totals();

    act(() => clock.play());
    const requestsBefore = frames.requests;
    act(() => frames.frame(0));
    act(() => frames.frame(FRAME_MS));
    act(() => frames.frame(FRAME_MS * 2));
    // One frame request per frame for both Map Views: no per-layer loop.
    expect(frames.requests - requestsBefore).toBe(3);
    act(() => clock.pause());
    await seek(30);

    const after = heatWork.totals();
    // The heat Map Layer stays mounted; time changes rebuild its density source only.
    expect(after.layers).toBe(before.layers);
    expect(after.data.sourceIndexBuilds).toBeGreaterThan(
      before.data.sourceIndexBuilds,
    );
    expect(after.data.fieldGridBuilds).toBe(before.data.fieldGridBuilds);
  });

  test("a temporal GeoJSON overlay entering and leaving keeps the heat Map Layer mounted", async () => {
    const clock = createMapScopedTimelineClock();
    const zone = (
      time: number,
      visible = true,
    ): GeoJSON.Feature<GeoJSON.Polygon> => ({
      geometry: {
        coordinates: [
          [
            [0, 0],
            [8, 0],
            [8, 8],
            [0, 8],
            [0, 0],
          ],
        ],
        type: "Polygon",
      },
      properties: { time, trackId: "zone", visible },
      type: "Feature",
    });

    render(
      <TemporalHeatMap
        defaultViewState={VIEW_STATE}
        fitToData={false}
        flatRuntime="maps"
        geoJson={{
          features: [zone(20), zone(30), zone(40, false)],
          type: "FeatureCollection",
        }}
        heatmapAsyncRender={false}
        mapLabel="Temporal heat overlay"
        mapStyle={MAP_STYLE}
        showAttributionControl={false}
        showDataPoints
        showPlaybackControls={false}
        timeline={clock}
        tracks={TRACKS}
        weightMetric="cargo"
      />,
    );
    await waitFor(() => {
      expect(
        screen
          .getByLabelText("Temporal heat overlay")
          .getAttribute("data-map-ready"),
      ).toBe("true");
    });
    const primitivesAt = async (time: number, overlay: number) => {
      act(() => clock.seek(time));
      await waitFor(() => {
        expect(
          overlayOf("Temporal heat overlay")?.getAttribute(
            "data-map-overlay-primitives",
          ),
        ).toBe(
          String(sampleTemporalPointsNaively(TRACKS, time).length + overlay),
        );
      });
    };

    await primitivesAt(10, 0);
    const before = heatWork.totals();
    // The overlay zone enters, moves and leaves while the heat source keeps changing.
    await primitivesAt(25, 1);
    await primitivesAt(45, 0);
    await primitivesAt(25, 1);

    // One heat Map Layer and one render state for the whole sequence: no remount.
    const after = heatWork.totals();
    expect(after.layers - before.layers).toBe(0);
    expect(after.renderStates - before.renderStates).toBe(0);
  });
});
