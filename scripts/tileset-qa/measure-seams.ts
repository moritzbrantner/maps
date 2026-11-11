// Fast evidence for Tile seam QA (#276, part 3), opt-in: needs the Atlas Liechtenstein archive
// (`bun scripts/fetch-atlas-tiles.ts`) and the built WASM module.
//
//   bun scripts/tileset-qa/measure-seams.ts [--runs 5]
//
// A sampled run (32 adjacent pairs, the default preview) and a full run (every adjacent pair)
// over the 203-tile regional archive. Prints medians and ranges; nothing is written.
import { parseArgs } from "node:util";

import { checkSeams, knownTarget, type TilesetSeamsRun } from "../tileset-qa.ts";

const { values } = parseArgs({ options: { runs: { type: "string" } } });
const runs = Number(values.runs ?? 5);
const atlas = knownTarget("atlas-liechtenstein")!;
const median = (list: number[]) => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)]!;

for (const mode of ["sampled", "full"] as const) {
  const results: TilesetSeamsRun[] = [];
  for (let index = 0; index < runs; index += 1) results.push(await checkSeams({ ...atlas, mode }));
  const { artifact, measurement } = results.at(-1)!;
  const checks = results.map((result) => result.measurement.checksMs);
  console.log(
    JSON.stringify({
      case: mode,
      status: artifact.status,
      adjacentPairs: artifact.pairs?.adjacent ?? 0,
      checkedPairs: artifact.pairs?.checked ?? 0,
      lineCrossings: artifact.seams?.counts.lineCrossings ?? 0,
      polygonGroups: artifact.seams?.counts.polygonGroups ?? 0,
      rangeReads: measurement.rangeReads,
      rangeBytes: measurement.rangeBytes,
      archiveBytes: measurement.archiveBytes,
      hashMsMedian: Number(median(results.map((r) => r.measurement.hashMs)).toFixed(1)),
      checksMsMedian: Number(median(checks).toFixed(1)),
      checksMsRange: [Math.min(...checks), Math.max(...checks)].map((v) => Number(v.toFixed(1))),
      peakRssBytes: measurement.peakRssBytes,
    }),
  );
}
