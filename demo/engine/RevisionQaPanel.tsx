// Tileset revision diff in the Engine inspector (#276, part 2): choose a base/candidate pair,
// run the same `runTilesetDiff` the CLI runs (upstream `pmtiles` reader, Rust/WASM kernel),
// inspect counts and representative tiles, show either revision on the map and focus a tile.
import { useCallback, useEffect, useRef, useState } from "react";
import { version as pmtilesVersion } from "pmtiles/package.json";
import type { Source } from "pmtiles";

import { importMapsWasmModule } from "../../src/aggregation-wasm";
import type { MapsTileset } from "../../src/maps-tileset";
import { createFixtureRevisionTileset } from "../../src/tileset-fixtures";
import { sha256Hex, type TilesetQaKernel } from "../../scripts/tileset-qa/core";
import {
  runTilesetDiff,
  type TilesetDiffArtifact,
  type TilesetDiffTileRef,
} from "../../scripts/tileset-qa/diff";
import { createAtlasTileset } from "../atlas-source";

type Comparison = {
  id: string;
  label: string;
  base: () => MapsTileset;
  candidate: () => MapsTileset;
};

const BASE_URL = import.meta.env.BASE_URL;
export const REVISION_QA_COMPARISONS: Comparison[] = [
  {
    id: "fixture-revision-r1-r2",
    label: "Synthetic fixture · r1 → r2",
    base: () => createFixtureRevisionTileset("r1", BASE_URL),
    candidate: () => createFixtureRevisionTileset("r2", BASE_URL),
  },
  {
    id: "atlas-liechtenstein-north-coverage",
    label: "Atlas Liechtenstein → north · cross-source coverage only",
    base: () => createAtlasTileset("liechtenstein", BASE_URL),
    candidate: () => createAtlasTileset("liechtenstein-north", BASE_URL),
  },
];

type RunState =
  | { status: "idle" }
  | { status: "running" }
  | {
      status: "done";
      artifact: TilesetDiffArtifact;
      ms: number;
      fetchedBytes: number;
    }
  | { status: "error"; message: string };

export type RevisionQaFocus = TilesetDiffTileRef & { reason: string };

/** The whole archive is fetched once and hashed; tiles are then range-read from memory. */
async function fetchArchive(tileset: MapsTileset, signal: AbortSignal) {
  if (tileset.transport.kind !== "pmtiles") throw new Error("revision diff needs PMTiles archives");
  const url = tileset.transport.url;
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const source: Source = {
    getKey: () => url,
    async getBytes(offset, length, abort) {
      abort?.throwIfAborted();
      return { data: bytes.slice(offset, offset + length).buffer };
    },
  };
  return {
    name: url.slice(url.lastIndexOf("/") + 1),
    bytes: bytes.length,
    sha256: await sha256Hex(bytes),
    source,
  };
}

async function loadKernel(): Promise<TilesetQaKernel> {
  const module = (await importMapsWasmModule()) as Partial<TilesetQaKernel>;
  const { inspectMvtTile, auditTilesetCoverage, diffMvtTiles, tileLngLatBounds } = module;
  if (!inspectMvtTile || !auditTilesetCoverage || !diffMvtTiles || !tileLngLatBounds) {
    throw new Error("the loaded Maps WASM module predates Tileset QA");
  }
  return {
    inspectMvtTile,
    auditTilesetCoverage,
    diffMvtTiles,
    tileLngLatBounds,
  };
}

const tileKey = (tile: { z: number; x: number; y: number }) => `${tile.z}/${tile.x}/${tile.y}`;
const short = (sha256: string) => `${sha256.slice(0, 12)}…`;

