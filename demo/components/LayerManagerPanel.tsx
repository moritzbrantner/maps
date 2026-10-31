import type { Dispatch, SetStateAction } from "react";

import { Button, NativeSelect } from "@moritzbrantner/ui";

import type { DemoLayerConfig, DemoLayerKind } from "../types";

const layerKinds: Array<{ id: DemoLayerKind; label: string }> = [
  { id: "points", label: "Points" },
  { id: "bubbles", label: "Bubbles" },
  { id: "heat", label: "Heat" },
  { id: "flows", label: "Flows" },
  { id: "clusters", label: "Clusters" },
];

const layerColors = ["#0f172a", "#0f766e", "#2563eb", "#b45309", "#be123c"];

export const initialLayers: DemoLayerConfig[] = [
  {
    color: "#0f766e",
    enabled: true,
    id: "layer-heat-1",
    kind: "heat",
    name: "Heat 1",
  },
  {
    color: "#b45309",
    enabled: true,
    id: "layer-flows-1",
    kind: "flows",
    name: "Flows 1",
  },
  {
    color: "#0f172a",
    enabled: true,
    id: "layer-points-1",
    kind: "points",
    name: "Points 1",
  },
];

export function LayerManagerPanel({
  layers,
  setLayers,
}: {
  layers: DemoLayerConfig[];
  setLayers: Dispatch<SetStateAction<DemoLayerConfig[]>>;
}) {
  const addLayer = (kind: DemoLayerKind) => {
    setLayers((current) => {
      const nextNumber = current.filter((layer) => layer.kind === kind).length + 1;
      const color = layerColors[current.length % layerColors.length];

      return [
        ...current,
        {
          color,
          enabled: true,
          id: `layer-${kind}-${Date.now()}-${current.length}`,
          kind,
          name: `${getLayerKindLabel(kind)} ${nextNumber}`,
        },
      ];
    });
  };
  const updateLayer = (id: string, patch: Partial<DemoLayerConfig>) => {
    setLayers((current) =>
      current.map((layer) =>
        layer.id === id
          ? {
              ...layer,
              ...patch,
              name:
                patch.kind && patch.kind !== layer.kind
                  ? getLayerKindLabel(patch.kind)
                  : layer.name,
            }
          : layer,
      ),
    );
  };
  const removeLayer = (id: string) => {
    setLayers((current) => current.filter((layer) => layer.id !== id));
  };

  return (
    <div className="demo-layer-manager" aria-label="Layer manager">
      <div className="demo-layer-manager__header">
        <h2>Layers</h2>
        <div className="demo-layer-add">
          {layerKinds.map((kind) => (
            <Button
              className="h-8"
              key={kind.id}
              size="sm"
              variant="secondary"
              type="button"
              onClick={() => addLayer(kind.id)}
            >
              + {kind.label}
            </Button>
          ))}
        </div>
      </div>
      <div className="demo-layer-list">
        {layers.map((layer) => (
          <div className="demo-layer-row" key={layer.id}>
            <label className="demo-layer-toggle">
              <input
                checked={layer.enabled}
                type="checkbox"
                onChange={(event) => updateLayer(layer.id, { enabled: event.target.checked })}
              />
              <span>{layer.name}</span>
            </label>
            <label className="grid gap-1 text-xs font-medium text-muted-foreground">
              <span>Type</span>
              <NativeSelect
                size="sm"
                value={layer.kind}
                onChange={(event) =>
                  updateLayer(layer.id, { kind: event.target.value as DemoLayerKind })
                }
              >
                {layerKinds.map((kind) => (
                  <option key={kind.id} value={kind.id}>
                    {kind.label}
                  </option>
                ))}
              </NativeSelect>
            </label>
            <div className="demo-layer-colors" aria-label={`${layer.name} color`}>
              {layerColors.map((color) => (
                <button
                  aria-pressed={layer.color === color}
                  className="demo-color-swatch"
                  key={color}
                  style={{ background: color }}
                  title={color}
                  type="button"
                  onClick={() => updateLayer(layer.id, { color })}
                />
              ))}
            </div>
            <Button size="sm" variant="outline" type="button" onClick={() => removeLayer(layer.id)}>
              Remove
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}

function getLayerKindLabel(kind: DemoLayerKind) {
  return layerKinds.find((item) => item.id === kind)?.label ?? "Layer";
}
