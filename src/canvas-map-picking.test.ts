import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  createCanvasMapScene,
  hitTestCanvasMapScene,
  type CanvasMapScene,
  type CanvasMapScenePrimitive,
  type MapScreenPoint,
} from "./canvas-map-renderer";
import type {
  MapRenderCircle,
  MapRenderLine,
  MapRenderPolygon,
  MapVectorRenderFrame,
} from "./map-render-frame";

describe("Map Feature picking work and parity", () => {
  for (const segments of [1_000, 10_000, 100_000]) {
    it(`stops after the first matching segment of a ${segments}-segment Map Feature`, () => {
      const coordinates: [number, number][] = Array.from(
        { length: segments + 1 },
        (_, index) => [index * 20, 0],
      );
      const scene = identityScene([line("road", coordinates)]);
      const primitive = scene.primitives[0]!;
      assert.equal(primitive.kind, "line");
      if (primitive.kind !== "line") throw new Error("Expected a projected line.");
      let pointReads = 0;
      primitive.points = new Proxy(primitive.points, {
        get(target, key, receiver) {
          if (typeof key === "string" && /^\d+$/.test(key)) pointReads += 1;
          return Reflect.get(target, key, receiver);
        },
      });

      assert.equal(hitTestCanvasMapScene(scene, { x: 10, y: 3 }), primitive);
      // Count real projected-point access, not elapsed time or a mocked hit predicate.
      assert.equal(pointReads, 2);
    });
  }

  it("still finds a last-segment hit and rejects a complete miss", () => {
    const scene = identityScene([
      line("road", Array.from({ length: 101 }, (_, index) => [index * 20, 0])),
    ]);
    assert.equal(hitTestCanvasMapScene(scene, { x: 1990, y: 3 }), scene.primitives[0]);
    assert.equal(hitTestCanvasMapScene(scene, { x: 1990, y: 5 }), null);
    assert.equal(hitTestCanvasMapScene(scene, { x: -5, y: 0 }), null);
  });

  it("preserves exact tolerance, endpoints, diagonal and zero-length segments", () => {
    for (const strokeWidth of [0, 2, 20]) {
      const feature = line("road", [[0, 0], [0, 0], [20, 0]]);
      feature.strokeWidth = strokeWidth;
      const scene = identityScene([feature]);
      const tolerance = Math.max(4, strokeWidth / 2 + 2);
      assert.equal(hitTestCanvasMapScene(scene, { x: 10, y: tolerance }), scene.primitives[0]);
      assert.equal(hitTestCanvasMapScene(scene, { x: 10, y: tolerance + 0.001 }), null);
      assert.equal(hitTestCanvasMapScene(scene, { x: -tolerance, y: 0 }), scene.primitives[0]);
      assert.equal(hitTestCanvasMapScene(scene, { x: 20 + tolerance, y: 0 }), scene.primitives[0]);
      assert.equal(hitTestCanvasMapScene(scene, { x: -tolerance, y: tolerance }), null);
    }
    const diagonal = identityScene([line("diagonal", [[0, 0], [20, 20]])]);
    assert.equal(hitTestCanvasMapScene(diagonal, { x: 10, y: 10 }), diagonal.primitives[0]);
    assert.equal(hitTestCanvasMapScene(diagonal, { x: 10, y: 20 }), null);
    const repeated = identityScene([line("repeated", [[0, 0], [0, 0]])]);
    assert.equal(hitTestCanvasMapScene(repeated, { x: 4, y: 0 }), repeated.primitives[0]);
    assert.equal(hitTestCanvasMapScene(repeated, { x: 4.001, y: 0 }), null);
  });

  it("keeps implicit polygon closure, hole strokes and even-odd fill", () => {
    const scene = identityScene([polygon("area", [
      [[0, 0], [100, 0], [100, 100], [0, 100]],
      [[20, 20], [80, 20], [80, 80], [20, 80]],
    ])]);
    for (const point of [{ x: 10, y: 50 }, { x: -4, y: 50 }, { x: 23, y: 50 }]) {
      assert.equal(hitTestCanvasMapScene(scene, point), scene.primitives[0]);
    }
    assert.equal(hitTestCanvasMapScene(scene, { x: 50, y: 50 }), null);
    assert.equal(hitTestCanvasMapScene(scene, { x: -4.001, y: 50 }), null);
  });

  it("preserves topmost eligible identity and circle minimum hit radius", () => {
    const passive = circle("passive", [10, 10]);
    passive.interactive = false;
    const scene = identityScene([
      circle("bottom", [10, 10]), circle("top", [10, 10]), passive,
    ]);
    assert.equal(hitTestCanvasMapScene(scene, { x: 18, y: 10 }), scene.primitives[1]);
    assert.equal(hitTestCanvasMapScene(scene, { x: 18.001, y: 10 }), null);
  });

  it("does not retain stale geometry, interaction eligibility or stroke tolerance", () => {
    const feature = line("road", [[0, 0], [20, 0]]);
    const scene = identityScene([feature]);
    assert.equal(hitTestCanvasMapScene(scene, { x: 10, y: 10 }), null);
    feature.strokeWidth = 20;
    assert.equal(hitTestCanvasMapScene(scene, { x: 10, y: 10 }), scene.primitives[0]);
    feature.interactive = false;
    assert.equal(hitTestCanvasMapScene(scene, { x: 10, y: 10 }), null);
    feature.interactive = true;
    const primitive = scene.primitives[0]!;
    if (primitive.kind !== "line") throw new Error("Expected a projected line.");
    primitive.points = [{ x: 100, y: 100 }, { x: 120, y: 100 }];
    assert.equal(hitTestCanvasMapScene(scene, { x: 10, y: 0 }), null);
    assert.equal(hitTestCanvasMapScene(scene, { x: 110, y: 100 }), primitive);
    const moved = createCanvasMapScene(
      { kind: "vector", primitives: [feature] },
      ([x, y]) => ({ x: x + 200, y: y + 200 }),
      { width: 400, height: 400 },
    );
    assert.equal(hitTestCanvasMapScene(moved, { x: 210, y: 200 }), moved.primitives[0]);
    assert.equal(hitTestCanvasMapScene(moved, { x: 10, y: 0 }), null);
  });

  it("matches the pre-optimization picker on 5000 seeded mixed-geometry queries", () => {
    let seed = 0x4d415053;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    const primitives: MapVectorRenderFrame["primitives"] = [];
    for (let index = 0; index < 60; index += 1) {
      const x = random() * 1000 - 500;
      const y = random() * 1000 - 500;
      if (index % 3 === 0) {
        primitives.push(circle(`point-${index}`, [x, y]));
      } else if (index % 3 === 1) {
        const coordinates: [number, number][] = Array.from(
          { length: 40 },
          () => [x + random() * 100, y + random() * 100],
        );
        coordinates[1] = coordinates[0]!;
        const feature = line(`road-${index}`, coordinates);
        feature.strokeWidth = random() * 20;
        primitives.push(feature);
      } else {
        primitives.push(polygon(`area-${index}`, [
          [[x, y], [x + 100, y], [x + 100, y + 100], [x, y + 100]],
          [[x + 20, y + 20], [x + 80, y + 20], [x + 80, y + 80], [x + 20, y + 80]],
        ]));
      }
      primitives[index]!.interactive = index % 7 !== 0;
    }
    const scene = identityScene(primitives);
    for (let index = 0; index < 5000; index += 1) {
      const point = { x: random() * 1200 - 600, y: random() * 1200 - 600 };
      assert.equal(hitTestCanvasMapScene(scene, point), referencePick(scene, point));
    }
  });
});

