import { useMemo, type Dispatch, type SetStateAction } from "react";

import { Badge, Button } from "@moritzbrantner/ui";
import type {
  GeoJsonEditMode,
  GeoJsonEditorSelection,
  TemporalGeoJsonGeometryFeatureCollection,
} from "@moritzbrantner/maps";

import {
  countDemoGeometryParts,
  countDemoGeometryPositions,
  createDemoGeoJsonDuplicate,
  getDemoFeatureId,
  getDemoGeoJsonFeature,
  getDemoGeoJsonLabel,
  getDemoGroupId,
  setDemoGroupId,
  updateDemoGeoJsonFeature,
} from "../lib/geojson-features";
import type { DemoGeoJsonProperties } from "../types";

const editorModes: Array<{ id: GeoJsonEditMode; label: string }> = [
  { id: "select", label: "Select" },
  { id: "draw-point", label: "Point" },
  { id: "draw-line", label: "Line" },
  { id: "draw-polygon", label: "Polygon" },
  { id: "move", label: "Move" },
  { id: "reshape", label: "Reshape" },
  { id: "delete", label: "Delete" },
];

export const emptyGeoJsonEditorSelection: GeoJsonEditorSelection = {
  featureIds: [],
  primaryFeatureId: null,
  vertexHandle: null,
};

