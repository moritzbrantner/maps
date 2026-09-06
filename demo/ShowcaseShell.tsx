import { useSyncExternalStore, type ReactNode } from "react";

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
            <strong>{runtimeStatus.label}</strong>
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
