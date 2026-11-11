// Tile seam QA in the Engine inspector (#276, part 3): choose an archive, run the same
// `runTilesetSeams` the CLI runs (upstream `pmtiles` reader, Rust/WASM kernel), inspect counts
// and defective tile pairs, show the archive on the map and focus a pair.
import { useCallback, useEffect, useRef, useState } from "react";
import { version as pmtilesVersion } from "pmtiles/package.json";

import type { MapsTileset } from "../../src/maps-tileset";
import { createFixtureSeamsTileset } from "../../src/tileset-fixtures";
import { runTilesetSeams, type TilesetSeamsArtifact } from "../../scripts/tileset-qa/seams";
import { createAtlasTileset } from "../atlas-source";
import { fetchArchive, loadKernel, type RevisionQaFocus } from "./RevisionQaPanel";

type SeamTarget = { id: string; label: string; tileset: () => MapsTileset };

const BASE_URL = import.meta.env.BASE_URL;
export const SEAM_QA_TARGETS: SeamTarget[] = [
  {
    id: "fixture-seams-defects",
    label: "Synthetic fixture · deliberate seam defects",
    tileset: () => createFixtureSeamsTileset("defects", BASE_URL),
  },
  {
    id: "fixture-seams-clean",
    label: "Synthetic fixture · continuous seams",
    tileset: () => createFixtureSeamsTileset("clean", BASE_URL),
  },
  {
    id: "atlas-liechtenstein",
    label: "Atlas Liechtenstein",
    tileset: () => createAtlasTileset("liechtenstein", BASE_URL),
  },
];

type RunState =
  | { status: "idle" }
  | { status: "running" }
  | { status: "done"; artifact: TilesetSeamsArtifact; ms: number; fetchedBytes: number }
  | { status: "error"; message: string };

const tileKey = (tile: { z: number; x: number; y: number }) => `${tile.z}/${tile.x}/${tile.y}`;

