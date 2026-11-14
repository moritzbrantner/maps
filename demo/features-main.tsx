import { createRoot } from "react-dom/client";
import "@moritzbrantner/ui/atlas/styles.css";
import "@moritzbrantner/ui/component-sources.css";
import "../styles.css";
import "./engine.css";
import "./features/features.css";
import { FeaturesPage } from "./features/FeaturesPage";
import { loadHostedMapsWasm } from "./maps-wasm-bootstrap";

const root = createRoot(document.getElementById("root")!);
root.render(
  <main className="engine-loading" role="status">
    Loading Maps engine…
  </main>,
);

loadHostedMapsWasm()
  .then(() => root.render(<FeaturesPage />))
  .catch((error: unknown) => {
    root.render(
      <main className="engine-loading" role="alert">
        <h1>Maps engine unavailable</h1>
        <p>{error instanceof Error ? error.message : "The Maps engine could not load."}</p>
        <a href={`${import.meta.env.BASE_URL}engine/`}>Engine</a>
      </main>,
    );
  });
