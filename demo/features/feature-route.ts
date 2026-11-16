import type { HeatFieldRenderMode } from "../../src";

/** Capability families that run on the first-party engine today (#176). */
export const featureRoutes = [
  { id: "heat", label: "Heat / scalar" },
  { id: "clusters", label: "Layers & clustering" },
  { id: "polygons", label: "Polygons / GeoJSON" },
  { id: "timeline", label: "Timeline" },
] as const;

/** Families that are not first-party yet. Listed as text only: no route, no MapLibre fallback. */
export const comingFeatures = [
  { label: "Measurement & editing", issue: 174 },
  { label: "Transformations", issue: 173 },
] as const;

export type FeatureId = (typeof featureRoutes)[number]["id"];
export type HeatBasemap = "synthetic" | "atlas" | "none";
export type FeatureRoute = {
  feature: FeatureId;
  heatBasemap: HeatBasemap;
  heatMode: HeatFieldRenderMode;
};

const heatModes: readonly HeatFieldRenderMode[] = ["raster", "raster-contours", "contours"];
const heatBasemaps: readonly HeatBasemap[] = ["synthetic", "atlas", "none"];
const defaultRoute: FeatureRoute = {
  feature: "heat",
  heatBasemap: "synthetic",
  heatMode: "raster-contours",
};

export function readFeatureRoute(search: string): FeatureRoute {
  const params = new URLSearchParams(search);
  const feature = featureRoutes.find((route) => route.id === params.get("feature"))?.id;
  const mode = heatModes.find((value) => value === params.get("mode"));
  const basemap = heatBasemaps.find((value) => value === params.get("basemap"));
  return {
    feature: feature ?? defaultRoute.feature,
    heatBasemap: basemap ?? defaultRoute.heatBasemap,
    heatMode: mode ?? defaultRoute.heatMode,
  };
}

/** The shareable query for a route; the heat render mode is kept only on the heat route. */
export function featureSearch(route: FeatureRoute): string {
  const params = new URLSearchParams({ feature: route.feature });
  if (route.feature === "heat" && route.heatMode !== defaultRoute.heatMode) {
    params.set("mode", route.heatMode);
  }
  if (route.feature === "heat" && route.heatBasemap !== defaultRoute.heatBasemap) {
    params.set("basemap", route.heatBasemap);
  }
  return `?${params}`;
}
