// The single expected-state model for the hosted first-party Map View journeys.
// It states what a viewer can observe; it knows nothing about the runtime camera,
// tile scheduling or renderer. Pure data so the browser spec, the coverage reporter
// and the unit test all read the same authority.
import {
  generateStatePaths,
  type StatePath,
  type StatePathPlan,
} from "mobile-analysis/state-paths";
import { createMachine } from "xstate";

export const engineStateMachine = createMachine({
  id: "maps-engine",
  initial: "initial",
  states: {
    initial: {
      on: {
        MVT: "mvt",
        WEST: "west",
        TILT: "tilted",
        PAN: "moved",
        SELECT: "selected",
        RELOAD: "initial",
        BREAK_SOURCE: "unavailable",
      },
    },
    mvt: { on: { PMTILES: "initial", RELOAD: "mvt" } },
    west: { on: { RESET: "initial", POINTS: "initial", RELOAD: "west" } },
    tilted: { on: { FLATTEN: "initial", RESET: "initial" } },
    // The URL records source and scene only, so reload returns a moved camera home.
    moved: { on: { ZOOM: "moved", MVT: "movedMvt", RESET: "initial", RELOAD: "initial" } },
    movedMvt: { on: { PMTILES: "moved", SELECT: "selectedMvt" } },
    selected: { on: { RELOAD: "initial" } },
    selectedMvt: { on: { RESET: "selectedMvtHome", RELOAD: "mvt" } },
    selectedMvtHome: { on: { RELOAD: "mvt" } },
    unavailable: { on: { RELOAD: "unavailable", RETRY: "initial" } },
  },
});

export type EngineState =
  | "initial"
  | "mvt"
  | "west"
  | "tilted"
  | "moved"
  | "movedMvt"
  | "selected"
  | "selectedMvt"
  | "selectedMvtHome"
  | "unavailable";

export type EngineExpectation = {
  source: "pmtiles" | "mvt";
  scene: "points" | "west";
  /** "any": activating a cluster may expand it, which the model does not promise. */
  camera: "home" | "moved" | "any";
  tilted: boolean;
  selection: "none" | "selected";
  unavailable: boolean;
};

const base: EngineExpectation = {
  source: "pmtiles",
  scene: "points",
  camera: "home",
  tilted: false,
  selection: "none",
  unavailable: false,
};

export const engineExpectations: Record<EngineState, EngineExpectation> = {
  initial: base,
  mvt: { ...base, source: "mvt" },
  west: { ...base, scene: "west" },
  tilted: { ...base, tilted: true },
  moved: { ...base, camera: "moved" },
  movedMvt: { ...base, source: "mvt", camera: "moved" },
  selected: { ...base, camera: "any", selection: "selected" },
  selectedMvt: { ...base, source: "mvt", camera: "any", selection: "selected" },
  selectedMvtHome: { ...base, source: "mvt", selection: "selected" },
  unavailable: { ...base, unavailable: true },
};

export const ENGINE_EVENTS = [
  "MVT",
  "PMTILES",
  "WEST",
  "POINTS",
  "TILT",
  "FLATTEN",
  "RESET",
  "PAN",
  "ZOOM",
  "SELECT",
  "RELOAD",
  "BREAK_SOURCE",
  "RETRY",
] as const;

export type EngineEvent = (typeof ENGINE_EVENTS)[number];

/** Events a viewer performs directly on the Map View, so touch input changes them. */
export const GESTURE_EVENTS: ReadonlySet<string> = new Set(["PAN", "ZOOM", "SELECT"]);

export type StateInput = "desktop" | "touch";

export function buildEnginePlan(tier: "pr" | "full" = "pr"): StatePathPlan {
  return generateStatePaths({
    id: "maps-engine",
    model: engineStateMachine,
    events: ENGINE_EVENTS,
    tier,
    maxPaths: tier === "pr" ? 40 : 400,
  });
}

/**
 * The measured subset the mandatory Pages check runs. Everything else stays opt-in
 * through `bun run test:browser:state-paths`.
 */
export const PULL_REQUEST_PATHS: Record<StateInput, readonly string[]> = {
  // The toolbar paths that predate this model, plus the one complete viewer journey.
  desktop: [
    "MVT > PMTILES",
    "PAN > MVT > SELECT > RESET > RELOAD",
    "TILT > FLATTEN",
    "TILT > RESET",
    "WEST > POINTS",
    "WEST > RESET",
  ],
  touch: ["PAN > MVT > SELECT > RESET > RELOAD"],
};

export function readStatePathConfig(env: Record<string, string | undefined>): {
  tier: "pr" | "full";
  scope: "subset" | "all";
} {
  return {
    tier: env.MAPS_STATE_PATH_TIER === "full" ? "full" : "pr",
    scope: env.MAPS_STATE_PATHS === "all" ? "all" : "subset",
  };
}

