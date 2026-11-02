/** Static HTML report for oracle/run.ts: overview table plus, per scenario, MapLibre | Maps |
 * FLIP side by side, a swipe comparison, the scripted pick/bounds steps and frame times. */
import type { TimingSummary } from "./timing-evidence.ts";

type Report = {
  adapter: { renderer: string; software: boolean };
  boundsTolerancePx: number;
  commit: string | null;
  flipMeanMax: number;
  flipP99Max: number;
  frameTimeGate: boolean;
  frameTimeMargin: number;
  generatedAt: string;
  maplibreVersion: string | null;
  timingEnvironment: Record<string, unknown> | null;
  passed: boolean;
  scenarios: Array<Scenario>;
  timing: {
    batchFrames: number;
    batches: number;
    retries: number;
    rounds: number;
    warmupMs: number;
  };
};

/** A gated scenario has every field; an unsupported one only has the MapLibre render. */
type Scenario = {
  capability: string;
  errors: { maplibre: string | null; maps: string | null };
  files: { flip: string | null; maplibre: string; maps: string | null };
  gates: Record<"image" | "interaction" | "time", boolean> | null;
  image: {
    mean: number | null;
    p99: number | null;
    meanMax: number | null;
    p99Max: number | null;
    floor: { mean: number; p99: number } | null;
  };
  interaction: {
    ok: boolean;
    steps: Array<{
      label: string;
      ok: boolean;
      hovered: { maplibre: unknown; maps: unknown };
      selected: { maplibre: unknown; maps: unknown };
      bounds: { px: number | null };
    }>;
  };
  knownGaps: Array<{ gate: string; issue: number; reason: string }>;
  mapsBaseRenderer: string | null;
  name: string;
  origin: string;
  passed: boolean;
  time: TimingSummary;
  unsupported: { issue: number; reason: string } | null;
  verdict: string;
};

