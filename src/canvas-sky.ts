import type { MapsFlatRasterSky } from "./flat-runtime-wasm";

/** Gradient stops along the horizon blend; MapLibre's `pow(1 - d, 2)` is not linear. */
const SKY_GRADIENT_STOPS = 16;

export function premultipliedCssColor([r, g, b, a]: readonly [number, number, number, number]) {
  if (a === 0) return "rgba(0,0,0,0)";
  const channel = (value: number) => Math.round((value / a) * 255);
  return `rgba(${channel(r)},${channel(g)},${channel(b)},${a})`;
}

/**
 * The band above the horizon on the Canvas path, the same band the wgpu backend draws from
 * the Rust frame plan: cleared to transparent (the page behind the map), then the style's sky
 * if it has one. `margin` is the CSS px the render surface extends beyond the viewport.
 */
export function drawCanvasSky(
  context: CanvasRenderingContext2D,
  sky: MapsFlatRasterSky,
  surfaceWidth: number,
  margin: number,
) {
  const bottom = margin + sky.horizonY;
  context.clearRect(0, 0, surfaceWidth, bottom);
  if (sky.skyColor[3] === 0 && sky.horizonColor[3] === 0) return;
  if (sky.horizonBlend > 0) {
    const gradient = context.createLinearGradient(0, bottom, 0, bottom - sky.horizonBlend);
    for (let index = 0; index <= SKY_GRADIENT_STOPS; index += 1) {
      const above = index / SKY_GRADIENT_STOPS;
      const fade = (1 - above) * (1 - above);
      const color = sky.skyColor.map(
        (channel, component) => channel * (1 - fade) + sky.horizonColor[component]! * fade,
      ) as unknown as readonly [number, number, number, number];
      gradient.addColorStop(above, premultipliedCssColor(color));
    }
    context.fillStyle = gradient;
  } else {
    context.fillStyle = premultipliedCssColor(sky.skyColor);
  }
  context.fillRect(0, 0, surfaceWidth, bottom);
}
