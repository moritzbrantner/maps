import { chromium, expect, test } from "@playwright/test";

const VISIBLE_RASTER_TILE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFklEQVR4nGMM2FLxnwEPYMInOXwUAACRIgKL3I8IIQAAAABJRU5ErkJggg==",
  "base64",
);

// Use Graphite/Dawn with SwiftShader for both WebGPU and canvas presentation.
// Ganesh/Vulkan interop can destroy the device on GPU-less Linux runners.
const WEBGPU_SWIFTSHADER_ARGS = [
  "--enable-unsafe-swiftshader",
  "--enable-unsafe-webgpu",
  "--enable-skia-graphite",
  "--skia-graphite-dawn-backend=swiftshader",
  "--use-angle=swiftshader",
];

test("Maps wgpu keeps mixed point and flow geometry on the first-party GPU path @smoke", async ({
  baseURL,
}, testInfo) => {
  const browser = await chromium.launch({ args: WEBGPU_SWIFTSHADER_ARGS });
  const page = await browser.newPage();

  await page.addInitScript(() => {
    const browserGlobal = globalThis as typeof globalThis & {
      GPUDevice: {
        prototype: {
          createTexture(descriptor: { label?: string; usage: number }): unknown;
        };
      };
      __mapsRasterTextureUsages: number[];
    };
    browserGlobal.__mapsRasterTextureUsages = [];
    const prototype = browserGlobal.GPUDevice.prototype;
    const createTexture = prototype.createTexture;
    prototype.createTexture = function (descriptor) {
      if (descriptor.label === "Maps raster tile texture") {
        browserGlobal.__mapsRasterTextureUsages.push(descriptor.usage);
      }
      return createTexture.call(this, descriptor);
    };
  });

  try {
    const unexpectedVectorRequests: string[] = [];
    await page.route("https://vector.openstreetmap.org/**", async (route) => {
      unexpectedVectorRequests.push(route.request().url());
      await route.abort();
    });
    const acceptedHeaders: string[] = [];
    await page.route("https://tiles.example.test/**", async (route) => {
      const headers = await route.request().allHeaders();
      acceptedHeaders.push(headers.accept ?? "");
      await route.fulfill({
        body: VISIBLE_RASTER_TILE,
        contentType: "image/png",
        headers: {
          "Access-Control-Allow-Origin": "*",
        },
        status: 200,
      });
    });

    const url = new URL(
      // Keep the unrelated comparison map below this fixture off live data.
      "/?e2e=1&acceptance=maps-runtime-raster-fetch",
      baseURL ?? "http://127.0.0.1:5181",
    );
    await page.goto(url.toString());

    const map = page.getByLabel("Maps Rust runtime acceptance");
    const baseCanvas = map.locator('canvas[data-flat-runtime="maps"]');
    const overlay = map.locator('canvas[data-map-overlay-runtime="maps"]');

    await expect(map).toHaveAttribute("data-map-ready", "true");
    await expect(baseCanvas).toHaveAttribute("data-map-base-renderer", "wgpu");
    await expect
      .poll(async () => Number(await baseCanvas.getAttribute("data-map-base-tiles")))
      .toBeGreaterThan(0);

    expect(acceptedHeaders.length).toBeGreaterThan(0);
    expect(acceptedHeaders.every((header) => header.includes("image/"))).toBe(true);
    await expect(baseCanvas).not.toHaveAttribute("data-map-base-tile-error", /.+/);
    await expect(overlay).toHaveAttribute("data-map-overlay-primitives", "6");
    await expect(overlay).toHaveAttribute("data-map-overlay-backend", "wgpu");
    await expect(page.getByTestId("maps-runtime-cluster-summary")).toHaveText(
      "1 clusters / 3 points",
    );
    await expect(map.locator(".maplibregl-canvas")).toHaveCount(0);
    const usages = await page.evaluate(
      () =>
        (globalThis as typeof globalThis & { __mapsRasterTextureUsages: number[] })
          .__mapsRasterTextureUsages,
    );
    expect(usages.length).toBeGreaterThan(0);
    // COPY_DST | TEXTURE_BINDING | RENDER_ATTACHMENT: external image uploads
    // need the attachment flag even when the texture is only sampled later.
    expect(usages.every((usage) => (usage & 0x16) === 0x16)).toBe(true);
    expect(unexpectedVectorRequests).toEqual([]);
    await map.screenshot({ path: testInfo.outputPath("mixed-point-flow-wgpu.png") });
    expect(unexpectedVectorRequests).toEqual([]);
  } finally {
    await browser.close();
  }
});

