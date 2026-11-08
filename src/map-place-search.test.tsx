import { readFileSync } from "node:fs";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { withFixturePlaceSearch } from "../demo/place-search-fixtures";
import { createShowcaseTileset } from "../demo/showcase-tileset";
import { MapPlaceSearch } from "./map-place-search";
import type { MapsPlaceSearchResult } from "./maps-place-search";
import { createFixturePmtilesXyzTileset } from "./tileset-fixtures";

const files: Record<string, Uint8Array> = {
  "/search-indexes/maps-showcase-places-r1.json": readFileSync(
    "public/search-indexes/maps-showcase-places-r1.json",
  ),
  "/search-indexes/fixture-pmtiles-xyz-places-r1.json": readFileSync(
    "public/search-indexes/fixture-pmtiles-xyz-places-r1.json",
  ),
};
const showcase = withFixturePlaceSearch(createShowcaseTileset("/"), "/");
const xyz = withFixturePlaceSearch(createFixturePmtilesXyzTileset("/"), "/");

function deferredFetch() {
  const pending: Array<{ url: string; resolve: () => void; signal: AbortSignal | undefined }> = [];
  const fetch = vi.fn(
    (url: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((resolve) => {
        pending.push({
          url: String(url),
          signal: init?.signal ?? undefined,
          resolve: () => resolve(new Response(new Uint8Array(files[String(url)]!))),
        });
      }),
  );
  return { fetch, pending };
}

async function enabled(input: HTMLElement) {
  await waitFor(() => expect((input as HTMLInputElement).disabled).toBe(false));
}

describe("Map UI place search", () => {
  it("returns disambiguated, keyboard-selectable results from the pinned index", async () => {
    const onSelect = vi.fn<(result: MapsPlaceSearchResult) => void>();
    const fetch = vi.fn(async (url: RequestInfo | URL) => new Response(new Uint8Array(files[String(url)]!)));
    render(<MapPlaceSearch tileset={showcase} onSelect={onSelect} loadOptions={{ fetch, cache: null }} />);
    const input = await screen.findByRole("combobox", { name: "Search places" });
    await enabled(input);

    fireEvent.change(input, { target: { value: "harbor" } });
    const options = screen.getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([
      "Harbor Pointlocality · Northern shore · 45.00°N 20.00°E",
      "Harbor Pointlocality · Southern shore · 30.00°S 60.00°W",
    ]);
    expect(input!.getAttribute("aria-expanded")).toBe("true");
    expect(input!.getAttribute("aria-activedescendant")).toBe(options[0]!.id);
    expect(screen.getByRole("status").textContent).toContain("2 places found.");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input!.getAttribute("aria-activedescendant")).toBe(options[1]!.id);
    expect(options[1]!.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ key: "showcase/harbor-point-south", bounds: [-65, -35, -55, -25] }),
    );
    expect(input!.getAttribute("aria-expanded")).toBe("false");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("renders producer text as text, never markup", async () => {
    const payload = '<img src=x onerror="window.__xss=1">';
    const artifact = {
      schema: "maps-place-search-v1",
      sourceId: "xss",
      dataRevision: "1",
      languages: ["en"],
      attribution: "x",
      license: "CC0-1.0",
      provenance: "x",
      places: [
        { id: "p", name: payload, language: "en", type: "locality", aliases: [], center: [0, 0], bounds: [0, 0, 0, 0] },
      ],
    };
    const bytes = new TextEncoder().encode(JSON.stringify(artifact));
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const sha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    const tileset = {
      sourceId: "xss",
      dataRevision: "1",
      searchIndex: { ...showcase.searchIndex!, url: "/xss.json", sha256, bytes: bytes.byteLength },
    };
    const { container } = render(
      <MapPlaceSearch
        tileset={tileset}
        onSelect={() => {}}
        loadOptions={{ fetch: async () => new Response(bytes), cache: null }}
      />,
    );
    const input = screen.getByRole("combobox");
    await enabled(input);
    fireEvent.change(input, { target: { value: "img" } });
    expect(screen.getByRole("option").textContent).toContain(payload);
    expect(container.querySelector("img")).toBeNull();
  });

  it("scopes to the chosen source and ignores a superseded index load", async () => {
    const { fetch, pending } = deferredFetch();
    const { rerender } = render(
      <MapPlaceSearch tileset={showcase} onSelect={() => {}} loadOptions={{ fetch, cache: null }} />,
    );
    await waitFor(() => expect(pending).toHaveLength(1));
    rerender(<MapPlaceSearch tileset={xyz} onSelect={() => {}} loadOptions={{ fetch, cache: null }} />);
    await waitFor(() => expect(pending).toHaveLength(2));
    expect(pending[0]!.signal?.aborted).toBe(true);

    await act(async () => pending[1]!.resolve());
    await act(async () => pending[0]!.resolve());
    const input = screen.getByRole("combobox");
    await enabled(input);
    fireEvent.change(input, { target: { value: "harbor" } });
    expect(screen.getAllByRole("option").map((option) => option.dataset.placeKey)).toEqual([
      "xyz/harbor-point",
    ]);
  });

  it("states unavailable search explicitly", async () => {
    render(<MapPlaceSearch tileset={createShowcaseTileset("/")} onSelect={() => {}} />);
    expect((screen.getByRole("combobox") as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByRole("status").textContent).toBe(
      "Place search is not available for this map source.",
    );
  });
});