const escape = (value: unknown) =>
  String(value).replace(
    /[&<>"]/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]!,
  );
const num = (value: number | null, digits = 3) => (value === null ? "–" : value.toFixed(digits));
const ids = (value: unknown) =>
  value && typeof value === "object" && Object.keys(value).length
    ? Object.entries(value as Record<string, unknown>)
        .map(([layer, id]) => `${layer}=${id ?? "∅"}`)
        .join(", ")
    : "∅";
const ISSUES = "https://github.com/moritzbrantner/maps/issues/";

function gateCell(
  scenario: Scenario,
  gate: "image" | "interaction" | "time",
  text: string,
  timeEnforced: boolean,
) {
  if (gate === "time" && scenario.time.validity !== "valid") {
    const invalid = scenario.time.validity === "invalid";
    const status = invalid
      ? timeEnforced
        ? "INVALID measurement"
        : "unavailable (advisory)"
      : "not measured";
    return `<td class="${invalid && timeEnforced ? "invalid" : "advisory"}">${status}</td>`;
  }
  if (gate === "time" && !timeEnforced) {
    return `<td class="advisory">${text} (advisory)</td>`;
  }
  const gaps = scenario.knownGaps.filter((entry) => entry.gate === gate);
  const ok = scenario.gates![gate];
  const state = ok ? (gaps.length ? "stale" : "pass") : gaps.length ? "gap" : "fail";
  const badge = gaps.map((gap) => ` <a href="${ISSUES}${gap.issue}">#${gap.issue}</a>`).join("");
  return `<td class="${state}">${text}${badge}</td>`;
}

function unsupportedRow(s: Scenario) {
  const { issue, reason } = s.unsupported!;
  return `<tr>
  <th scope="row"><a href="#${escape(s.name)}">${escape(s.name)}</a><small>${escape(s.capability)}</small></th>
  <td class="unsupported" colspan="3">not implemented in Maps: ${escape(reason)}</td>
  <td class="unsupported">unsupported <a href="${ISSUES}${issue}">#${issue}</a></td>
</tr>`;
}

function unsupportedSection(s: Scenario) {
  const { issue, reason } = s.unsupported!;
  return `<section id="${escape(s.name)}">
  <h2>${escape(s.name)} <small class="tag">unsupported</small></h2>
  <p class="meta">${escape(s.capability)} · from ${escape(s.origin)}</p>
  <div class="triptych">
    <figure><img src="${escape(s.files.maplibre)}" alt="MapLibre render of ${escape(s.name)}" /><figcaption>MapLibre (oracle target)</figcaption></figure>
  </div>
  <p class="gap unsupported">Maps does not implement this (${escape(reason)}), so no gate is claimed. The scenario becomes gated when <a href="${ISSUES}${issue}">#${issue}</a> lands.</p>
</section>`;
}

export function renderReport(report: Report) {
  const gated = report.scenarios.filter((s) => !s.unsupported);
  const rows = report.scenarios
    .map((s) =>
      s.unsupported
        ? unsupportedRow(s)
        : `<tr>
  <th scope="row"><a href="#${escape(s.name)}">${escape(s.name)}</a><small>${escape(s.capability)}</small></th>
  ${gateCell(s, "image", `${num(s.image.mean, 4)} / ${num(s.image.p99, 3)}`, report.frameTimeGate)}
  ${gateCell(s, "interaction", s.interaction.ok ? "same" : `${s.interaction.steps.filter((step) => !step.ok).length} of ${s.interaction.steps.length} differ`, report.frameTimeGate)}
  ${gateCell(s, "time", s.time.ratio === null ? "–" : `${num(s.time.mapsMs, 3)} / ${num(s.time.maplibreMs, 3)} ms (${num(s.time.ratio, 2)}×)`, report.frameTimeGate)}
  <td class="${s.passed ? "pass" : "fail"}">${escape(s.verdict)}</td>
</tr>`,
    )
    .join("\n");

  const sections = report.scenarios
    .map((s) =>
      s.unsupported
        ? unsupportedSection(s)
        : `<section id="${escape(s.name)}">
  <h2>${escape(s.name)}</h2>
  <p class="meta">${escape(s.capability)} · from ${escape(s.origin)} · Maps base renderer: ${escape(s.mapsBaseRenderer ?? "–")}</p>
  <div class="triptych">
    <figure><img src="${escape(s.files.maplibre)}" alt="MapLibre render of ${escape(s.name)}" /><figcaption>MapLibre (oracle)</figcaption></figure>
    <figure><img src="${escape(s.files.maps)}" alt="Maps render of ${escape(s.name)}" /><figcaption>Maps (first-party)</figcaption></figure>
    <figure><img src="${escape(s.files.flip)}" alt="FLIP heat map of ${escape(s.name)}" /><figcaption>FLIP ${num(s.image.mean, 4)} / p99 ${num(s.image.p99, 3)} (limit ${s.image.meanMax} / ${s.image.p99Max}; MapLibre floor ${num(s.image.floor?.mean ?? null, 4)})</figcaption></figure>
  </div>
  <div class="swipe" style="--split: 50%">
    <img src="${escape(s.files.maplibre)}" alt="" />
    <img class="top" src="${escape(s.files.maps)}" alt="" />
    <input type="range" min="0" max="100" value="50" aria-label="Swipe between MapLibre (left) and Maps (right)" />
  </div>
  <table class="steps">
    <thead><tr><th>step</th><th>picked (MapLibre)</th><th>picked (Maps)</th><th>bounds Δ px</th></tr></thead>
    <tbody>${s.interaction.steps
      .map(
        (step) =>
          `<tr class="${step.ok ? "pass" : "fail"}"><td>${escape(step.label)}</td><td>hover ${escape(ids(step.hovered.maplibre))}<br />select ${escape(ids(step.selected.maplibre))}</td><td>hover ${escape(ids(step.hovered.maps))}<br />select ${escape(ids(step.selected.maps))}</td><td>${num(step.bounds.px, 2)}</td></tr>`,
      )
      .join("")}</tbody>
  </table>
  ${s.knownGaps.map((gap) => `<p class="gap">Known gap (${escape(gap.gate)}): ${escape(gap.reason)} — <a href="${ISSUES}${gap.issue}">#${gap.issue}</a></p>`).join("")}
  ${s.time.validity === "not-run" ? "" : `<details><summary>Raw timing rounds (${escape(s.time.validity)})</summary><pre>${escape(JSON.stringify(s.time, null, 2))}</pre></details>`}
  ${s.errors.maps ? `<p class="gap">Maps page error: ${escape(s.errors.maps)}</p>` : ""}
</section>`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Maps Oracle Report</title>
<style>
:root { --bg: #fbfaf7; --fg: #1d232b; --muted: #5f6b78; --line: #dcd8cf; --card: #ffffff;
  --pass: #e3f1e6; --fail: #f8dfdc; --gap: #fbeed3; --stale: #e0e7f7; --unsupported: #eceae5; color-scheme: light; }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) { --bg: #14171b; --fg: #e8e6e1; --muted: #9aa5b1; --line: #2c323a; --card: #1b1f25;
    --pass: #1f3a28; --fail: #4a2522; --gap: #463a1d; --stale: #22304b; --unsupported: #23272d; color-scheme: dark; }
}
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, sans-serif; }
main { max-width: 1240px; margin: 0 auto; padding: 24px 16px 64px; }
h1 { margin: 0 0 4px; font-size: 26px; } h2 { margin: 40px 0 4px; font-size: 20px; }
.meta, small { color: var(--muted); } small { display: block; font-weight: 400; font-size: 12px; }
table { width: 100%; border-collapse: collapse; background: var(--card); font-variant-numeric: tabular-nums; }
th, td { border: 1px solid var(--line); padding: 6px 8px; text-align: left; vertical-align: top; }
.overview { overflow-x: auto; }
td.pass, tr.pass td { background: var(--pass); } td.fail, tr.fail td { background: var(--fail); }
td.gap { background: var(--gap); } td.stale { background: var(--stale); }
td.invalid { background: var(--fail); font-weight: 700; }
td.advisory { background: var(--unsupported); color: var(--muted); }
td.unsupported, .gap.unsupported { background: var(--unsupported); color: var(--muted); }
pre { white-space: pre-wrap; overflow-wrap: anywhere; }
.tag { display: inline; font-size: 12px; color: var(--muted); border: 1px solid var(--line); border-radius: 4px; padding: 0 6px; }
.triptych { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 10px; }
figure { margin: 0; } figure img, .swipe img { width: 100%; height: auto; display: block; border: 1px solid var(--line); }
figcaption { font-size: 12px; color: var(--muted); padding-top: 4px; }
.swipe { position: relative; margin: 12px 0; max-width: 720px; }
.swipe .top { position: absolute; inset: 0; clip-path: inset(0 0 0 var(--split)); }
.swipe input { position: absolute; left: 0; right: 0; bottom: 8px; width: 100%; }
.steps { margin-top: 12px; font-size: 13px; }
.gap { background: var(--gap); padding: 6px 10px; border-radius: 6px; }
a { color: inherit; }
</style>
</head>
<body>
<main>
<h1>Maps vs MapLibre oracle</h1>
<p class="meta">Commit ${escape(report.commit ?? "unknown")} · MapLibre GL ${escape(report.maplibreVersion ?? "?")} · ${escape(report.generatedAt)}<br />
Gates per scenario: FLIP mean ≤ ${report.flipMeanMax} and p99 ≤ ${report.flipP99Max} (or MapLibre's own noise floor, if higher); identical picked ids and bounds within ${report.boundsTolerancePx} px; frame time ≤ ${report.frameTimeMargin}× MapLibre (${report.frameTimeGate ? "enforced" : report.timingEnvironment ? "advisory" : "off"} on ${escape(report.adapter.renderer)}; each side's fastest of ${report.timing.rounds}+ interleaved rounds, a round being the median of ${report.timing.batches} batches of ${report.timing.batchFrames} back-to-back frames after a ${report.timing.warmupMs} ms warm-up; up to ${report.timing.retries} more round pairs before a ratio fails).<br />
Overall: <strong>${report.passed ? "gate passes" : "gate fails"}</strong>; ${gated.filter((s) => s.gates!.image && s.gates!.interaction && s.gates!.time).length} of ${gated.length} gated scenarios ${report.frameTimeGate ? "at full parity" : "meeting active correctness gates"}, ${report.scenarios.length - gated.length} unsupported. Amber cells are valid measured shortfalls with known gaps, not parity passes; invalid hardware measurements fail independently. Grey cells are advisory or unsupported.</p>
${report.timingEnvironment ? `<details><summary>Hardware, browser and build fingerprints</summary><pre>${escape(JSON.stringify({ adapter: report.adapter, environment: report.timingEnvironment, maplibreVersion: report.maplibreVersion, commit: report.commit }, null, 2))}</pre></details>` : ""}
<div class="overview"><table>
<thead><tr><th>scenario</th><th>image (FLIP mean / p99)</th><th>interaction</th><th>frame time (Maps / MapLibre)</th><th>result</th></tr></thead>
<tbody>
${rows}
</tbody></table></div>
${sections}
</main>
<script>
for (const swipe of document.querySelectorAll(".swipe")) {
  const input = swipe.querySelector("input");
  input.addEventListener("input", () => swipe.style.setProperty("--split", input.value + "%"));
}
</script>
</body>
</html>
`;
}
