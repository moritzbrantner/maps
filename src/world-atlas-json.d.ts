declare module "world-atlas/countries-50m.json" {
  import type { GeometryCollection, Topology } from "topojson-specification";

  const topology: Topology<{
    countries: GeometryCollection;
    land: GeometryCollection;
  }>;

  export default topology;
}
