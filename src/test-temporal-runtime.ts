import type { MapsTemporalWasmRuntime } from "./temporal-points-wasm";

export type TemporalRuntimeCallsForTests = { indexes: number; samples: number };

/**
 * Test double for the Rust/WASM temporal runtime, for unit tests that run without the compiled
 * module. It answers the packed contract with a linear scan per sample. It is not a semantic
 * reference: the browser test compares the real Rust index with `test-temporal-oracle.ts`.
 */
export function createScanTemporalRuntimeForTests(
  calls: TemporalRuntimeCallsForTests = { indexes: 0, samples: 0 },
): MapsTemporalWasmRuntime {
  return {
    createPointIndex(keyframes, frameCounts) {
      calls.indexes += 1;
      const tracks: Array<Array<{ frame: number; values: number[] }>> = [];
      let offset = 0;

      for (const count of frameCounts) {
        const frames = [];

        for (let frame = 0; frame < count; frame += 1) {
          const values = [...keyframes.subarray((offset + frame) * 4, (offset + frame) * 4 + 4)];

          if (values.slice(0, 3).every(Number.isFinite)) {
            frames.push({ frame, values });
          }
        }

        offset += count;
        tracks.push(frames);
      }

      const times = tracks.flat().map(({ values }) => values[0]!);

      return {
        sample(time) {
          calls.samples += 1;
          return Float64Array.from(
            tracks.flatMap((frames) => {
              let previous: (typeof frames)[number] | undefined;
              let next: (typeof frames)[number] | undefined;

              for (const candidate of frames) {
                const candidateTime = candidate.values[0]!;

                if (candidateTime <= time) {
                  if (!previous || candidateTime >= previous.values[0]!) previous = candidate;
                } else if (!next || candidateTime < next.values[0]!) {
                  next = candidate;
                }
              }

              if (!Number.isFinite(time) || !previous || previous.values[3] === 0) {
                return [0, 0, 0, 0, 0, 0];
              }

              const [previousTime, longitude, latitude] = previous.values as [number, number, number];

              if (!next || previousTime === time) {
                return [1, previous.frame, 0, 0, longitude, latitude];
              }

              const progress = (time - previousTime) / (next.values[0]! - previousTime);

              return [
                2,
                previous.frame,
                next.frame,
                progress,
                longitude + (next.values[1]! - longitude) * progress,
                latitude + (next.values[2]! - latitude) * progress,
              ];
            }),
          );
        },
        timeRange() {
          return times.length === 0
            ? new Float64Array()
            : Float64Array.of(Math.min(...times), Math.max(...times));
        },
      };
    },
  };
}
