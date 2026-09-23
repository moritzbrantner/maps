"use client";

import { useLayoutEffect, useRef } from "react";
import {
  createMapsBrowserRuntime,
  runtimeIdentity,
  type MapsBrowserRuntimeOptions,
} from "./maps-browser-runtime";

export type { MapsCanvasFlatRuntimeController } from "./maps-browser-runtime";

/** React publishes only committed inputs. Input, resources and frames live in the browser host. */
export function MapsCanvasFlatRuntime(props: MapsBrowserRuntimeOptions) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const fallbackCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const hostRef = useRef<ReturnType<typeof createMapsBrowserRuntime> | null>(null);
  const identity = runtimeIdentity(props);

  useLayoutEffect(() => {
    const host = createMapsBrowserRuntime(canvasRef.current!, fallbackCanvasRef.current!, props);
    hostRef.current = host;
    return () => {
      hostRef.current = null;
      host.dispose();
    };
  }, [identity]);

  useLayoutEffect(() => {
    hostRef.current?.update(props);
  });

  return (
    <>
      <canvas
        className="mb-maps__canvas mb-maps__canvas-flat"
        data-flat-runtime="maps"
        data-map-base-renderer="pending"
        data-map-base-tiles="0"
        ref={canvasRef}
        style={{ touchAction: "none" }}
      />
      <canvas
        aria-hidden="true"
        className="mb-maps__canvas mb-maps__canvas-flat"
        data-map-base-fallback="canvas2d"
        ref={fallbackCanvasRef}
        style={{ pointerEvents: "none", touchAction: "none", visibility: "hidden" }}
      />
    </>
  );
}
