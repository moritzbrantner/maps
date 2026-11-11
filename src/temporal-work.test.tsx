import { act, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";

import { createMapScopedTimelineClock, type MapScopedTimelineClock, type TemporalMapTrack } from ".";
import { useTemporalMapState } from "./temporal-map-state";
import {
  getMapsTemporalRuntimeStatus,
  resetMapsTemporalWasmRuntimeForTests,
  setMapsTemporalWasmRuntimeForTests,
} from "./temporal-points-wasm";
import { observeTemporalWork, type TemporalPlaybackWork } from "./temporal-work";
import { createScanTemporalRuntimeForTests } from "./test-temporal-runtime";
import { createManualTimelineScheduler } from "./test-timeline-scheduler";

/*
 * #172 phase E: the deterministic work contract of moving point tracks on a Map-Scoped
 * Timeline, read through the production work counters of the playback index the temporal
 * Convenience Maps share (`useTemporalMapState`).
 */

const observation = observeTemporalWork();

afterEach(() => {
  resetMapsTemporalWasmRuntimeForTests();
});

/** Two moving tracks, one that stops at 40 (and holds) and one admitted at 50. */
const TRACKS: TemporalMapTrack[] = [
  {
    frames: [
      { latitude: 50, longitude: 10, time: 0 },
      { latitude: 52, longitude: 14, time: 100 },
    ],
    id: "north",
  },
  {
    frames: [
      { latitude: 48, longitude: 14, time: 0 },
      { latitude: 46, longitude: 10, time: 100 },
    ],
    id: "south",
  },
  {
    frames: [
      { latitude: 51, longitude: 8, time: 0 },
      { latitude: 51, longitude: 9, time: 40 },
    ],
    id: "parked",
  },
  {
    frames: [
      { latitude: 49, longitude: 12, time: 50 },
      { latitude: 50, longitude: 13, time: 100 },
    ],
    id: "late",
  },
];
const KEYFRAMES = TRACKS.reduce((count, track) => count + track.frames.length, 0);

function Harness({
  clock,
  tracks,
  unrelated = 0,
}: {
  clock: MapScopedTimelineClock;
  tracks: readonly TemporalMapTrack[];
  unrelated?: number;
}) {
  const { points } = useTemporalMapState({ timeline: clock, tracks }, {});

  return (
    <output data-testid="points" data-unrelated={unrelated}>
      {points.map((point) => `${point.id}@${point.longitude},${point.latitude}`).join(" ")}
    </output>
  );
}

function measure() {
  const start = observation.totals().playback;
  return () => {
    const end = observation.totals().playback;
    return Object.fromEntries(
      Object.keys(end).map((key) => [
        key,
        end[key as keyof TemporalPlaybackWork] - start[key as keyof TemporalPlaybackWork],
      ]),
    ) as TemporalPlaybackWork;
  };
}

async function mountSettled(clock: MapScopedTimelineClock, tracks = TRACKS) {
  const view = render(<Harness clock={clock} tracks={tracks} />);
  // Without the compiled module the Rust runtime fails to load: TypeScript stays the authority.
  await waitFor(() => expect(getMapsTemporalRuntimeStatus()).toBe("unavailable"));
  return view;
}

describe("Map-Scoped Timeline work counters (#172 phase E)", () => {
  test("mounting prepares the tracks once while the sampling authority does not change", async () => {
    const work = measure();
    const clock = createMapScopedTimelineClock();

    await mountSettled(clock);

    // The runtime went idle → loading → unavailable; the TypeScript authority never changed,
    // so the tracks were prepared and sampled once.
    expect(work()).toMatchObject({
      preparedKeyframes: KEYFRAMES,
      preparedTracks: TRACKS.length,
      rustTrackPreparations: 0,
      samples: 1,
      trackPreparations: 1,
    });
  });

  test("time changes only sample; camera-free rerenders, pauses and repeated times do nothing", async () => {
    const frames = createManualTimelineScheduler();
    const clock = createMapScopedTimelineClock({
      loop: false,
      playbackRate: 10,
      scheduler: frames.scheduler,
    });
    const { rerender } = await mountSettled(clock);

    // Seeks: one sample each over every prepared track, never a preparation.
    let work = measure();
    for (const time of [20, 60, 30, 80, 10]) act(() => clock.seek(time));
    expect(work()).toMatchObject({
      sampledTracks: 5 * TRACKS.length,
      samples: 5,
      trackPreparations: 0,
    });

    // The same time again, pause, and an unrelated commit sample nothing.
    work = measure();
    act(() => clock.seek(10));
    act(() => clock.pause());
    rerender(<Harness clock={clock} tracks={TRACKS} unrelated={1} />);
    expect(work()).toMatchObject({ samples: 0, trackPreparations: 0 });

    // 30 playback frames of 100 ms: one sample per advanced time, nothing re-prepared.
    work = measure();
    act(() => clock.seek(60));
    act(() => clock.play());
    act(() => frames.frame(0));
    for (let frame = 1; frame <= 30; frame += 1) act(() => frames.frame(frame * 100));
    act(() => clock.pause());
    const playback = work();
    expect(playback).toMatchObject({ samples: 31, trackPreparations: 0 });
    // Only the moving tracks changed: "parked" holds its last keyframe after 40.
    // The seek to 60 moves north/south/late (parked held already at 10 → 60 is a change).
    expect(playback.changedFeatures).toBe(4 + 30 * 3);
    expect(playback.emittedFeatures).toBe(31 * 4);
  });

  test("admission and removal are changed features", async () => {
    const clock = createMapScopedTimelineClock();
    await mountSettled(clock);

    const work = measure();
    act(() => clock.seek(50));
    // north/south moved, parked held (moved from 0 to its hold at 40), late admitted.
    expect(work()).toMatchObject({ changedFeatures: 4, emittedFeatures: 4 });

    const back = measure();
    act(() => clock.seek(20));
    // late is removed again; parked moves back onto its track.
    expect(back()).toMatchObject({ changedFeatures: 4, emittedFeatures: 3 });
  });

  test("remounting on a shared clock samples once, at the kept time", async () => {
    const clock = createMapScopedTimelineClock();
    const first = await mountSettled(clock);
    act(() => clock.seek(30));
    first.unmount();

    // Unmounted, the clock has no registered range; its placeholder time is not sampled.
    const work = measure();
    const second = render(<Harness clock={clock} tracks={TRACKS} />);
    await waitFor(() => expect(second.getByTestId("points").textContent).toContain("north@11.2,50.6"));
    expect(clock.getSnapshot().activeTime).toBe(30);
    expect(work()).toMatchObject({ samples: 1, trackPreparations: 1 });
  });

  test("a source change prepares once and samples once", async () => {
    const clock = createMapScopedTimelineClock();
    const { rerender } = await mountSettled(clock);
    act(() => clock.seek(30));

    const work = measure();
    rerender(<Harness clock={clock} tracks={TRACKS.slice(0, 2)} />);
    expect(work()).toMatchObject({ preparedTracks: 2, samples: 1, trackPreparations: 1 });
  });

  test("the Rust authority prepares once and reports its bridge bytes", async () => {
    const clock = createMapScopedTimelineClock();
    await mountSettled(clock);
    act(() => clock.seek(25));

    let work = measure();
    act(() => setMapsTemporalWasmRuntimeForTests(createScanTemporalRuntimeForTests()));
    expect(work()).toMatchObject({
      bridgeBytesToWasm: KEYFRAMES * 4 * 8 + TRACKS.length * 4,
      // The time range once, and one packed sample of six values per track.
      bridgeBytesFromWasm: 2 * 8 + TRACKS.length * 6 * 8,
      rustTrackPreparations: 1,
      samples: 1,
      trackPreparations: 1,
    });

    work = measure();
    for (const time of [26, 27, 28]) act(() => clock.seek(time));
    expect(work()).toMatchObject({
      bridgeBytesFromWasm: 3 * TRACKS.length * 6 * 8,
      bridgeBytesToWasm: 0,
      samples: 3,
      trackPreparations: 0,
    });
  });
});