export function selectPaths(
  plan: StatePathPlan,
  input: StateInput,
  scope: "subset" | "all",
): readonly StatePath[] {
  const eligible =
    input === "touch"
      ? plan.paths.filter((path) => path.steps.some((step) => GESTURE_EVENTS.has(step.event.type)))
      : plan.paths;
  if (scope === "all") return eligible;
  const names = new Set(eligible.map((path) => path.name));
  for (const name of PULL_REQUEST_PATHS[input]) {
    if (!names.has(name)) throw new Error(`Pull request path is not generated: ${input} ${name}`);
  }
  return eligible.filter((path) => PULL_REQUEST_PATHS[input].includes(path.name));
}

/** Real viewer branches the model deliberately does not traverse. */
export const UNMODELED_BRANCHES: readonly {
  control: string;
  value: string;
  reason: string;
}[] = [
  { control: "Tile source", value: "atlas", reason: "Atlas archive; atlas-pages.spec.ts owns it" },
  {
    control: "Tile source",
    value: "atlas-north",
    reason: "Atlas archive; atlas-pages.spec.ts owns it",
  },
  { control: "Camera scene", value: "liechtenstein", reason: "Atlas coverage scene" },
  { control: "Camera scene", value: "north", reason: "Atlas coverage scene" },
  { control: "Camera scene", value: "outside", reason: "Atlas coverage scene" },
  { control: "Camera scene", value: "east", reason: "Same camera transition as west" },
  { control: "Camera scene", value: "south", reason: "Same camera transition as west" },
  { control: "Point count", value: "10000", reason: "Workload size, not a journey state" },
  { control: "Point count", value: "100000", reason: "Workload size, not a journey state" },
  { control: "Search places", value: "*", reason: "maps-engine-page.spec.ts owns place search" },
];

/** The select values the model does traverse, for the drift guard against the page. */
export const MODELED_CONTROL_VALUES: Record<string, readonly string[]> = {
  "Tile source": ["pmtiles", "mvt"],
  "Camera scene": ["points", "west"],
  "Point count": ["1000"],
};

export type StateCoverageStatus = "pass" | "fail" | "untested";
export type StateObservation = {
  input: StateInput;
  kind: "state" | "edge";
  name: string;
  passed: boolean;
};
export type StateCoverageEntry = {
  name: string;
  desktop: StateCoverageStatus;
  touch: StateCoverageStatus;
};
export type StateCoverageReport = {
  model: string;
  tier: string;
  states: StateCoverageEntry[];
  edges: StateCoverageEntry[];
  unmodeled: typeof UNMODELED_BRANCHES;
};

const STEP_TITLE = /^(desktop|touch): (state|edge) (.+)$/;

export function stepTitle(input: StateInput, kind: "state" | "edge", name: string): string {
  return `${input}: ${kind} ${name}`;
}

export function parseStepTitle(title: string): Omit<StateObservation, "passed"> | null {
  const match = STEP_TITLE.exec(title);
  if (!match) return null;
  return {
    input: match[1] as StateInput,
    kind: match[2] as "state" | "edge",
    name: match[3]!,
  };
}

/** A failure anywhere wins; only never-executed entries are untested. */
export function summarizeStateCoverage(
  plan: StatePathPlan,
  observations: readonly StateObservation[],
): StateCoverageReport {
  const entries = (kind: "state" | "edge", names: readonly string[]): StateCoverageEntry[] =>
    names.map((name) => {
      const status = (input: StateInput): StateCoverageStatus => {
        const seen = observations.filter(
          (item) => item.kind === kind && item.name === name && item.input === input,
        );
        if (seen.length === 0) return "untested";
        return seen.every((item) => item.passed) ? "pass" : "fail";
      };
      return { name, desktop: status("desktop"), touch: status("touch") };
    });
  return {
    model: "maps-engine",
    tier: plan.coverage.tier,
    states: entries("state", plan.coverage.states),
    edges: entries("edge", plan.coverage.transitions),
    unmodeled: UNMODELED_BRANCHES,
  };
}

/** Deterministic plain-text listing: same inputs, same bytes. */
export function formatStateCoverage(report: StateCoverageReport): string {
  const count = (entries: readonly StateCoverageEntry[], input: StateInput) => {
    const of = (status: StateCoverageStatus) =>
      entries.filter((entry) => entry[input] === status).length;
    return `${of("pass")} pass, ${of("fail")} fail, ${of("untested")} untested`;
  };
  const rows = (entries: readonly StateCoverageEntry[]) =>
    entries.map((entry) => `  ${entry.desktop.padEnd(8)} ${entry.touch.padEnd(8)} ${entry.name}`);
  return [
    `State-path coverage for ${report.model} (${report.tier} tier)`,
    `States desktop: ${count(report.states, "desktop")}`,
    `States touch:   ${count(report.states, "touch")}`,
    `Edges desktop:  ${count(report.edges, "desktop")}`,
    `Edges touch:    ${count(report.edges, "touch")}`,
    "  desktop  touch    state",
    ...rows(report.states),
    "  desktop  touch    edge",
    ...rows(report.edges),
    "Unmodeled branches",
    ...report.unmodeled.map((item) => `  ${item.control}: ${item.value} (${item.reason})`),
  ].join("\n");
}
