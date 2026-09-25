import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import "@moritzbrantner/ui/atlas/styles.css";
import "@moritzbrantner/ui/component-sources.css";
import "../styles.css";
import "./styles.css";
import "./showcase.css";
import "./showcase-stage.css";
import "./project-links.css";

import { initializeMapsAggregationWasm } from "../src/aggregation-runtime";
import { configureMapsWasmPackage } from "../src/aggregation-wasm";
import { App } from "./App";
import { MapsOrientedRuntimeAcceptance } from "./MapsOrientedRuntimeAcceptance";
import { MapsRuntimeAcceptance } from "./MapsRuntimeAcceptance";
import {
  markRustRuntimeLoaded,
  markRustRuntimeLoading,
  markRustRuntimeUnavailable,
  recordRustAggregationDiagnostic,
} from "./rust-runtime-status";
import { ShowcaseShell } from "./ShowcaseShell";

const queryClient = new QueryClient();

void bootstrap();

async function bootstrap() {
  await initializeHostedRustRuntime();

  if (isBenchmarksPath(window.location.pathname)) {
    const { BenchmarksPage } = await import("./BenchmarksPage");
    createRoot(document.getElementById("root")!).render(
      <StrictMode>
        <QueryClientProvider client={queryClient}>
          <BenchmarksPage />
        </QueryClientProvider>
      </StrictMode>,
    );
    return;
  }

  const acceptanceMode = new URLSearchParams(window.location.search).get("acceptance");
  let content = <App />;

  if (acceptanceMode === "maps-runtime") {
    content = <MapsRuntimeAcceptance />;
  } else if (acceptanceMode === "maps-runtime-wgpu-strokes") {
    content = <MapsRuntimeAcceptance includePolygon={false} />;
  } else if (acceptanceMode === "maps-runtime-raster-fetch") {
    content = (
      <MapsRuntimeAcceptance
        includePolygon={false}
        rasterTileUrl="https://tiles.example.test/{z}/{x}/{y}.png"
      />
    );
  } else if (acceptanceMode === "maps-runtime-oriented") {
    content = <MapsOrientedRuntimeAcceptance />;
  }

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <ShowcaseShell>{content}</ShowcaseShell>
      </QueryClientProvider>
    </StrictMode>,
  );
}

async function initializeHostedRustRuntime() {
  if (import.meta.env.VITE_MAPS_WASM_SHOWCASE !== "1") {
    return;
  }

  markRustRuntimeLoading();

  const moduleUrl = new URL(
    `${import.meta.env.BASE_URL}wasm/maps_wasm.js`,
    window.location.origin,
  ).href;
  configureMapsWasmPackage(moduleUrl);

  const initialized = await initializeMapsAggregationWasm({
    onDiagnostic: recordRustAggregationDiagnostic,
    wasmPackage: moduleUrl,
  });

  if (initialized) {
    markRustRuntimeLoaded();
    return;
  }

  markRustRuntimeUnavailable(
    "Rust/WASM could not initialize; the deterministic control path remains active.",
  );
}

function isBenchmarksPath(pathname: string) {
  const segments = pathname.split("/").filter(Boolean);
  return segments.at(-1) === "benchmarks";
}
