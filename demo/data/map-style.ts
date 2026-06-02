import type { RasterMapStyle } from "@moritzbrantner/maps";

export const demoMapStyle: RasterMapStyle | undefined =
  typeof window !== "undefined" && new URLSearchParams(window.location.search).has("e2e")
    ? { tiles: false }
    : undefined;
