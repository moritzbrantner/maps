"use client";

import {
  useEffect,
  useId,
  useMemo,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from "react";

import {
  loadMapsPlaceSearchIndex,
  MapsPlaceSearchUnavailableError,
  type MapsPlaceSearchIndex,
  type MapsPlaceSearchLoadOptions,
  type MapsPlaceSearchResult,
  type MapsPlaceSearchUnavailableReason,
} from "./maps-place-search";
import type { MapsTilesetMetadata } from "./maps-tileset";

export type MapsPlaceSearchState =
  | { status: "loading"; index: null; reason: null }
  | { status: "ready"; index: MapsPlaceSearchIndex; reason: null }
  | { status: "unavailable"; index: null; reason: MapsPlaceSearchUnavailableReason };

type SearchableTileset = Pick<MapsTilesetMetadata, "sourceId" | "dataRevision" | "searchIndex">;

const unavailable = (reason: MapsPlaceSearchUnavailableReason): MapsPlaceSearchState => ({
  status: "unavailable",
  index: null,
  reason,
});

/**
 * Lazily load the index pinned by the active tileset. Changing source, revision or index
 * aborts the previous load; a superseded load can never replace the current index.
 */
export function useMapsPlaceSearchIndex(
  tileset: SearchableTileset | null,
  options: Pick<MapsPlaceSearchLoadOptions, "fetch" | "cache"> = {},
): MapsPlaceSearchState {
  const identity = tileset
    ? [tileset.sourceId, tileset.dataRevision, tileset.searchIndex?.sha256 ?? "", tileset.searchIndex?.url ?? ""].join("\u0000")
    : "";
  const [state, setState] = useState<{ identity: string; value: MapsPlaceSearchState }>(() => ({
    identity,
    value: tileset?.searchIndex ? { status: "loading", index: null, reason: null } : unavailable("no-index"),
  }));
  const { fetch: fetchOption, cache } = options;

  useEffect(() => {
    if (!tileset?.searchIndex) {
      setState({ identity, value: unavailable("no-index") });
      return;
    }
    const controller = new AbortController();
    setState({ identity, value: { status: "loading", index: null, reason: null } });
    loadMapsPlaceSearchIndex(tileset, {
      signal: controller.signal,
      ...(fetchOption ? { fetch: fetchOption } : {}),
      ...(cache !== undefined ? { cache } : {}),
    }).then(
      (index) => {
        if (!controller.signal.aborted) {
          setState({ identity, value: { status: "ready", index, reason: null } });
        }
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          identity,
          value: unavailable(error instanceof MapsPlaceSearchUnavailableError ? error.reason : "invalid"),
        });
      },
    );
    return () => controller.abort();
    // `identity` captures every tileset field that selects an index revision.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity, fetchOption, cache]);

  if (state.identity !== identity) {
    return tileset?.searchIndex
      ? { status: "loading", index: null, reason: null }
      : unavailable("no-index");
  }
  return state.value;
}

const REASONS: Record<MapsPlaceSearchUnavailableReason, string> = {
  "no-index": "Place search is not available for this map source.",
  unsupported: "This map source's search index format is not supported.",
  "hash-mismatch": "The search index does not match this map source revision.",
  "revision-mismatch": "The search index belongs to a different map source revision.",
  offline: "Place search needs this exact index revision, which is not available offline.",
  invalid: "The search index for this map source is invalid.",
};

const formatCoordinate = (value: number, positive: string, negative: string) =>
  `${Math.abs(value).toFixed(2)}°${value < 0 ? negative : positive}`;

/** Human-readable distinguishing detail for same-name places. */
export function describeMapsPlaceSearchResult(result: MapsPlaceSearchResult): string {
  const parts = [result.type];
  if (result.context) parts.push(result.context);
  parts.push(
    `${formatCoordinate(result.center[1], "N", "S")} ${formatCoordinate(result.center[0], "E", "W")}`,
  );
  if (result.matchedName !== result.name) parts.push(`matched “${result.matchedName}”`);
  return parts.join(" · ");
}

export type MapPlaceSearchProps = {
  /** The active Maps Tileset; its optional `searchIndex` pins the exact index revision. */
  tileset: SearchableTileset | null;
  onSelect: (result: MapsPlaceSearchResult) => void;
  label?: string;
  placeholder?: string;
  limit?: number;
  className?: string;
  loadOptions?: Pick<MapsPlaceSearchLoadOptions, "fetch" | "cache">;
};

/** Keyboard-navigable combobox over a source-pinned, precomputed place index. */
export function MapPlaceSearch({
  tileset,
  onSelect,
  label = "Search places",
  placeholder = "Place name",
  limit,
  className,
  loadOptions,
}: MapPlaceSearchProps) {
  const id = useId();
  const listId = `${id}-results`;
  const state = useMapsPlaceSearchIndex(tileset, loadOptions);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const indexKey = state.index ? `${state.index.sourceId}@${state.index.dataRevision}` : "";

  useEffect(() => {
    setQuery("");
    setOpen(false);
    setActive(0);
  }, [indexKey]);

  const results = useMemo(
    () => (state.index && query ? state.index.search(query, limit ? { limit } : {}) : []),
    [state.index, query, limit],
  );
  const expanded = open && query.trim().length > 0 && state.status === "ready";
  const activeResult = expanded ? results[active] : undefined;

  const choose = (result: MapsPlaceSearchResult) => {
    setOpen(false);
    setQuery(result.name);
    onSelect(result);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      if (!results.length) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((current) => (current + step + results.length) % results.length);
    } else if (event.key === "Enter" && activeResult) {
      event.preventDefault();
      choose(activeResult);
    } else if (event.key === "Escape") {
      setOpen(false);
    }
  };

  let status = "";
  if (state.status === "loading") status = "Loading place index…";
  else if (state.status === "unavailable") status = REASONS[state.reason];
  else if (expanded && !results.length) status = "No matching places in this map source.";
  else if (expanded) status = `${results.length} place${results.length === 1 ? "" : "s"} found.`;

  return (
    <div className={["mb-place-search", className].filter(Boolean).join(" ")} data-state={state.status}>
      <label className="mb-place-search__label" htmlFor={`${id}-input`}>
        {label}
      </label>
      <input
        id={`${id}-input`}
        className="mb-place-search__input"
        type="search"
        role="combobox"
        autoComplete="off"
        spellCheck={false}
        aria-autocomplete="list"
        aria-expanded={expanded}
        aria-controls={listId}
        aria-activedescendant={activeResult ? `${id}-option-${active}` : undefined}
        disabled={state.status !== "ready"}
        placeholder={placeholder}
        value={query}
        onChange={(event: ChangeEvent<HTMLInputElement>) => {
          setQuery(event.target.value);
          setActive(0);
          setOpen(true);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => setOpen(false)}
        onFocus={() => setOpen(true)}
      />
      <ul id={listId} role="listbox" aria-label={`${label} results`} className="mb-place-search__results" hidden={!expanded || !results.length}>
        {expanded
          ? results.map((result, index) => (
              <li
                key={result.key}
                id={`${id}-option-${index}`}
                role="option"
                aria-selected={index === active}
                className="mb-place-search__option"
                data-place-key={result.key}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActive(index)}
                onClick={() => choose(result)}
              >
                <span className="mb-place-search__name">{result.name}</span>
                <span className="mb-place-search__detail">{describeMapsPlaceSearchResult(result)}</span>
              </li>
            ))
          : null}
      </ul>
      <p className="mb-place-search__status" role="status" aria-live="polite">
        {status}
      </p>
    </div>
  );
}
