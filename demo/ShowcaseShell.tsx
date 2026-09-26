import { useSyncExternalStore, type ReactNode } from "react";

import { RendererComparison } from "./RendererComparison";
import { getRustRuntimeStatus, subscribeRustRuntimeStatus } from "./rust-runtime-status";

export function ShowcaseShell({ children }: { children: ReactNode }) {
  const runtimeStatus = useSyncExternalStore(
    subscribeRustRuntimeStatus,
    getRustRuntimeStatus,
    getRustRuntimeStatus,
  );
  const pagesBase = import.meta.env.BASE_URL;

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
            editing in one live workbench. Maps owns the map semantics and camera; Rust/WASM drives
            the first-party runtime and wgpu rendering path instead of delegating the product map to
            MapLibre.
          </p>
          <nav className="maps-showcase__project-links" aria-label="Project evidence">
            <a href={`${pagesBase}benchmarks/`}>Benchmarks</a>
            <a href={`${pagesBase}stats/`}>Stats</a>
            <a href={`${pagesBase}evidence/`}>Evidence</a>
            <a href="https://github.com/moritzbrantner/maps">Source</a>
          </nav>
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
            <span>Map engine</span>
            <strong>Rust/WASM + wgpu</strong>
            <small>
              First-party camera, raster base map, and application geometry. MapLibre is
              reference-only.
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