test("Pages first-party engine decodes Shortbread vector tiles into wgpu linework @smoke", async ({
  baseURL,
}) => {
  const browser = await chromium.launch({ args: WEBGPU_SWIFTSHADER_ARGS });
  const page = await browser.newPage();
  const acceptedHeaders: string[] = [];
  const fixture = createShortbreadStreetFixture();

  await page.route("https://vector.openstreetmap.org/shortbread_v1/**", async (route) => {
    const headers = await route.request().allHeaders();
    acceptedHeaders.push(headers.accept ?? "");
    await route.fulfill({
      body: fixture,
      contentType: "application/vnd.mapbox-vector-tile",
      headers: {
        "Access-Control-Allow-Origin": "*",
      },
      status: 200,
    });
  });

  try {
    const url = new URL("/?e2e=1&vectorTiles=fixture", baseURL ?? "http://127.0.0.1:5181");
    await page.goto(url.toString());

    const comparison = page.getByTestId("renderer-comparison");
    const map = comparison.getByLabel("Renderer parity map");
    const baseCanvas = map.locator('canvas[data-flat-runtime="maps"]');
    const overlay = map.locator('canvas[data-map-overlay-runtime="maps"]');
    const basemap = comparison.locator("[data-shortbread-state]");

    await expect(map).toHaveAttribute("data-map-ready", "true");
    await expect(baseCanvas).toHaveAttribute("data-map-base-renderer", "wgpu");
    await expect(basemap).toHaveAttribute("data-shortbread-state", "ready");
    await expect
      .poll(async () => Number(await basemap.getAttribute("data-shortbread-feature-count")))
      .toBeGreaterThan(0);
    await expect(overlay).toHaveAttribute("data-map-overlay-backend", "wgpu");
    await expect
      .poll(async () => Number(await overlay.getAttribute("data-map-overlay-primitives")))
      .toBeGreaterThan(1);
    await expect(map.locator(".maplibregl-canvas")).toHaveCount(0);
    expect(acceptedHeaders.length).toBeGreaterThan(0);
    expect(
      acceptedHeaders.every((header) => header.includes("application/vnd.mapbox-vector-tile")),
    ).toBe(true);
  } finally {
    await browser.close();
  }
});

test("Pages Shortbread basemap renders through the Canvas fallback @smoke", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "gpu", {
      configurable: true,
      get: () => undefined,
    });
  });

  const fixture = createShortbreadStreetFixture();
  await page.route("https://vector.openstreetmap.org/shortbread_v1/**", async (route) => {
    await route.fulfill({
      body: fixture,
      contentType: "application/vnd.mapbox-vector-tile",
      headers: {
        "Access-Control-Allow-Origin": "*",
      },
      status: 200,
    });
  });

  await page.goto("/?e2e=1&vectorTiles=fixture");

  const comparison = page.getByTestId("renderer-comparison");
  const map = comparison.getByLabel("Renderer parity map");
  const baseCanvas = map.locator('canvas[data-flat-runtime="maps"]');
  const fallbackCanvas = map.locator('canvas[data-map-base-fallback="canvas2d"]');
  const overlay = map.locator('canvas[data-map-overlay-runtime="maps"]');
  const basemap = comparison.locator("[data-shortbread-state]");

  await expect(map).toHaveAttribute("data-map-ready", "true");
  await expect(baseCanvas).toHaveAttribute("data-map-base-renderer", "canvas2d");
  await expect(fallbackCanvas).toBeVisible();
  await expect(basemap).toHaveAttribute("data-shortbread-state", "ready");
  await expect
    .poll(async () => Number(await basemap.getAttribute("data-shortbread-feature-count")))
    .toBeGreaterThan(0);
  await expect(overlay).toHaveAttribute("data-map-overlay-backend", "canvas2d");
  await expect
    .poll(async () => Number(await overlay.getAttribute("data-map-overlay-primitives")))
    .toBeGreaterThan(1);

  const readBackgroundPixel = () =>
    fallbackCanvas.evaluate((canvas) => {
      const element = canvas as HTMLCanvasElement;
      const context = element.getContext("2d");
      if (!context) return null;
      const x = Math.max(0, Math.floor(element.width / 2));
      const y = Math.max(0, Math.floor(element.height / 2));
      return Array.from(context.getImageData(x, y, 1, 1).data);
    });
  expect(await readBackgroundPixel()).toEqual([249, 244, 238, 255]);
  await fallbackCanvas.evaluate((element) => {
    const canvas = element as HTMLCanvasElement;
    canvas.width = canvas.width;
    canvas.dispatchEvent(new Event("contextrestored"));
  });
  await expect.poll(readBackgroundPixel).toEqual([249, 244, 238, 255]);

  await expect(map.locator(".maplibregl-canvas")).toHaveCount(0);
});

