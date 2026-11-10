// Fixture page of `maps-atlas-tileset-v1` (#270 Fast): one content-pinned Atlas journey,
// run either by the first-party Map View (candidate) or by MapLibre GL + pmtiles
// (reference). Both implementations sit behind the same handle and the same settle
// rule, so the Node journey in scripts/profile-atlas-tileset-journey.ts cannot tell
// them apart.
import type { AtlasRegion } from "../../demo/atlas-source";

export type AtlasJourneyStep =
  | { kind: "camera"; center: [longitude: number, latitude: number]; zoom: number }
  | { kind: "source"; region: AtlasRegion };

/** What an implementation provides; the settle loop and timing stay shared. */
export type AtlasJourneyImplementation = {
  name: string;
  /** Applies a step synchronously; the work it causes is awaited through `settled`. */
  apply(step: AtlasJourneyStep): void;
  /** True once the current camera and source are fully loaded and presented. */
  settled(): boolean;
  observe(): Record<string, unknown>;
};

export type AtlasJourneyHandle = {
  implementation: string;
  /** Navigation start → first settled frame of the initial camera and source, ms. */
  firstUsefulMapMs: number;
  observe(): Record<string, unknown>;
  /** Applies a step and resolves with the time until it settled, ms. */
  run(step: AtlasJourneyStep): Promise<number>;
};

declare global {
  interface Window {
    mapsAtlasJourney?: Promise<AtlasJourneyHandle>;
  }
}

export const ATLAS_JOURNEY_INITIAL = { center: [9.53, 47.14], zoom: 12 } as const;

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

async function settle(implementation: AtlasJourneyImplementation) {
  while (!implementation.settled()) await frame();
}

async function start(): Promise<AtlasJourneyHandle> {
  const requested = new URLSearchParams(location.search).get("implementation");
  const container = document.getElementById("map")!;
  let implementation: AtlasJourneyImplementation;
  if (requested === "candidate") {
    implementation = await (await import("./atlas-tileset-journey-candidate")).mount(container);
  } else if (requested === "reference") {
    implementation = await (
      await import("../../scripts/engine-reference/maplibre-atlas")
    ).mount(container);
  } else {
    throw new Error("implementation must be either 'reference' or 'candidate'");
  }
  await settle(implementation);
  const firstUsefulMapMs = performance.now();
  return {
    implementation: implementation.name,
    firstUsefulMapMs,
    observe: () => implementation.observe(),
    async run(step) {
      const started = performance.now();
      implementation.apply(step);
      // A step reaches the runtime within a frame; only then can "settled" describe it.
      await frame();
      await frame();
      await settle(implementation);
      return performance.now() - started;
    },
  };
}

window.mapsAtlasJourney = start();
