import { createRoot } from "react-dom/client";
import "@moritzbrantner/ui/atlas/styles.css";
import "@moritzbrantner/ui/component-sources.css";
import "../styles.css";
import "./engine.css";
import { initializeMapsAggregationWasm } from "../src/aggregation-runtime";
import { configureMapsWasmPackage } from "../src/aggregation-wasm";
import { EnginePage } from "./EnginePage";

const root = createRoot(document.getElementById("root")!);
root.render(
  <main className="engine-loading" role="status">
    Loading Maps engine…
  </main>,
);

async function bootstrap() {
  const wasmPackage = new URL(`${import.meta.env.BASE_URL}wasm/maps_wasm.js`, location.origin).href;
  configureMapsWasmPackage(wasmPackage);
  if (!(await initializeMapsAggregationWasm({ wasmPackage }))) {
    throw new Error("The Maps engine could not load. Reload to try again.");
  }
  root.render(<EnginePage />);
}

bootstrap().catch((error: unknown) => {
  root.render(
    <main className="engine-loading" role="alert">
      <h1>Maps engine unavailable</h1>
      <p>{error instanceof Error ? error.message : "The Maps engine could not load."}</p>
      <a href={`${import.meta.env.BASE_URL}stats/`}>Stats</a>
    </main>,
  );
});
