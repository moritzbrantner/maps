import type { FlowMapFeature, MapFlow } from "@moritzbrantner/maps";

import { formatDemoCoordinate } from "../lib/format";

export function FlowVolumeLegend({ flows }: { flows: MapFlow[] }) {
  const values = getDemoFlowLegendValues(flows);

  return (
    <div className="demo-flow-legend" aria-label="Flow volume">
      <div className="demo-layer-manager__header">
        <h2>Flow volume</h2>
      </div>
      <div className="demo-flow-legend__rows">
        {values.map((item) => (
          <div className="demo-flow-legend__row" key={item.label}>
            <span className="demo-flow-legend__sample" aria-hidden="true">
              <span style={{ height: item.strokeWidth }} />
            </span>
            <span className="demo-flow-legend__label">
              <span>{item.label}</span>
              <strong>{item.value.toLocaleString()} trips</strong>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function renderDemoFlowTooltip(feature: FlowMapFeature) {
  return (
    <div className="demo-popup">
      <strong>{feature.flow.label}</strong>
      <span>{feature.rawValue.toLocaleString()} trips</span>
    </div>
  );
}

export function renderDemoFlowPopup(feature: FlowMapFeature) {
  return (
    <div className="demo-popup">
      <strong>{feature.flow.label}</strong>
      <span>{feature.rawValue.toLocaleString()} trips</span>
      <span>From {formatDemoCoordinate(feature.flow.from)}</span>
      <span>To {formatDemoCoordinate(feature.flow.to)}</span>
    </div>
  );
}

function getDemoFlowLegendValues(flows: MapFlow[]) {
  const values = flows
    .map((item) => item.metrics?.trips ?? 0)
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b);

  if (values.length === 0) {
    return [
      { label: "Low", strokeWidth: 3, value: 0 },
      { label: "Medium", strokeWidth: 7, value: 0 },
      { label: "High", strokeWidth: 12, value: 0 },
    ];
  }

  return [
    { label: "Low", strokeWidth: 3, value: values[0]! },
    { label: "Medium", strokeWidth: 7, value: values[Math.floor(values.length / 2)]! },
    { label: "High", strokeWidth: 12, value: values.at(-1)! },
  ];
}
