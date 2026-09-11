import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import "@moritzbrantner/ui/atlas/styles.css";
import "@moritzbrantner/ui/component-sources.css";
import "../styles.css";
import "./styles.css";
import "./showcase.css";
import "./showcase-stage.css";

import { initializeMapsAggregationWasm } from "../src/aggregation-runtime";
import { configureMapsWasmPackage } from "../src/aggregation-wasm";
import { App } from "./App";
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

  const acceptanceMode = new URLSearchParams(window.location.search).get("acceptance");
  const content = acceptanceMode === "maps-runtime" ? <MapsRuntimeAcceptance /> : <App />;

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

  const moduleUrl = new URL("wasm/maps_wasm.js", document.baseURI).href;
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
