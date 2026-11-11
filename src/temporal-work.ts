/**
 * Deterministic work counters of moving point tracks on a Map-Scoped Timeline (#172 phase E).
 *
 * One {@link TemporalPlaybackWork} set belongs to each prepared playback index (the resource
 * that decides the work), so the counts describe what actually executed:
 *
 * - track preparation: playback indexes built, with their tracks and keyframes;
 * - sampling: time samples answered, the tracks each one evaluated and the features it emitted;
 * - changed features: emitted features admitted, removed or moved relative to the index's
 *   previous sample, i.e. the dynamic work a renderer must reflect;
 * - bridge bytes: typed-array bytes crossing the JS/WASM boundary while Rust samples.
 *
 * Aggregation/index maintenance, static-layer rebuilds, uploads and frames belong to the Map
 * View runtime and are counted there (`e2e/helpers/mixed-layer-work.ts`), not here.
 *
 * The counters are evidence, not policy: nothing reads them to decide work.
 */
export type TemporalPlaybackWork = {
  /** Playback indexes prepared (keyframe validation, ordering and, with Rust, packing). */
  trackPreparations: number;
  /** Of those, the preparations owned by the Rust/WASM temporal runtime. */
  rustTrackPreparations: number;
  /** Tracks accepted by those preparations. */
  preparedTracks: number;
  /** Keyframes read by those preparations. */
  preparedKeyframes: number;
  /** Time samples answered by a prepared index. */
  samples: number;
  /** Tracks evaluated by those samples. */
  sampledTracks: number;
  /** Map Features those samples emitted. */
  emittedFeatures: number;
  /** Emitted features admitted, removed or moved since the index's previous sample. */
  changedFeatures: number;
  /** Typed-array bytes passed into the Rust/WASM runtime (keyframes and frame counts). */
  bridgeBytesToWasm: number;
  /** Typed-array bytes returned by the Rust/WASM runtime (packed samples and time range). */
  bridgeBytesFromWasm: number;
};

/** Running totals of every temporal work set registered while observation is installed. */
export type TemporalWorkTotals = {
  /** Prepared playback indexes whose work is included (cumulative). */
  indexes: number;
  playback: TemporalPlaybackWork;
};

export type TemporalWorkObservation = {
  totals(): TemporalWorkTotals;
};

let registry: TemporalPlaybackWork[] | null = null;
const workByIndex = new WeakMap<object, TemporalPlaybackWork>();

/**
 * Evidence-only observation for browser journeys and tests: once installed, every work set
 * created afterwards is registered, so a page can read the totals without reaching into the
 * Map View. Nothing is registered (and nothing is retained) unless something installs it; it
 * is not part of the public package API.
 */
export function observeTemporalWork(): TemporalWorkObservation {
  const observed = (registry ??= []);
  return {
    totals() {
      const playback = emptyTemporalPlaybackWork();
      for (const work of observed) {
        for (const key of Object.keys(playback) as (keyof TemporalPlaybackWork)[]) {
          playback[key] += work[key];
        }
      }
      return { indexes: observed.length, playback };
    },
  };
}

/** @internal Creates (and, while observed, registers) the work set of one playback index. */
export function createTemporalPlaybackWork(): TemporalPlaybackWork {
  const work = emptyTemporalPlaybackWork();
  registry?.push(work);
  return work;
}

/** @internal */
export function attachTemporalPlaybackWork(index: object, work: TemporalPlaybackWork) {
  workByIndex.set(index, work);
}

/** The work set of a prepared playback index, if it was prepared by this package. */
export function getTemporalPlaybackWork(index: object): TemporalPlaybackWork | undefined {
  return workByIndex.get(index);
}

/**
 * @internal Tracks which emitted features changed between consecutive samples of one index.
 * A slot is one prepared track; it is absent, or present at a position.
 */
export function createTemporalChangeTracker(trackCount: number) {
  const present = new Uint8Array(trackCount);
  const longitudes = new Float64Array(trackCount);
  const latitudes = new Float64Array(trackCount);

  return {
    /** Records the slot's sample and returns whether it differs from the previous one. */
    observe(slot: number, isPresent: boolean, longitude: number, latitude: number) {
      const wasPresent = present[slot] === 1;

      if (!isPresent) {
        present[slot] = 0;
        return wasPresent;
      }

      const changed =
        !wasPresent ||
        !Object.is(longitudes[slot], longitude) ||
        !Object.is(latitudes[slot], latitude);
      present[slot] = 1;
      longitudes[slot] = longitude;
      latitudes[slot] = latitude;
      return changed;
    },
  };
}

function emptyTemporalPlaybackWork(): TemporalPlaybackWork {
  return {
    bridgeBytesFromWasm: 0,
    bridgeBytesToWasm: 0,
    changedFeatures: 0,
    emittedFeatures: 0,
    preparedKeyframes: 0,
    preparedTracks: 0,
    rustTrackPreparations: 0,
    sampledTracks: 0,
    samples: 0,
    trackPreparations: 0,
  };
}
