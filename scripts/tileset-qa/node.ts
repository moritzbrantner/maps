// Node host for Tileset QA: local archive ranges, streamed hashing, the built Rust/WASM
// kernel and the pinned upstream validator. No archive is loaded into memory as a whole.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Source } from "pmtiles";

import { TILESET_QA_UPSTREAM, type TilesetQaKernel, type TilesetQaUpstreamVerify } from "./core.ts";

export const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export type ArchiveFile = {
  name: string;
  bytes: number;
  sha256: string;
  source: Source;
  /** Range reads issued through `source`, for Fast evidence. */
  io: { reads: number; bytes: number };
  close(): Promise<void>;
};

/** Open a local archive: stream its SHA-256 once, then serve byte ranges on demand. */
export async function openArchiveFile(file: string): Promise<ArchiveFile> {
  const { size } = await stat(file);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  const handle = await open(file, "r");
  const io = { reads: 0, bytes: 0 };
  return {
    name: path.basename(file),
    bytes: size,
    sha256: hash.digest("hex"),
    io,
    source: {
      getKey: () => file,
      async getBytes(offset, length, signal) {
        signal?.throwIfAborted();
        const buffer = new Uint8Array(Math.max(0, Math.min(length, size - offset)));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
        signal?.throwIfAborted();
        io.reads += 1;
        io.bytes += bytesRead;
        return { data: buffer.buffer.slice(0, bytesRead) };
      },
    },
    close: () => handle.close(),
  };
}

/** An in-memory archive, for derived (corrupted, truncated) test inputs. */
export function openArchiveBytes(name: string, bytes: Uint8Array): ArchiveFile {
  const io = { reads: 0, bytes: 0 };
  return {
    name,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    io,
    source: {
      getKey: () => name,
      async getBytes(offset, length, signal) {
        signal?.throwIfAborted();
        const slice = bytes.slice(offset, offset + length);
        io.reads += 1;
        io.bytes += slice.length;
        return { data: slice.buffer };
      },
    },
    close: async () => {},
  };
}

/**
 * Load the built Maps WASM module (`bun run build:wasm`). There is no JavaScript fallback:
 * without the Rust kernel Tileset QA cannot run.
 */
export async function loadTilesetQaKernel(directory?: string): Promise<TilesetQaKernel> {
  const candidates = [
    directory,
    process.env.MAPS_QA_WASM_DIR,
    path.join(repositoryRoot, "dist/wasm"),
    path.join(repositoryRoot, "public/wasm"),
  ].filter((candidate): candidate is string => Boolean(candidate));
  const found = candidates
    .map((candidate) => path.resolve(candidate))
    .find((candidate) => existsSync(path.join(candidate, "maps_wasm.js")));
  if (!found) {
    throw new Error(
      `Tileset QA needs the built Maps WASM module; run \`bun run build:wasm\` (looked in ${candidates.join(", ")})`,
    );
  }
  const module = (await import(pathToFileURL(path.join(found, "maps_wasm.js")).href)) as {
    initSync(input: { module: Uint8Array }): unknown;
  } & Partial<TilesetQaKernel>;
  module.initSync({ module: readFileSync(path.join(found, "maps_wasm_bg.wasm")) });
  const { inspectMvtTile, auditTilesetCoverage } = module;
  if (!inspectMvtTile || !auditTilesetCoverage) {
    throw new Error(`Maps WASM module in ${found} predates Tileset QA; rebuild it`);
  }
  return { inspectMvtTile, auditTilesetCoverage };
}

/**
 * Run the upstream `pmtiles verify`. Returns `null` when no CLI is available, which the
 * report records as inconclusive rather than passed.
 */
export function runUpstreamVerify(
  archive: string,
  cli: string | undefined = process.env.PMTILES_CLI,
): TilesetQaUpstreamVerify | null {
  if (!cli) return null;
  let version: string | null;
  try {
    const output = execFileSync(cli, ["version"], { encoding: "utf8", stdio: "pipe" });
    version = /(\d+\.\d+\.\d+)/.exec(output)?.[1] ?? null;
  } catch {
    return null;
  }
  try {
    execFileSync(cli, ["verify", archive], { encoding: "utf8", stdio: "pipe" });
    return { tool: TILESET_QA_UPSTREAM.tool, version, outcome: "passed", detail: "" };
  } catch (error) {
    const detail = (error as { stderr?: string; message: string }).stderr || String(error);
    return {
      tool: TILESET_QA_UPSTREAM.tool,
      version,
      outcome: "failed",
      detail: detail.trim().slice(0, 500),
    };
  }
}

export function pmtilesReaderVersion(): string {
  const manifest = path.join(repositoryRoot, "node_modules/pmtiles/package.json");
  return (JSON.parse(readFileSync(manifest, "utf8")) as { version: string }).version;
}
