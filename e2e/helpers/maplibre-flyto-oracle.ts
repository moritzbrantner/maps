// Reference oracle for the first-party animated flyTo (#433): a transliteration of MapLibre
// GL JS 6.4.1 `Camera.flyTo` + `MercatorCameraHelper.handleFlyTo` (default curve 1.42,
// speed 1.2, no offset/padding, renderWorldCopies, minZoom 0) and of the default
// `@mapbox/unitbezier(0.25, 0.1, 0.25, 1)` easing. It is independent of the Rust code.

export type OracleCamera = {
  bearing: number;
  center: [number, number];
  pitch: number;
  zoom: number;
};

export function maplibreDefaultEasing(x: number) {
  const [p1x, p1y, p2x, p2y] = [0.25, 0.1, 0.25, 1];
  const cx = 3 * p1x;
  const bx = 3 * (p2x - p1x) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * p1y;
  const by = 3 * (p2y - p1y) - cy;
  const ay = 1 - cy - by;
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t;
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  let t = x;
  for (let i = 0; i < 8; i++) {
    const x2 = ((ax * t + bx) * t + cx) * t - x;
    if (Math.abs(x2) < 1e-6) return sampleY(t);
    const d2 = (3 * ax * t + 2 * bx) * t + cx;
    if (Math.abs(d2) < 1e-6) break;
    t -= x2 / d2;
  }
  let t0 = 0;
  let t1 = 1;
  t = x;
  for (let i = 0; i < 20; i++) {
    const x2 = ((ax * t + bx) * t + cx) * t;
    if (Math.abs(x2 - x) < 1e-6) break;
    if (x > x2) t0 = t;
    else t1 = t;
    t = (t0 + t1) * 0.5;
  }
  return sampleY(t);
}

const mercatorX = (lng: number) => (180 + lng) / 360;
const mercatorY = (lat: number) =>
  (180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))) / 360;
const lngFromX = (x: number) => x * 360 - 180;
const latFromY = (y: number) =>
  (360 / Math.PI) * Math.atan(Math.exp(((180 - y * 360) * Math.PI) / 180)) - 90;
const wrap = (value: number) => ((((value + 180) % 360) + 360) % 360) - 180;

/** The MapLibre flight from `start` to `target` in a `width` × `height` viewport. */
export function maplibreFlyTo(
  start: OracleCamera,
  target: OracleCamera,
  size: { height: number; width: number },
) {
  let targetLng = target.center[0];
  const deltaLng = targetLng - start.center[0];
  targetLng += deltaLng > 180 ? -360 : deltaLng < -180 ? 360 : 0;
  let bearing = wrap(target.bearing);
  const diff = Math.abs(bearing - start.bearing);
  if (Math.abs(bearing - 360 - start.bearing) < diff) bearing -= 360;
  if (Math.abs(bearing + 360 - start.bearing) < diff) bearing += 360;

  const worldSize = 512 * 2 ** start.zoom;
  const from = [mercatorX(start.center[0]) * worldSize, mercatorY(start.center[1]) * worldSize];
  const to = [mercatorX(targetLng) * worldSize, mercatorY(target.center[1]) * worldSize];
  const delta = [to[0]! - from[0]!, to[1]! - from[1]!];
  const u1 = Math.hypot(delta[0]!, delta[1]!);
  const w0 = Math.max(size.width, size.height);
  const w1 = w0 / 2 ** (target.zoom - start.zoom);
  const wMax = w0 / 2 ** (Math.min(0, start.zoom, target.zoom) - start.zoom);
  const rho = Math.min(1.42, Math.sqrt((wMax / u1) * 2));
  const rho2 = rho * rho;
  const zoomOutFactor = (descent: boolean) => {
    const b =
      (w1 * w1 - w0 * w0 + (descent ? -1 : 1) * rho2 * rho2 * u1 * u1) /
      (2 * (descent ? w1 : w0) * rho2 * u1);
    return Math.log(Math.sqrt(b * b + 1) - b);
  };
  const r0 = zoomOutFactor(false);
  const length = (zoomOutFactor(true) - r0) / rho;
  const durationMs = (1000 * length) / 1.2;

  /** The camera at eased progress `k`. */
  const at = (k: number): OracleCamera => {
    const s = k * length;
    const w = Math.cosh(r0) / Math.cosh(r0 + rho * s);
    const u = (w0 * ((Math.cosh(r0) * Math.tanh(r0 + rho * s) - Math.sinh(r0)) / rho2)) / u1;
    return {
      bearing: start.bearing + (bearing - start.bearing) * k,
      center: [
        wrap(lngFromX((from[0]! + delta[0]! * u) / worldSize)),
        latFromY((from[1]! + delta[1]! * u) / worldSize),
      ],
      pitch: start.pitch + (target.pitch - start.pitch) * k,
      zoom: start.zoom + Math.log2(1 / w),
    };
  };
  return { at, bearing, durationMs };
}
