import { useSyncExternalStore, type ReactNode } from "react";

import { RendererComparison } from "./RendererComparison";
import { getRustRuntimeStatus, subscribeRustRuntimeStatus } from "./rust-runtime-status";

export function ShowcaseShell({ children }: { children: ReactNode }) {
  const runtimeStatus = useSyncExternalStore(
    subscribeRustRuntimeStatus,
    getRustRuntimeStatus,
    getRustRuntimeStatus,
  );

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
            heavy geographic computation while browser renderers remain replaceable pixel backends.
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
            <strong>{runtimeStatus.label}</strong>
            <small>{runtimeStatus.detail}</small>
          </article>
          <article className="maps-showcase__runtime-card">
            <span>Renderers</span>
            <strong>MapLibre + Canvas2D</strong>
            <small>
              Shared Maps semantics; camera/basemap stay MapLibre-owned in this horizon.
            </small>
          </article>
          <article className="maps-showcase__runtime-card">
            <span>Capabilities</span>
            <strong>11 live views</strong>
            <small>Points, fields, flows, time, globe, composition, and editing.</small>
          </article>
        </div>
      </header>

      <div className="maps-showcase__content">{children}</div>
      <RendererComparison />
    </div>
  );
}