test("Shortbread fills preserve forest islands beneath application points @smoke", async ({
  page,
}) => {
  const tiles: Array<{ x: number; y: number; z: number }> = [];
  const fixture = createShortbreadWaterFixture();
  await page.route("https://vector.openstreetmap.org/shortbread_v1/**", async (route) => {
    const coordinates = new URL(route.request().url()).pathname.match(
      /\/(\d+)\/(\d+)\/(\d+)\.mvt$/,
    );
    if (!coordinates) throw new Error("Expected an XYZ vector tile URL");
    tiles.push({ z: Number(coordinates[1]), x: Number(coordinates[2]), y: Number(coordinates[3]) });
    await route.fulfill({
      body: fixture,
      contentType: "application/vnd.mapbox-vector-tile",
      headers: { "Access-Control-Allow-Origin": "*" },
    });
  });
  await page.goto("/?e2e=1&vectorTiles=fixture");
  const map = page.getByTestId("renderer-comparison").getByLabel("Renderer parity map");
  const overlay = map.locator('canvas[data-map-overlay-runtime="maps"]');
  await expect(map).toHaveAttribute("data-map-ready", "true");
  await map.scrollIntoViewIfNeeded();
  await expect(overlay).toHaveAttribute("data-map-overlay-backend", "canvas2d");

  const expectTerrain = async () =>
    expect
      .poll(() =>
        overlay.evaluate((element, requestedTiles) => {
          const canvas = element as HTMLCanvasElement;
          const context = canvas.getContext("2d");
          if (!context) return false;
          const bounds = canvas.getBoundingClientRect();
          // Independent Web Mercator reference for the comparison's declared initial camera.
          const worldSize = 512 * 2 ** 4.4;
          const centerX = (10.3 + 180) / 360;
          const centerY = (1 - Math.asinh(Math.tan((50.4 * Math.PI) / 180)) / Math.PI) / 2;
          const sample = (x: number, y: number) => {
            const screenX = bounds.width / 2 + (x - centerX) * worldSize;
            const screenY = bounds.height / 2 + (y - centerY) * worldSize;
            if (
              screenX < 1 ||
              screenY < 1 ||
              screenX >= bounds.width - 1 ||
              screenY >= bounds.height - 1
            )
              return null;
            return Array.from(
              context.getImageData(
                Math.floor((screenX * canvas.width) / bounds.width),
                Math.floor((screenY * canvas.height) / bounds.height),
                1,
                1,
              ).data,
            );
          };
          const hasIsland = requestedTiles.some((tile) => {
            const dimension = 2 ** tile.z;
            const water = sample((tile.x + 0.125) / dimension, (tile.y + 0.5) / dimension);
            const island = sample((tile.x + 0.5) / dimension, (tile.y + 0.5) / dimension);
            return (
              water?.join(",") === "168,204,224,255" && island?.join(",") === "196,216,180,255"
            );
          });
          // Berlin's cluster lies inside the fixture's water, away from its outlines.
          const berlin = sample(
            (13.405 + 180) / 360,
            (1 - Math.asinh(Math.tan((52.52 * Math.PI) / 180)) / Math.PI) / 2,
          );
          return {
            hasIsland,
            pointAboveWater: berlin?.[3] === 255 && berlin.join(",") !== "168,204,224,255",
          };
        }, tiles),
      )
      .toEqual({ hasIsland: true, pointAboveWater: true });
  await expectTerrain();
  await overlay.evaluate((element) => {
    const canvas = element as HTMLCanvasElement;
    // Restoring a 2D context resets its backing store and drawing state.
    canvas.width = canvas.width;
    canvas.dispatchEvent(new Event("contextrestored"));
  });
  await expectTerrain();
  await expect(map.locator(".maplibregl-canvas")).toHaveCount(0);
});

