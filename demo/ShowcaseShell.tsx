import { useEffect, useState, type ReactNode } from "react";

type RuntimeState = "loading" | "verified" | "unavailable";

type RuntimeStatus = {
  detail: string;
  state: RuntimeState;
};

type HostedWasmIndex = {
  free(): void;
  getViewportAggregation(query: {
    bounds: [number, number, number, number];
    zoom: number;
  }): { features: unknown[] };
};

type HostedWasmModule = {
  default?: (moduleOrPath?: unknown) => Promise<unknown>;
  MapsPointAggregationIndex?: new (
    points: Array<{
      id: string;
      label: string;
      latitude: number;
      longitude: number;
      metrics: Record<string, number>;
    }>,
    options: { extent: number; maxZoom: number; minZoom: number; radius: number },
  ) => HostedWasmIndex;
};

const hostedRustProbeEnabled = import.meta.env.VITE_MAPS_WASM_SHOWCASE === "1";

export function ShowcaseShell({ children }: { children: ReactNode }) {
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatus>(() =>
    hostedRustProbeEnabled
      ? {
          detail: "Initializing the packaged point index in this browser.",
          state: "loading",
        }
      : {
          detail: "The hosted Pages build runs the packaged Rust/WASM probe.",
          state: "unavailable",
        },
  );

  useEffect(() => {
    if (!hostedRustProbeEnabled) {
      return;
    }

    let active = true;

    void verifyHostedRustRuntime()
      .then(() => {
        if (!active) return;
        setRuntimeStatus({
          detail: "Point index initialized and answered a deterministic viewport query.",
          state: "verified",
        });
      })
      .catch(() => {
        if (!active) return;
        setRuntimeStatus({
          detail: "Rust/WASM probe unavailable; browser rendering remains usable.",
          state: "unavailable",
        });
      });

    return () => {
      active = false;
    };
  }, []);

  return (
    <div className="maps-showcase">
      <header className="maps-showcase__hero">
        <div className="maps-showcase__intro">
          <div className="maps-showcase__eyebrow">
            <span>@moritzbrantner/maps</span>
            <span>Map Library</span>
          </div>
          <h1>Map building blocks, end to end.</h1>
          <p>
            Clustering, scalar fields, flows, timelines, globe display, GeoJSON operations, and
            editing in one live workbench. Maps owns the domain logic; Rust/WASM is taking over the
            heavy geographic computation while MapLibre remains the browser rendering surface.
          </p>
        </div>

        <div className="maps-showcase__runtime-grid" aria-label="Runtime architecture">
          <article
            className="maps-showcase__runtime-card"
            data-state={runtimeStatus.state}
            data-testid="rust-runtime-status"
            aria-live="polite"
          >
            <span>Rust core</span>
            <strong>{formatRuntimeState(runtimeStatus.state)}</strong>
            <small>{runtimeStatus.detail}</small>
          </article>
          <article className="maps-showcase__runtime-card">
            <span>Renderer</span>
            <strong>MapLibre</strong>
            <small>Camera, basemap, picking, and current browser presentation.</small>
          </article>
          <article className="maps-showcase__runtime-card">
            <span>Capabilities</span>
            <strong>11 live views</strong>
            <small>Points, fields, flows, time, globe, composition, and editing.</small>
          </article>
        </div>
      </header>

      <div className="maps-showcase__content">{children}</div>
    </div>
  );
}

function formatRuntimeState(state: RuntimeState) {
  switch (state) {
    case "loading":
      return "Loading";
    case "verified":
      return "Verified";
    case "unavailable":
      return hostedRustProbeEnabled ? "Fallback" : "Hosted probe";
  }
}

async function verifyHostedRustRuntime() {
  const dynamicImport = new Function("specifier", "return import(specifier)") as (
    specifier: string,
  ) => Promise<HostedWasmModule>;
  const moduleUrl = new URL("wasm/maps_wasm.js", document.baseURI).href;
  const wasmModule = await dynamicImport(moduleUrl);

  await wasmModule.default?.();

  const Index = wasmModule.MapsPointAggregationIndex;
  if (!Index) {
    throw new Error("MapsPointAggregationIndex is unavailable in the hosted WASM module.");
  }

  const index = new Index(
    [
      {
        id: "berlin",
        label: "Berlin",
        latitude: 52.52,
        longitude: 13.405,
        metrics: { demand: 2 },
      },
      {
        id: "stuttgart",
        label: "Stuttgart",
        latitude: 48.7758,
        longitude: 9.1829,
        metrics: { demand: 3 },
      },
    ],
    { extent: 512, maxZoom: 16, minZoom: 0, radius: 72 },
  );

  try {
    const result = index.getViewportAggregation({
      bounds: [8, 47, 14, 53],
      zoom: 17,
    });

    if (result.features.length !== 2) {
      throw new Error(`Expected two Rust/WASM point features, received ${result.features.length}.`);
    }
  } finally {
    index.free();
  }
}