export function RevisionQaPanel({
  initialComparison,
  shownTileset,
  focused,
  onShow,
  onFocus,
}: {
  initialComparison?: string | null;
  shownTileset: MapsTileset | undefined;
  focused: RevisionQaFocus | null;
  onShow: (tileset: MapsTileset) => void;
  onFocus: (tile: RevisionQaFocus) => void;
}) {
  const [comparisonId, setComparisonId] = useState(
    REVISION_QA_COMPARISONS.some((entry) => entry.id === initialComparison)
      ? initialComparison!
      : REVISION_QA_COMPARISONS[0]!.id,
  );
  const comparison = REVISION_QA_COMPARISONS.find((entry) => entry.id === comparisonId)!;
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
      const base = comparison.base();
      const candidate = comparison.candidate();
      const [kernel, baseArchive, candidateArchive] = await Promise.all([
        loadKernel(),
        fetchArchive(base, controller.signal),
        fetchArchive(candidate, controller.signal),
      ]);
      const artifact = await runTilesetDiff({
        base: { manifest: base, archive: baseArchive },
        candidate: { manifest: candidate, archive: candidateArchive },
        kernel,
        pmtilesReaderVersion: pmtilesVersion,
        comparisonId: comparison.id,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setState({
        status: "done",
        artifact,
        ms: performance.now() - started,
        fetchedBytes: baseArchive.bytes + candidateArchive.bytes,
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      setState({
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, [comparison]);

  const artifact = state.status === "done" ? state.artifact : null;
  const lost = artifact?.findings.find((finding) => finding.code === "coverage-lost");
  const narrowed = artifact?.findings.find((finding) => finding.code === "coverage-narrowed");
  const added = artifact?.findings.find((finding) => finding.code === "coverage-added");
  const problemTiles: RevisionQaFocus[] = artifact
    ? [
        ...(lost?.tiles ?? []).map((tile) => ({
          ...tile,
          reason: "coverage lost: missing in candidate",
        })),
        ...(artifact.features?.tiles ?? []).map((tile) => ({
          z: tile.z,
          x: tile.x,
          y: tile.y,
          bounds: tile.bounds,
          reason: `${tile.status}: ${tile.reason}`,
        })),
        ...(narrowed?.tiles ?? []).map((tile) => ({
          ...tile,
          reason: "outside candidate coverage",
        })),
        ...(added?.tiles ?? []).map((tile) => ({
          ...tile,
          reason: "coverage added",
        })),
      ]
    : [];
  const counts = artifact?.features?.counts;

  return (
    <section
      aria-labelledby="inspector-revision-qa"
      data-revision-qa-status={artifact?.status ?? state.status}
    >
      <h2 id="inspector-revision-qa">Revision QA</h2>
      <select
        aria-label="Revision comparison"
        value={comparisonId}
        onChange={(event) => {
          abortRef.current?.abort();
          setComparisonId(event.target.value);
          setState({ status: "idle" });
        }}
      >
        {REVISION_QA_COMPARISONS.map((entry) => (
          <option key={entry.id} value={entry.id}>
            {entry.label}
          </option>
        ))}
      </select>
      <div className="engine-inspector__buttons">
        <button disabled={state.status === "running"} onClick={() => void run()} type="button">
          {state.status === "running" ? "Comparing…" : "Compare revisions"}
        </button>
        {(["base", "candidate"] as const).map((side) => {
          const tileset = comparison[side]();
          const shown =
            shownTileset?.sourceId === tileset.sourceId &&
            shownTileset.dataRevision === tileset.dataRevision;
          return (
            <button aria-pressed={shown} key={side} onClick={() => onShow(tileset)} type="button">
              Show {side === "base" ? "A" : "B"} · {tileset.dataRevision.slice(0, 12)}
            </button>
          );
        })}
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
          <p
            className="engine-inspector__qa-status"
            data-status={artifact.status}
            data-relation={artifact.relation ?? "unpaired"}
          >
            {artifact.status} · {artifact.relation ?? "unpaired"}
          </p>
          <dl className="engine-inspector__list">
            {(["base", "candidate"] as const).map((side) => {
              const entry = artifact[side];
              return entry ? (
                <div className="engine-inspector__qa-side" key={side}>
                  <dt>{side === "base" ? "A · base" : "B · candidate"}</dt>
                  <dd>
                    {entry.sourceId} / {entry.dataRevision}
                  </dd>
                  <dt>Archive</dt>
                  <dd title={entry.archive.sha256}>
                    {entry.archive.name} · {short(entry.archive.sha256)}
                  </dd>
                  <dt>Provenance</dt>
                  <dd>{entry.provenance}</dd>
                </div>
              ) : null;
            })}
          </dl>
          <table className="engine-inspector__table" aria-label="Revision QA checks">
            <tbody>
              {artifact.checks.map((check) => (
                <tr data-check={check.id} data-status={check.status} key={check.id}>
                  <th scope="row">{check.id}</th>
                  <td>{check.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <dl className="engine-inspector__list" aria-label="Revision QA counts">
            <dt>Tiles A / B / common</dt>
            <dd>
              {artifact.coverage
                ? `${artifact.coverage.base} / ${artifact.coverage.candidate} / ${artifact.coverage.common}`
                : "—"}
            </dd>
            <dt>Coverage added / removed / lost</dt>
            <dd data-qa-count="coverage">
              {artifact.coverage
                ? `${artifact.coverage.added} / ${artifact.coverage.removed} / ${lost?.count ?? 0}`
                : "—"}
            </dd>
            <dt>Compared · identical / re-encoded / changed</dt>
            <dd data-qa-count="tiles">
              {artifact.features
                ? `${artifact.features.comparedTiles} · ${artifact.features.identicalTiles} / ${artifact.features.reencodedTiles} / ${artifact.features.changedTiles}`
                : "—"}
            </dd>
            <dt>Features added / removed / changed (stable ID)</dt>
            <dd>{counts ? `${counts.added} / ${counts.removed} / ${counts.changed}` : "—"}</dd>
            <dt>Ambiguous / unmatched + / unmatched −</dt>
            <dd data-qa-count="unmatched">
              {counts
                ? `${counts.ambiguous} / ${counts.unmatchedAdded} / ${counts.unmatchedRemoved}`
                : "—"}
            </dd>
          </dl>
          {focused ? (
            <p className="engine-inspector__hint" data-focused-tile={tileKey(focused)}>
              Focused tile {tileKey(focused)} on{" "}
              {shownTileset ? `${shownTileset.sourceId} / ${shownTileset.dataRevision}` : "—"}:{" "}
              {focused.reason}
            </p>
          ) : null}
          {problemTiles.length ? (
            <ul className="engine-inspector__qa-tiles" aria-label="Revision QA tiles">
              {problemTiles.map((tile) => (
                <li key={`${tileKey(tile)} ${tile.reason}`}>
                  <button
                    aria-pressed={focused !== null && tileKey(focused) === tileKey(tile)}
                    onClick={() => onFocus(tile)}
                    type="button"
                  >
                    Focus {tileKey(tile)}
                  </button>
                  <span>{tile.reason}</span>
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
          Compares two archives with the CLI's checks: coverage from both directories, then a
          bounded sample of common tiles decoded by the Rust kernel. Without stable feature IDs,
          changes are reported as unmatched or ambiguous, never as the same feature.
        </p>
      )}
    </section>
  );
}