test("Canvas fill-only polygons do not inherit a previous stroke width @smoke", async ({
  page,
}) => {
  await page.goto("/?e2e=1");
  const pixels = await page.evaluate(async () => {
    const modulePath = "/src/canvas-map-renderer.ts";
    const { createCanvasMapScene, drawCanvasMapScene } = await import(modulePath);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 100;
    const context = canvas.getContext("2d")!;
    context.lineWidth = 8;
    const scene = createCanvasMapScene(
      {
        kind: "vector",
        primitives: [
          {
            kind: "polygon",
            feature: null,
            featureId: "land",
            primitiveId: "land",
            interactive: false,
            fillColor: "#ff0000",
            fillOpacity: 1,
            strokeColor: "#0000ff",
            strokeOpacity: 1,
            strokeWidth: 0,
            rings: [
              [
                [20, 20],
                [80, 20],
                [80, 80],
                [20, 80],
                [20, 20],
              ],
            ],
          },
        ],
      },
      ([x, y]: [number, number]) => ({ x, y }),
      { width: 100, height: 100 },
    );
    drawCanvasMapScene(context, scene);
    return {
      outside: Array.from(context.getImageData(18, 50, 1, 1).data),
      inside: Array.from(context.getImageData(21, 50, 1, 1).data),
    };
  });
  expect(pixels).toEqual({ outside: [0, 0, 0, 0], inside: [255, 0, 0, 255] });
});

function createShortbreadWaterFixture() {
  const rings = [
    [
      [0, 0],
      [4096, 0],
      [4096, 4096],
      [0, 4096],
    ],
    [
      [1024, 1024],
      [1024, 3072],
      [3072, 3072],
      [3072, 1024],
    ],
  ];
  let cursorX = 0;
  let cursorY = 0;
  const commands: Buffer[] = [];
  for (const ring of rings) {
    for (const [index, point] of ring.entries()) {
      const [x, y] = point;
      if (index === 0) commands.push(varint(9));
      if (index === 1) commands.push(varint(((ring.length - 1) << 3) | 2));
      commands.push(varint(zigzag(x! - cursorX)), varint(zigzag(y! - cursorY)));
      cursorX = x!;
      cursorY = y!;
    }
    commands.push(varint(15));
  }
  const feature = Buffer.concat([protobufVarint(3, 3), protobufBytes(4, Buffer.concat(commands))]);
  const layer = Buffer.concat([
    protobufBytes(1, Buffer.from("water_polygons")),
    protobufBytes(2, feature),
    protobufVarint(5, 4096),
    protobufVarint(15, 2),
  ]);
  const landGeometry = Buffer.concat([
    varint(9),
    varint(0),
    varint(0),
    varint(26),
    varint(zigzag(4096)),
    varint(0),
    varint(0),
    varint(zigzag(4096)),
    varint(zigzag(-4096)),
    varint(0),
    varint(15),
  ]);
  const landFeature = Buffer.concat([
    protobufBytes(2, Buffer.concat([varint(0), varint(0)])),
    protobufVarint(3, 3),
    protobufBytes(4, landGeometry),
  ]);
  const landLayer = Buffer.concat([
    protobufBytes(1, Buffer.from("land")),
    protobufBytes(2, landFeature),
    protobufBytes(3, Buffer.from("kind")),
    protobufBytes(4, protobufBytes(1, Buffer.from("forest"))),
    protobufVarint(5, 4096),
    protobufVarint(15, 2),
  ]);
  // Deliberately encode land last: style order must still put it beneath water.
  return Buffer.concat([protobufBytes(3, layer), protobufBytes(3, landLayer)]);
}

function createShortbreadStreetFixture() {
  const geometry = Buffer.concat([
    varint((1 << 3) | 1),
    varint(zigzag(0)),
    varint(zigzag(0)),
    varint((2 << 3) | 2),
    varint(zigzag(4096)),
    varint(zigzag(4096)),
    varint(zigzag(-2048)),
    varint(zigzag(0)),
  ]);

  const feature = Buffer.concat([protobufVarint(3, 2), protobufBytes(4, geometry)]);
  const layer = Buffer.concat([
    protobufBytes(1, Buffer.from("streets")),
    protobufBytes(2, feature),
    protobufVarint(5, 4096),
    protobufVarint(15, 2),
  ]);

  return protobufBytes(3, layer);
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
