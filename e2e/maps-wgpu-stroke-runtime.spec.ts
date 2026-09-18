import { chromium, expect, test } from "@playwright/test";

const VISIBLE_RASTER_TILE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFklEQVR4nGMM2FLxnwEPYMInOXwUAACRIgKL3I8IIQAAAABJRU5ErkJggg==",
  "base64",
);

const WEBGPU_SWIFTSHADER_ARGS = [
  "--disable-vulkan-surface",
  "--enable-features=Vulkan",
  "--enable-unsafe-swiftshader",
  "--enable-unsafe-webgpu",
  "--use-angle=swiftshader",
];

test("Maps wgpu keeps mixed point and flow geometry on the first-party GPU path @smoke", async ({
  baseURL,
}) => {
  const browser = await chromium.launch({ args: WEBGPU_SWIFTSHADER_ARGS });
  const page = await browser.newPage();

  try {
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
      "/?acceptance=maps-runtime-raster-fetch",
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
    const url = new URL(
      "/?e2e=1&vectorTiles=fixture",
      baseURL ?? "http://127.0.0.1:5181",
    );
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
      acceptedHeaders.every((header) =>
        header.includes("application/vnd.mapbox-vector-tile"),
      ),
    ).toBe(true);
  } finally {
    await browser.close();
  }
});

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

  const feature = Buffer.concat([
    protobufVarint(3, 2),
    protobufBytes(4, geometry),
  ]);
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

