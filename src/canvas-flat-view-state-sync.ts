import type { MapViewState } from "./map-display";

const MAX_PENDING_VIEW_STATE_ECHOES = 128;

export function createMapsViewStateEchoTracker() {
  const pending: MapViewState[] = [];

  return {
    acknowledge(viewState: MapViewState) {
      const index = pending.findIndex((candidate) => areMapsViewStatesEqual(candidate, viewState));
      if (index < 0) return false;

      pending.splice(0, index + 1);
      return true;
    },
    clear() {
      pending.length = 0;
    },
    record(viewState: MapViewState) {
      pending.push({
        center: [viewState.center[0], viewState.center[1]],
        zoom: viewState.zoom,
      });

      if (pending.length > MAX_PENDING_VIEW_STATE_ECHOES) {
        pending.splice(0, pending.length - MAX_PENDING_VIEW_STATE_ECHOES);
      }
    },
  };
}

export function areMapsViewStatesEqual(left: MapViewState, right: MapViewState) {
  return (
    Math.abs(left.center[0] - right.center[0]) < 1e-10 &&
    Math.abs(left.center[1] - right.center[1]) < 1e-10 &&
    Math.abs(left.zoom - right.zoom) < 1e-10
  );
}