function identityScene(primitives: MapVectorRenderFrame["primitives"]) {
  return createCanvasMapScene({ kind: "vector", primitives }, ([x, y]) => ({ x, y }), {
    width: 1000,
    height: 1000,
  });
}

function base(featureId: string) {
  return { feature: { id: featureId }, featureId, interactive: true, primitiveId: featureId };
}

function circle(featureId: string, center: [number, number]): MapRenderCircle {
  return {
    ...base(featureId), center, fillColor: "#000000", fillOpacity: 1, kind: "circle",
    label: null, radius: 5, strokeColor: "#ffffff", strokeOpacity: 1, strokeWidth: 2,
  };
}

function line(featureId: string, coordinates: [number, number][]): MapRenderLine {
  return {
    ...base(featureId), coordinates, kind: "line", strokeColor: "#000000",
    strokeOpacity: 1, strokeWidth: 2,
  };
}

function polygon(featureId: string, rings: [number, number][][]): MapRenderPolygon {
  return {
    ...base(featureId), fillColor: "#000000", fillOpacity: 1, kind: "polygon", rings,
    strokeColor: "#000000", strokeOpacity: 1, strokeWidth: 2,
  };
}

// Test-only oracle preserves the former full minimum-distance scan. Do not use it
// in production: equality of the selected primitive, not timings, is the contract.
function referencePick(scene: CanvasMapScene, point: MapScreenPoint) {
  for (let index = scene.primitives.length - 1; index >= 0; index -= 1) {
    const primitive = scene.primitives[index]!;
    if (primitive.renderPrimitive.interactive && referenceHit(primitive, point)) return primitive;
  }
  return null;
}

function referenceHit(primitive: CanvasMapScenePrimitive, point: MapScreenPoint): boolean {
  if (primitive.kind === "direction-marker") return false;
  if (primitive.kind === "circle") {
    const radius = Math.max(8, (primitive.renderPrimitive as MapRenderCircle).radius);
    return (point.x - primitive.x) ** 2 + (point.y - primitive.y) ** 2 <= radius * radius;
  }
  const width = (primitive.renderPrimitive as MapRenderLine | MapRenderPolygon).strokeWidth;
  const tolerance = Math.max(4, width / 2 + 2);
  if (primitive.kind === "line") {
    return minimumDistance(point, primitive.points, false) <= tolerance * tolerance;
  }
  let inside = false;
  for (const ring of primitive.rings) {
    for (let current = 0, previous = ring.length - 1; current < ring.length; previous = current++) {
      const a = ring[current]!;
      const b = ring[previous]!;
      if (a.y > point.y !== b.y > point.y &&
          point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
  }
  return inside || primitive.rings.some(
    (ring) => minimumDistance(point, ring, true) <= tolerance * tolerance,
  );
}

function minimumDistance(point: MapScreenPoint, points: MapScreenPoint[], closed: boolean) {
  let minimum = Number.POSITIVE_INFINITY;
  for (let index = 1; index < points.length; index += 1) {
    minimum = Math.min(minimum, segmentDistance(point, points[index - 1]!, points[index]!));
  }
  if (closed && points.length >= 2) {
    minimum = Math.min(minimum, segmentDistance(point, points[points.length - 1]!, points[0]!));
  }
  return minimum;
}

function segmentDistance(point: MapScreenPoint, start: MapScreenPoint, end: MapScreenPoint) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const t = dx === 0 && dy === 0 ? 0 : Math.max(0, Math.min(1,
    ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy),
  ));
  const nearest = { x: start.x + t * dx, y: start.y + t * dy };
  return (point.x - nearest.x) ** 2 + (point.y - nearest.y) ** 2;
}
