import { chromium, expect, test, type Browser } from "@playwright/test";
import { WEBGPU_SWIFTSHADER_ARGS } from "./helpers/webgpu-args";

// Graphite/Dawn on SwiftShader: WebGPU and Canvas presentation without a hardware GPU.
const CAMERA = { lon: 10.3, lat: 50.4, zoom: 4.4 };
const MAP_SIZE = { width: 640, height: 480 };

type Rgb = [number, number, number];
const FOREST: Rgb = [196, 216, 180];
const WATER: Rgb = [168, 204, 224];
const BUILDING: Rgb = [216, 200, 184];

test("retained WebGPU vector basemap matches the Canvas overlay @smoke", async ({
  baseURL,
}, testInfo) => {
  const browser = await chromium.launch({ args: WEBGPU_SWIFTSHADER_ARGS });
  try {
    const wgpu = await captureBasemap(browser, baseURL!, "wgpu");
    const canvas = await captureBasemap(browser, baseURL!, "canvas");
    expect(wgpu.gpuValidation).toEqual([]);
    await testInfo.attach("wgpu-retained.png", { body: wgpu.png, contentType: "image/png" });
    await testInfo.attach("canvas-overlay.png", { body: canvas.png, contentType: "image/png" });

    const page = await browser.newPage();
    const probes = tileProbes();
    const result = await page.evaluate(
      async ({ images, probes }) => {
        const decode = async (base64: string) => {
          const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
          const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
          const context = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d")!;
          context.drawImage(bitmap, 0, 0);
          return context.getImageData(0, 0, bitmap.width, bitmap.height);
        };
        const [gpu, reference] = await Promise.all(images.map(decode));
        let mismatched = 0;
        for (let index = 0; index < gpu!.data.length; index += 4) {
          const delta = Math.max(
            Math.abs(gpu!.data[index]! - reference!.data[index]!),
            Math.abs(gpu!.data[index + 1]! - reference!.data[index + 1]!),
            Math.abs(gpu!.data[index + 2]! - reference!.data[index + 2]!),
          );
          if (delta > 24) mismatched++;
        }
        const sample = (image: ImageData, [x, y]: [number, number]) => {
          const offset = (Math.round(y) * image.width + Math.round(x)) * 4;
          return Array.from(image.data.slice(offset, offset + 3));
        };
        return {
          mismatchRatio: mismatched / (gpu!.width * gpu!.height),
          probes: probes.map((probe) => ({
            gpu: sample(gpu!, probe.point),
            kind: probe.kind,
            reference: sample(reference!, probe.point),
          })),
        };
      },
      { images: [wgpu.png.toString("base64"), canvas.png.toString("base64")], probes },
    );

    const expected = { building: BUILDING, forest: FOREST, water: WATER };
    expect(result.probes.length).toBeGreaterThanOrEqual(6);
    for (const probe of result.probes) {
      // Holes, painter order (forest < water < building) and style colors agree.
      expectColor(probe.gpu, expected[probe.kind], probe.kind);
      expectColor(probe.reference, expected[probe.kind], probe.kind);
    }
    await testInfo.attach("parity.json", {
      body: JSON.stringify(result, null, 2),
      contentType: "application/json",
    });
    // Remaining differences are antialiasing at fill edges and stroke joins.
    expect(result.mismatchRatio).toBeLessThan(0.01);
  } finally {
    await browser.close();
  }
});

