import type { MapInteractionMode } from "./map-surface-context";

/** First-party layer input, projected only by the live Rust camera. */
export type MapsLayerInteractionEvent =
  | { type: "cancel" }
  | { type: "camera" }
  | {
      type: "click" | "move";
      position: { x: number; y: number };
      coordinates: [longitude: number, latitude: number];
    };

export type MapsLayerInteraction = {
  project(coordinate: [longitude: number, latitude: number]): { x: number; y: number } | null;
  getPitch(): number;
  getMode(): MapInteractionMode;
  /** Return true to consume a pick before unrelated Map Layers receive it. */
  subscribe(listener: (event: MapsLayerInteractionEvent) => boolean | void): () => void;
};
