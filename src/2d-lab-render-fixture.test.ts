import { describe, expect, it } from "vitest";

import { create2dLabRenderFixture } from "../scripts/2d-lab-render-fixture";

describe("2d-lab Maps fixture exporter", () => {
  it("exports deterministic post-projection line and polygon evidence", () => {
    const snapshot = create2dLabRenderFixture();

    expect(snapshot).toMatchObject({
      background: "#082f49",
      height: 720,
      schema: "maps-2d-lab-screen-frame/v1",
      width: 1200,
    });
    expect(snapshot.primitives).toHaveLength(13);
    expect(snapshot.primitives.filter((primitive) => primitive.kind === "polygon")).toHaveLength(5);
    expect(snapshot.primitives.filter((primitive) => primitive.kind === "line")).toHaveLength(8);

    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("longitude");
    expect(serialized).not.toContain("latitude");
  });
});
