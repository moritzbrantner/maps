/** Shared by the Node tile cutter (`vector-tiles.ts`) and the browser fixture. */
export const VECTOR_MAX_ZOOM = 12;
/** The `land` polygon covers more than any camera reaches, so its edge never shows. */
export const LAND_BOUNDS: [west: number, south: number, east: number, north: number] = [4, 44, 14, 50];
