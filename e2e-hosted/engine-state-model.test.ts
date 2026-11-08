import { describe, expect, it } from "vitest";

import {
  ENGINE_EVENTS,
  GESTURE_EVENTS,
  PULL_REQUEST_PATHS,
  buildEnginePlan,
  engineExpectations,
  formatStateCoverage,
  parseStepTitle,
  readStatePathConfig,
  selectPaths,
  stepTitle,
  summarizeStateCoverage,
  type StateObservation,
} from "./engine-state-model";

const plan = buildEnginePlan();

describe("Map View expected-state model", () => {
  it("gives every reachable state an observable expectation", () => {
    expect([...plan.coverage.states].sort()).toEqual(Object.keys(engineExpectations).sort());
  });

  it("declares the journey, its reload self-loops and the unavailable branch", () => {
    expect(plan.coverage.transitions).toEqual(
      expect.arrayContaining([
        "initial --PAN--> moved",
        "moved --ZOOM--> moved",
        "moved --MVT--> movedMvt",
        "movedMvt --SELECT--> selectedMvt",
        "selectedMvt --RESET--> selectedMvtHome",
        "selectedMvtHome --RELOAD--> mvt",
        "initial --RELOAD--> initial",
        "mvt --RELOAD--> mvt",
        "west --RELOAD--> west",
        "unavailable --RELOAD--> unavailable",
        "unavailable --RETRY--> initial",
      ]),
    );
  });

  it("generates bounded paths that traverse every declared edge", () => {
    const traversed = new Set<string>();
    for (const path of plan.paths) {
      let from = plan.initialState;
      for (const step of path.steps) {
        traversed.add(`${from} --${step.event.type}--> ${step.state}`);
        from = step.state;
      }
    }
    expect([...traversed].sort()).toEqual([...plan.coverage.transitions].sort());
    expect(plan.paths.length).toBeLessThanOrEqual(40);
  });

  it("only uses events the Playwright adapter implements", () => {
    const declared = new Set<string>(ENGINE_EVENTS);
    for (const path of plan.paths) {
      for (const step of path.steps) expect(declared.has(step.event.type)).toBe(true);
    }
  });

  it("keeps full traversal opt-in behind a small pull request subset", () => {
    expect(readStatePathConfig({})).toEqual({ tier: "pr", scope: "subset" });
    expect(readStatePathConfig({ MAPS_STATE_PATHS: "all", MAPS_STATE_PATH_TIER: "full" })).toEqual({
      tier: "full",
      scope: "all",
    });
    const desktop = selectPaths(plan, "desktop", "subset");
    const touch = selectPaths(plan, "touch", "subset");
    expect(desktop.map((path) => path.name)).toEqual([...PULL_REQUEST_PATHS.desktop].sort());
    expect(touch.length).toBeGreaterThan(0);
    expect(desktop.length + touch.length).toBeLessThan(plan.paths.length);
    expect(selectPaths(plan, "desktop", "all")).toEqual(plan.paths);
  });

  it("drives touch paths through a real gesture", () => {
    for (const path of selectPaths(plan, "touch", "all")) {
      expect(path.steps.some((step) => GESTURE_EVENTS.has(step.event.type))).toBe(true);
    }
  });
});

describe("state coverage summary", () => {
  const edge = "initial --PAN--> moved";
  const observed = (input: "desktop" | "touch", passed: boolean): StateObservation => ({
    input,
    kind: "edge",
    name: edge,
    passed,
  });

  it("round-trips step titles and ignores ordinary steps", () => {
    expect(parseStepTitle(stepTitle("touch", "edge", edge))).toEqual({
      input: "touch",
      kind: "edge",
      name: edge,
    });
    expect(parseStepTitle("Before Hooks")).toBeNull();
  });

  it("separates pass, fail and untested per input", () => {
    const report = summarizeStateCoverage(plan, [
      observed("desktop", true),
      observed("touch", true),
      observed("touch", false),
    ]);
    const entry = report.edges.find((item) => item.name === edge)!;
    expect(entry).toEqual({ name: edge, desktop: "pass", touch: "fail" });
    expect(report.edges.find((item) => item.name === "mvt --RELOAD--> mvt")).toEqual({
      name: "mvt --RELOAD--> mvt",
      desktop: "untested",
      touch: "untested",
    });
  });

  it("lists coverage and unmodeled branches deterministically", () => {
    const report = summarizeStateCoverage(plan, [observed("desktop", true)]);
    const listing = formatStateCoverage(report);
    expect(listing).toBe(
      formatStateCoverage(summarizeStateCoverage(plan, [observed("desktop", true)])),
    );
    expect(listing).toContain(`pass     untested ${edge}`);
    expect(listing).toContain("Tile source: atlas ");
  });
});