export function SeamQaPanel({
  initialTarget,
  shownTileset,
  focused,
  onShow,
  onFocus,
}: {
  initialTarget?: string | null;
  shownTileset: MapsTileset | undefined;
  focused: RevisionQaFocus | null;
  onShow: (tileset: MapsTileset) => void;
  onFocus: (tile: RevisionQaFocus) => void;
}) {
  const [targetId, setTargetId] = useState(
    SEAM_QA_TARGETS.some((entry) => entry.id === initialTarget)
      ? initialTarget!
      : SEAM_QA_TARGETS[0]!.id,
  );
  const target = SEAM_QA_TARGETS.find((entry) => entry.id === targetId)!;
  const [state, setState] = useState<RunState>({ status: "idle" });
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);

  const run = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setState({ status: "running" });
    try {
      const started = performance.now();
      const tileset = target.tileset();
      const [kernel, archive] = await Promise.all([
        loadKernel(),
        fetchArchive(tileset, controller.signal),
      ]);
      const artifact = await runTilesetSeams({
        manifest: tileset,
        archive,
        kernel,
        pmtilesReaderVersion: pmtilesVersion,
        fixtureId: target.id,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setState({
        status: "done",
        artifact,
        ms: performance.now() - started,
        fetchedBytes: archive.bytes,
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      setState({
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, [target]);

  const artifact = state.status === "done" ? state.artifact : null;
  const tileset = target.tileset();
  const shown =
    shownTileset?.sourceId === tileset.sourceId &&
    shownTileset.dataRevision === tileset.dataRevision;
  const counts = artifact?.seams?.counts;
  // A pair is focused by its first tile's key and framed by both tiles' bounds.
  const pairs: (RevisionQaFocus & { label: string })[] = (artifact?.seams?.reported ?? []).map(
    (pair) => ({
      ...pair.first,
      bounds: pair.bounds,
      label: `${tileKey(pair.first)} ${pair.edge === "south" ? "↓" : "→"} ${tileKey(pair.second)}`,
      reason: `${pair.edge} seam with ${tileKey(pair.second)}: ${pair.reason}`,
    }),
  );

  return (
    <section
      aria-labelledby="inspector-seam-qa"
      data-seam-qa-status={artifact?.status ?? state.status}
    >
      <h2 id="inspector-seam-qa">Seam QA</h2>
      <select
        aria-label="Seam QA archive"
        value={targetId}
        onChange={(event) => {
          abortRef.current?.abort();
          setTargetId(event.target.value);
          setState({ status: "idle" });
        }}
      >
        {SEAM_QA_TARGETS.map((entry) => (
          <option key={entry.id} value={entry.id}>
            {entry.label}
          </option>
        ))}
      </select>
      <div className="engine-inspector__buttons">
        <button disabled={state.status === "running"} onClick={() => void run()} type="button">
          {state.status === "running" ? "Checking…" : "Check seams"}
        </button>
        <button aria-pressed={shown} onClick={() => onShow(tileset)} type="button">
          Show · {tileset.dataRevision.slice(0, 12)}
        </button>
        {artifact ? (
          <button
            onClick={() => void navigator.clipboard?.writeText(JSON.stringify(artifact, null, 2))}
            type="button"
          >
            Copy artifact
          </button>
        ) : null}
      </div>
      {state.status === "error" ? (
        <p className="engine-inspector__error" role="alert">
          {state.message}
        </p>
      ) : null}
      {artifact ? (
        <>
          <p className="engine-inspector__qa-status" data-status={artifact.status}>
            {artifact.status} · {artifact.source?.sourceId ?? "—"} /{" "}
            {artifact.source?.dataRevision ?? "—"}
          </p>
          <table className="engine-inspector__table" aria-label="Seam QA checks">
            <tbody>
              {artifact.checks.map((check) => (
                <tr data-check={check.id} data-status={check.status} key={check.id}>
                  <th scope="row">{check.id}</th>
                  <td>{check.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <dl className="engine-inspector__list" aria-label="Seam QA counts">
            <dt>Pairs checked / adjacent</dt>
            <dd data-seam-count="pairs">
              {artifact.pairs ? `${artifact.pairs.checked} / ${artifact.pairs.adjacent}` : "—"}
            </dd>
            <dt>Lines continuous / interrupted / duplicated / displaced</dt>
            <dd data-seam-count="lines">
              {counts
                ? `${counts.lineCrossings} / ${counts.lineInterrupted} / ${counts.lineDuplicated} / ${counts.lineOffset}`
                : "—"}
            </dd>
            <dt>Polygon groups / one-sided parts</dt>
            <dd data-seam-count="polygons">
              {counts ? `${counts.polygonGroups} / ${counts.polygonMismatches}` : "—"}
            </dd>
            <dt>Tolerance</dt>
            <dd>
              ±{artifact.tolerance.quantizationUnits} unit per vertex +{" "}
              {artifact.tolerance.slackUnits} slack, {artifact.tolerance.offsetWindowUnits}-unit
              offset window
            </dd>
          </dl>
          {focused ? (
            <p className="engine-inspector__hint" data-focused-seam={tileKey(focused)}>
              Focused {tileKey(focused)} on{" "}
              {shownTileset ? `${shownTileset.sourceId} / ${shownTileset.dataRevision}` : "—"}:{" "}
              {focused.reason}
            </p>
          ) : null}
          {pairs.length ? (
            <ul className="engine-inspector__qa-tiles" aria-label="Seam QA pairs">
              {pairs.map((pair) => (
                <li key={pair.label}>
                  <button
                    aria-pressed={focused !== null && focused.reason === pair.reason}
                    onClick={() => onFocus(pair)}
                    type="button"
                  >
                    Focus {pair.label}
                  </button>
                  <span>{pair.reason}</span>
                </li>
              ))}
            </ul>
          ) : null}
          <p className="engine-inspector__hint">
            Checked in {Math.round(state.status === "done" ? state.ms : 0)} ms over{" "}
            {state.status === "done" ? state.fetchedBytes.toLocaleString("en-US") : 0} archive bytes
            · {artifact.schema} {artifact.checkVersion} · {artifact.mode}
          </p>
        </>
      ) : (
        <p className="engine-inspector__hint">
          Checks that lines and polygons continue across the shared edges of adjacent tiles, with
          the CLI's checks: tile-local clipping, quantization and a provider slack are tolerated,
          and an edge without a neighbour is not a seam.
        </p>
      )}
    </section>
  );
}