export function GeoJsonEditorPanel({
  editMode,
  editableGeoJson,
  geoJsonSelection,
  setEditMode,
  setEditableGeoJson,
  setGeoJsonSelection,
}: {
  editMode: GeoJsonEditMode;
  editableGeoJson: TemporalGeoJsonGeometryFeatureCollection<DemoGeoJsonProperties>;
  geoJsonSelection: GeoJsonEditorSelection;
  setEditMode: Dispatch<SetStateAction<GeoJsonEditMode>>;
  setEditableGeoJson: Dispatch<
    SetStateAction<TemporalGeoJsonGeometryFeatureCollection<DemoGeoJsonProperties>>
  >;
  setGeoJsonSelection: Dispatch<SetStateAction<GeoJsonEditorSelection>>;
}) {
  const selectedGeoJsonId = geoJsonSelection.primaryFeatureId;
  const selectedGeoJsonFeature = useMemo(
    () => getDemoGeoJsonFeature(editableGeoJson, selectedGeoJsonId),
    [editableGeoJson, selectedGeoJsonId],
  );
  const selectedGeoJsonLabel = selectedGeoJsonFeature
    ? getDemoGeoJsonLabel(selectedGeoJsonFeature)
    : "";
  const selectedGeoJsonType = selectedGeoJsonFeature?.geometry.type ?? null;
  const selectedGeoJsonCanReshape = selectedGeoJsonType !== null && selectedGeoJsonType !== "Point";
  const selectedGeoJsonFeatures = useMemo(
    () =>
      geoJsonSelection.featureIds.flatMap((featureId) => {
        const feature = getDemoGeoJsonFeature(editableGeoJson, featureId);

        return feature ? [feature] : [];
      }),
    [editableGeoJson, geoJsonSelection.featureIds],
  );
  const selectedGeoJsonGroupIds = useMemo(
    () => [...new Set(selectedGeoJsonFeatures.flatMap((feature) => getDemoGroupId(feature) ?? []))],
    [selectedGeoJsonFeatures],
  );
  const renameSelectedGeoJsonFeature = (label: string) => {
    if (!selectedGeoJsonId) {
      return;
    }

    setEditableGeoJson((current) =>
      updateDemoGeoJsonFeature(current, selectedGeoJsonId, (feature) => ({
        ...feature,
        properties: {
          ...feature.properties,
          label,
        },
      })),
    );
  };
  const deleteSelectedGeoJsonFeatures = () => {
    if (geoJsonSelection.featureIds.length === 0) {
      return;
    }

    const selectedIds = new Set(geoJsonSelection.featureIds);

    setEditableGeoJson((current) => ({
      ...current,
      features: current.features.filter(
        (feature, index) => !selectedIds.has(getDemoFeatureId(feature, index)),
      ),
    }));
    setGeoJsonSelection(emptyGeoJsonEditorSelection);
    setEditMode("select");
  };
  const duplicateSelectedGeoJsonFeatures = () => {
    if (geoJsonSelection.featureIds.length === 0) {
      return;
    }

    const selectedIds = new Set(geoJsonSelection.featureIds);
    const nextGroupId = geoJsonSelection.featureIds.length > 1 ? `demo-group-${Date.now()}` : null;
    const nextIds: string[] = [];

    setEditableGeoJson((current) => {
      const duplicates = current.features.flatMap((feature, index) => {
        const featureId = getDemoFeatureId(feature, index);

        if (!selectedIds.has(featureId)) {
          return [];
        }

        const nextId = `${featureId}-copy-${Date.now()}-${nextIds.length + 1}`;

        nextIds.push(nextId);

        return [createDemoGeoJsonDuplicate(feature, nextId, nextGroupId)];
      });

      return {
        ...current,
        features: [...current.features, ...duplicates],
      };
    });
    setGeoJsonSelection({
      featureIds: nextIds,
      primaryFeatureId: nextIds[0] ?? null,
      vertexHandle: null,
    });
    setEditMode("move");
  };
  const groupSelectedDemoGeoJsonFeatures = () => {
    if (geoJsonSelection.featureIds.length < 2) {
      return;
    }

    const selectedIds = new Set(geoJsonSelection.featureIds);
    const groupId = `demo-group-${Date.now()}`;

    setEditableGeoJson((current) => ({
      ...current,
      features: current.features.map((feature, index) =>
        selectedIds.has(getDemoFeatureId(feature, index))
          ? setDemoGroupId(feature, groupId)
          : feature,
      ),
    }));
  };
  const ungroupSelectedDemoGeoJsonFeatures = () => {
    if (geoJsonSelection.featureIds.length === 0) {
      return;
    }

    const selectedIds = new Set(geoJsonSelection.featureIds);
    const groupIds = new Set(selectedGeoJsonGroupIds);

    setEditableGeoJson((current) => ({
      ...current,
      features: current.features.map((feature, index) => {
        const featureId = getDemoFeatureId(feature, index);
        const groupId = getDemoGroupId(feature);

        return selectedIds.has(featureId) || (groupId !== null && groupIds.has(groupId))
          ? setDemoGroupId(feature, null)
          : feature;
      }),
    }));
  };

  return (
    <div className="demo-layer-manager" aria-label="GeoJSON editor controls">
      <div className="demo-layer-manager__header">
        <h2>Editor</h2>
      </div>
      <div className="demo-editor-section" aria-label="Add GeoJSON element">
        <div className="demo-editor-section__header">
          <h3>Add element</h3>
          <Badge variant={editMode.startsWith("draw-") ? "default" : "secondary"}>
            {editMode.startsWith("draw-") ? "Preview" : "Idle"}
          </Badge>
        </div>
        <div className="demo-editor-mode-grid">
          {editorModes.map((mode) => (
            <Button
              aria-pressed={editMode === mode.id}
              key={mode.id}
              size="sm"
              title={getEditorModeShortcut(mode.id)}
              variant={editMode === mode.id ? "default" : "secondary"}
              type="button"
              onClick={() => setEditMode(mode.id)}
            >
              {mode.label}
            </Button>
          ))}
        </div>
        <dl className="demo-editor-facts">
          <div>
            <dt>Mode</dt>
            <dd>{editMode}</dd>
          </div>
          <div>
            <dt>Features</dt>
            <dd>{editableGeoJson.features.length}</dd>
          </div>
          <div>
            <dt>Selection</dt>
            <dd>{geoJsonSelection.featureIds.length}</dd>
          </div>
        </dl>
        <div className="demo-editor-shortcuts" aria-label="Editor shortcuts">
          <kbd>Shift</kbd>
          <span>multi-select</span>
          <kbd>Alt</kbd>
          <span>select group</span>
          <kbd>Del</kbd>
          <span>delete</span>
        </div>
      </div>
      <div className="demo-editor-section" aria-label="Selected GeoJSON element">
        <div className="demo-editor-section__header">
          <h3>
            {geoJsonSelection.featureIds.length > 1
              ? `${geoJsonSelection.featureIds.length} selected`
              : "Selected element"}
          </h3>
          <Badge variant={selectedGeoJsonFeature ? "default" : "outline"}>
            {selectedGeoJsonType ?? "None"}
          </Badge>
        </div>
        {selectedGeoJsonFeature ? (
          <>
            <label className="demo-editor-label">
              <span>Name</span>
              <input
                value={selectedGeoJsonLabel}
                onChange={(event) => renameSelectedGeoJsonFeature(event.target.value)}
              />
            </label>
            <dl className="demo-editor-facts">
              <div>
                <dt>ID</dt>
                <dd>{selectedGeoJsonId}</dd>
              </div>
              <div>
                <dt>Group</dt>
                <dd>{selectedGeoJsonGroupIds.join(", ") || "None"}</dd>
              </div>
              <div>
                <dt>Vertices</dt>
                <dd>{countDemoGeometryPositions(selectedGeoJsonFeature.geometry)}</dd>
              </div>
              <div>
                <dt>Parts</dt>
                <dd>{countDemoGeometryParts(selectedGeoJsonFeature.geometry)}</dd>
              </div>
            </dl>
            <div className="demo-editor-action-grid">
              <Button
                size="sm"
                variant={editMode === "move" ? "default" : "secondary"}
                type="button"
                onClick={() => setEditMode("move")}
              >
                Move
              </Button>
              {selectedGeoJsonCanReshape ? (
                <Button
                  size="sm"
                  variant={editMode === "reshape" ? "default" : "secondary"}
                  type="button"
                  onClick={() => setEditMode("reshape")}
                >
                  Reshape
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="secondary"
                type="button"
                onClick={duplicateSelectedGeoJsonFeatures}
              >
                Duplicate
              </Button>
              <Button
                disabled={geoJsonSelection.featureIds.length < 2}
                size="sm"
                variant="secondary"
                type="button"
                onClick={groupSelectedDemoGeoJsonFeatures}
              >
                Group
              </Button>
              <Button
                disabled={selectedGeoJsonGroupIds.length === 0}
                size="sm"
                variant="secondary"
                type="button"
                onClick={ungroupSelectedDemoGeoJsonFeatures}
              >
                Ungroup
              </Button>
              <Button
                size="sm"
                variant={editMode === "delete" ? "default" : "outline"}
                type="button"
                onClick={deleteSelectedGeoJsonFeatures}
              >
                Delete
              </Button>
              {editMode === "reshape" && geoJsonSelection.vertexHandle ? (
                <Button
                  size="sm"
                  variant="outline"
                  type="button"
                  onClick={() =>
                    setGeoJsonSelection({
                      ...geoJsonSelection,
                      vertexHandle: null,
                    })
                  }
                >
                  Clear node
                </Button>
              ) : null}
            </div>
            {editMode === "reshape" ? (
              <p className="demo-editor-hint">
                Click midpoint handles to add nodes. Select a node and press Delete to remove it.
              </p>
            ) : null}
          </>
        ) : (
          <div className="demo-editor-empty">
            <p>No element selected</p>
            <Button
              size="sm"
              variant={editMode === "select" ? "default" : "secondary"}
              type="button"
              onClick={() => setEditMode("select")}
            >
              Select element
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function getEditorModeShortcut(mode: GeoJsonEditMode) {
  switch (mode) {
    case "select":
      return "V";
    case "draw-point":
      return "P";
    case "draw-line":
      return "L";
    case "draw-polygon":
      return "G";
    case "move":
      return "M";
    case "reshape":
      return "R";
    case "delete":
      return "Delete";
    default:
      return "";
  }
}
