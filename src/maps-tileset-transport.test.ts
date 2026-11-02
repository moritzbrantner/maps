import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMapsTilesetTileReader } from "./maps-tileset-transport";
import { createFixturePmtilesTileset } from "./tileset-fixtures";

const archive = readFileSync("public/tilesets/fixture-pmtiles-v1.pmtiles");
const originalTile = readFileSync("public/tilesets/fixture-pmtiles-v1.mvt");
const tile0 = { z: 0, x: 0, y: 0, key: "0/0/0" };
const tileAbsent = { z: 1, x: 1, y: 0, key: "1/1/0" };

type Respond = (params: { offset: number; end: number; body: Uint8Array }) => Response;

function mockArchive(bytes: Uint8Array = archive, respond?: Respond) {
  const requests: string[] = [];
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const range = new Headers(init?.headers).get("Range");
    requests.push(range ?? "no-range");
    const match = /^bytes=(\d+)-(\d+)$/.exec(range ?? "");
    if (!match) throw new Error(`Invalid Range request: ${range}`);
    const offset = Number(match[1]);
    const end = Math.min(Number(match[2]), bytes.length - 1);
    const body = bytes.subarray(offset, end + 1);
    if (respond) return respond({ offset, end, body });
    return new Response(Uint8Array.from(body), {
      status: 206,
      headers: {
        "Content-Range": `bytes ${offset}-${end}/${bytes.length}`,
        "Content-Type": "application/octet-stream",
        ETag: '"fixture-v1"',
      },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, requests };
}

afterEach(() => vi.unstubAllGlobals());

describe("PMTiles browser byte-range adapter", () => {
  it("returns the original uncompressed MVT with metadata/header fetched only once", async () => {
    const { requests } = mockArchive();
    const reader = createMapsTilesetTileReader(createFixturePmtilesTileset());
    const first = await reader.fetchTile(tile0, new AbortController().signal);
    const second = await reader.fetchTile(tile0, new AbortController().signal);
    expect(Buffer.from(first).equals(originalTile)).toBe(true);
    expect(Buffer.from(second).equals(originalTile)).toBe(true);
    expect(requests.filter((range) => range === "bytes=0-16383")).toHaveLength(1);
    expect(requests.length).toBe(4); // header, JSON metadata, then two uncached tile bytes
    reader.dispose();
  });

  it("reports a missing tile without silently substituting another region", async () => {
    mockArchive();
    const reader = createMapsTilesetTileReader(createFixturePmtilesTileset());
    await expect(reader.fetchTile(tileAbsent, new AbortController().signal)).rejects.toThrow(
      /missing tile 1\/1\/0/i,
    );
    reader.dispose();
  });

  it.each([
    [
      "range ignored",
      (_p: Parameters<Respond>[0]) => new Response("entire archive", { status: 200 }),
    ],
    [
      "missing Content-Range",
      ({ body }: Parameters<Respond>[0]) => new Response(Uint8Array.from(body), { status: 206 }),
    ],
    [
      "invalid Content-Range",
      ({ body }: Parameters<Respond>[0]) =>
        new Response(Uint8Array.from(body), {
          status: 206,
          headers: { "Content-Range": `bytes 1-${body.length}/99999` },
        }),
    ],
    ["server error", (_p: Parameters<Respond>[0]) => new Response("Unavailable", { status: 503 })],
    [
      "truncated range body",
      ({ offset, end, body }: Parameters<Respond>[0]) =>
        new Response(Uint8Array.from(body.subarray(0, -1)), {
          status: 206,
          headers: { "Content-Range": `bytes ${offset}-${end}/${archive.length}` },
        }),
    ],
  ] as const)("rejects %s even if the server returns a body", async (_name, respond) => {
    mockArchive(archive, respond);
    const reader = createMapsTilesetTileReader(createFixturePmtilesTileset());
    await expect(reader.fetchTile(tile0, new AbortController().signal)).rejects.toThrow(
      /PMTiles|range|HTTP|Content-Range/i,
    );
    reader.dispose();
  });

  it.each([
    ["version", 7, 4, /version/i],
    ["tile type", 99, 2, /MVT/i],
    ["compression", 98, 4, /compression/i],
    ["bounds", 103, 0, /bounds|coverage/i],
  ] as const)(
    "rejects incompatible %s before decoding tiles",
    async (_name, index, value, error) => {
      const modified = Uint8Array.from(archive);
      modified[index] = value;
      mockArchive(modified);
      const reader = createMapsTilesetTileReader(createFixturePmtilesTileset());
      const result = await reader.fetchTile(tile0, new AbortController().signal).then(
        () => "unexpected successful decoding",
        (cause: unknown) => String(cause),
      );
      expect(result).toMatch(error);
      reader.dispose();
    },
  );

  it("aborts in-flight reads on disposal and does not reuse another source's header cache", async () => {
    const { requests } = mockArchive();
    const a = createMapsTilesetTileReader(createFixturePmtilesTileset());
    const b = createMapsTilesetTileReader(createFixturePmtilesTileset("2"));
    await a.fetchTile(tile0, new AbortController().signal);
    await b.fetchTile(tile0, new AbortController().signal);
    expect(requests.filter((range) => range === "bytes=0-16383")).toHaveLength(2);
    a.dispose();
    b.dispose();
    await expect(a.fetchTile(tile0, new AbortController().signal)).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("rejects a corrupt root directory before tile decoding", async () => {
    const modified = Uint8Array.from(archive);
    modified[127] ^= 0xff; // Break the gzip stream containing the v3 root directory.
    mockArchive(modified);
    const reader = createMapsTilesetTileReader(createFixturePmtilesTileset());
    await expect(reader.fetchTile(tile0, new AbortController().signal)).rejects.toThrow(
      /Maps Tileset.*PMTiles/i,
    );
    reader.dispose();
  });

  it("rejects source layers not represented by the archive metadata", async () => {
    mockArchive();
    const descriptor = createFixturePmtilesTileset();
    const reader = createMapsTilesetTileReader({
      ...descriptor,
      schema: { ...descriptor.schema, sourceLayers: ["buildings"] },
    });
    await expect(reader.fetchTile(tile0, new AbortController().signal)).rejects.toThrow(
      /vector_layers/i,
    );
    reader.dispose();
  });

  it("rejects ETag changes between archive ranges", async () => {
    let responseNumber = 0;
    mockArchive(
      archive,
      ({ offset, end, body }) =>
        new Response(Uint8Array.from(body), {
          status: 206,
          headers: {
            "Content-Range": `bytes ${offset}-${end}/${archive.length}`,
            ETag: `"revision-${++responseNumber}"`,
          },
        }),
    );
    const reader = createMapsTilesetTileReader(createFixturePmtilesTileset());
    await expect(reader.fetchTile(tile0, new AbortController().signal)).rejects.toThrow(/ETag/);
    reader.dispose();
  });

  it("aborts a pending archive fetch when the reader is disposed", async () => {
    const fetchMock = vi.fn(
      (_url: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            {
              once: true,
            },
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const reader = createMapsTilesetTileReader(createFixturePmtilesTileset());
    const pending = reader.fetchTile(tile0, new AbortController().signal);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    reader.dispose();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});
