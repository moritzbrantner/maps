import { useCallback } from "react";

import type { MapSurfaceController } from "../src";
import { HistoryDemoView } from "./components/HistoryDemoView";

declare global {
  interface Window {
    mapsHistoryAcceptance?: { controller: MapSurfaceController };
  }
}

/**
 * The History demo's integrated journey on `flatRuntime="maps"` (#231 phase D): the same
 * History composition, Map-Scoped Timeline clock and historical selection as the History tab,
 * with no MapLibre map behind it. Only the camera controller is published, for browser
 * evidence that projects geographic positions.
 */
export function MapsHistoryRuntimeAcceptance() {
  const publishController = useCallback((controller: MapSurfaceController) => {
    window.mapsHistoryAcceptance = { controller };
  }, []);

  return <HistoryDemoView flatRuntime="maps" onMapControllerReady={publishController} />;
}