async function captureBasemap(browser: Browser, baseURL: string, renderer: "wgpu" | "canvas") {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  const gpuValidation: string[] = [];
  page.on("console", (message) => {
    if (/WGSL|\[Invalid [A-Za-z]+/.test(message.text())) gpuValidation.push(message.text());
  });
  const fixture = createParityTile();
  await page.route("https://vector.openstreetmap.org/shortbread_v1/**", (route) =>
    route.fulfill({
      body: fixture,
      contentType: "application/vnd.mapbox-vector-tile",
      headers: { "Access-Control-Allow-Origin": "*" },
    }),
  );
  const query = new URLSearchParams({
    lat: String(CAMERA.lat),
    lon: String(CAMERA.lon),
    renderer,
    zoom: String(CAMERA.zoom),
  });
  await page.goto(new URL(`/e2e/fixtures/vector-basemap.html?${query}`, baseURL).toString());
  const output = page.locator("output");
  const baseCanvas = page.locator('canvas[data-flat-runtime="maps"]');
  await expect(baseCanvas).toHaveAttribute("data-map-base-renderer", "wgpu");
  await expect(output).toHaveAttribute(
    "data-renderer",
    renderer === "wgpu" ? "wgpu-retained" : "canvas-overlay",
  );
  await expect(output).toHaveAttribute("data-state", "ready");
  if (renderer === "wgpu") {
    await expect
      .poll(async () => Number(await baseCanvas.getAttribute("data-map-vector-tiles")))
      .toBeGreaterThan(0);
  } else {
    await expect
      .poll(async () =>
        Number(
          await page
            .locator('canvas[data-map-overlay-runtime="maps"]')
            .getAttribute("data-map-overlay-primitives"),
        ),
      )
      .toBeGreaterThan(0);
  }
  // Every visible tile is loaded before capturing pixels: 7 MVT features per retained
  // tile; the overlay also counts the water polygon's two rings as linework.
  const tiles = Number(await output.getAttribute("data-tile-count"));
  expect(tiles).toBeGreaterThan(0);
  await expect
    .poll(async () => Number(await output.getAttribute("data-feature-count")))
    .toBe(tiles * (renderer === "wgpu" ? 7 : 9));
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  const png = await page.locator("#map").screenshot();
  await page.close();
  return { gpuValidation, png };
}

/** Screen points (inside the map) of known fixture regions in every visible z5 tile. */
function tileProbes() {
  const worldSize = 512 * 2 ** CAMERA.zoom;
  const centerX = (CAMERA.lon + 180) / 360;
  const centerY = (1 - Math.asinh(Math.tan((CAMERA.lat * Math.PI) / 180)) / Math.PI) / 2;
  const dimension = 2 ** Math.floor(CAMERA.zoom + 1);
  const probes: Array<{ kind: "building" | "forest" | "water"; point: [number, number] }> = [];
  const regions = [
    { kind: "forest", u: 0.5, v: 0.5 },
    { kind: "water", u: 0.3, v: 0.5 },
    { kind: "building", u: 0.15, v: 0.925 },
  ] as const;
  for (let tileX = 0; tileX < dimension; tileX++) {
    for (let tileY = 0; tileY < dimension; tileY++) {
      for (const region of regions) {
        const x = MAP_SIZE.width / 2 + ((tileX + region.u) / dimension - centerX) * worldSize;
        const y = MAP_SIZE.height / 2 + ((tileY + region.v) / dimension - centerY) * worldSize;
        if (x > 8 && y > 8 && x < MAP_SIZE.width - 8 && y < MAP_SIZE.height - 8) {
          probes.push({ kind: region.kind, point: [x, y] });
        }
      }
    }
  }
  return probes;
}

function expectColor(actual: number[], expected: Rgb, label: string) {
  const delta = Math.max(...expected.map((channel, index) => Math.abs(channel - actual[index]!)));
  expect(delta, `${label}: ${actual.join(",")} vs ${expected.join(",")}`).toBeLessThanOrEqual(3);
}

/**
 * One tile holding every Shortbread paint concern: a forest land fill, a water polygon
 * with an island hole (encoded before land to exercise style order), buildings with
 * outlines, streets and a boundary.
 */
function createParityTile() {
  const square = (x0: number, y0: number, x1: number, y1: number, clockwise = true) =>
    clockwise
      ? [
          [x0, y0],
          [x1, y0],
          [x1, y1],
          [x0, y1],
        ]
      : [
          [x0, y0],
          [x0, y1],
          [x1, y1],
          [x1, y0],
        ];
  return Buffer.concat([
    layer("water_polygons", [
      {
        type: 3,
        geometry: polygon([square(512, 512, 3584, 3584), square(1536, 1536, 2560, 2560, false)]),
      },
    ]),
    layer("land", [{ type: 3, geometry: polygon([square(0, 0, 4096, 4096)]), kind: "forest" }]),
    layer("buildings", [
      { type: 3, geometry: polygon([square(410, 3686, 820, 3890)]) },
      { type: 3, geometry: polygon([square(1024, 3686, 1434, 3890)]) },
    ]),
    layer("streets", [
      {
        type: 2,
        geometry: linestring([
          [0, 4000],
          [4096, 4000],
        ]),
      },
      {
        type: 2,
        geometry: linestring([
          [0, 0],
          [300, 300],
          [300, 3600],
        ]),
      },
    ]),
    layer("boundaries", [
      {
        type: 2,
        geometry: linestring([
          [3900, 0],
          [3900, 4096],
        ]),
      },
    ]),
  ]);
}

function polygon(rings: number[][][]) {
  const commands: number[] = [];
  let cursor = [0, 0];
  for (const ring of rings) {
    for (const [index, point] of ring.entries()) {
      if (index === 0) commands.push(9);
      if (index === 1) commands.push(((ring.length - 1) << 3) | 2);
      commands.push(zigzag(point[0]! - cursor[0]!), zigzag(point[1]! - cursor[1]!));
      cursor = point;
    }
    commands.push(15);
  }
  return commands;
}

function linestring(points: number[][]) {
  const commands: number[] = [];
  let cursor = [0, 0];
  for (const [index, point] of points.entries()) {
    if (index === 0) commands.push(9);
    if (index === 1) commands.push(((points.length - 1) << 3) | 2);
    commands.push(zigzag(point[0]! - cursor[0]!), zigzag(point[1]! - cursor[1]!));
    cursor = point;
  }
  return commands;
}

function layer(name: string, features: Array<{ type: number; geometry: number[]; kind?: string }>) {
  const kinds = [...new Set(features.flatMap((feature) => (feature.kind ? [feature.kind] : [])))];
  const encoded = features.map((feature) =>
    protobufBytes(
      2,
      Buffer.concat([
        ...(feature.kind
          ? [protobufBytes(2, Buffer.concat([varint(0), varint(kinds.indexOf(feature.kind))]))]
          : []),
        protobufVarint(3, feature.type),
        protobufBytes(4, Buffer.concat(feature.geometry.map(varint))),
      ]),
    ),
  );
  return protobufBytes(
    3,
    Buffer.concat([
      protobufBytes(1, Buffer.from(name)),
      ...encoded,
      ...(kinds.length > 0 ? [protobufBytes(3, Buffer.from("kind"))] : []),
      ...kinds.map((kind) => protobufBytes(4, protobufBytes(1, Buffer.from(kind)))),
      protobufVarint(5, 4096),
      protobufVarint(15, 2),
    ]),
  );
}

function protobufVarint(field: number, value: number) {
  return Buffer.concat([varint(field << 3), varint(value)]);
}

function protobufBytes(field: number, value: Buffer) {
  return Buffer.concat([varint((field << 3) | 2), varint(value.length), value]);
}

function zigzag(value: number) {
  return ((value << 1) ^ (value >> 31)) >>> 0;
}

function varint(value: number) {
  const bytes: number[] = [];
  let remaining = value >>> 0;
  do {
    let byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (remaining !== 0);
  return Buffer.from(bytes);
}
