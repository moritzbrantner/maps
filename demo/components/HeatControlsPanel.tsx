import { Button } from "@moritzbrantner/ui";
import type { HeatFieldRenderMode } from "@moritzbrantner/maps";

export function HeatControlsPanel({
  contourLineWidth: heatFieldContourLineWidth,
  onContourLineWidthChange: setHeatFieldContourLineWidth,
  onRenderModeChange: setHeatFieldRenderMode,
  onShowDataPointsChange: setShowHeatDataPoints,
  renderMode: heatFieldRenderMode,
  showDataPoints: showHeatDataPoints,
}: {
  contourLineWidth: number;
  onContourLineWidthChange: (width: number) => void;
  onRenderModeChange: (mode: HeatFieldRenderMode) => void;
  onShowDataPointsChange: (show: boolean) => void;
  renderMode: HeatFieldRenderMode;
  showDataPoints: boolean;
}) {
  return (
    <div className="demo-layer-manager" aria-label="Heat map controls">
      <div className="demo-layer-manager__header">
        <h2>Heat map</h2>
      </div>
      <div className="demo-editor-mode-grid" aria-label="Heat map render mode">
        <Button
          aria-pressed={heatFieldRenderMode === "raster"}
          size="sm"
          variant={heatFieldRenderMode === "raster" ? "default" : "secondary"}
          type="button"
          onClick={() => setHeatFieldRenderMode("raster")}
        >
          Colors
        </Button>
        <Button
          aria-pressed={heatFieldRenderMode === "raster-contours"}
          size="sm"
          variant={heatFieldRenderMode === "raster-contours" ? "default" : "secondary"}
          type="button"
          onClick={() => setHeatFieldRenderMode("raster-contours")}
        >
          Both
        </Button>
        <Button
          aria-pressed={heatFieldRenderMode === "contours"}
          size="sm"
          variant={heatFieldRenderMode === "contours" ? "default" : "secondary"}
          type="button"
          onClick={() => setHeatFieldRenderMode("contours")}
        >
          Level lines
        </Button>
      </div>
      <label className="demo-layer-slider">
        <span>Line thickness</span>
        <output>{heatFieldContourLineWidth.toFixed(2)} px</output>
        <input
          aria-label="Level line thickness"
          max="4"
          min="0.5"
          step="0.25"
          type="range"
          value={heatFieldContourLineWidth}
          onChange={(event) => setHeatFieldContourLineWidth(Number(event.currentTarget.value))}
        />
      </label>
      <label className="demo-layer-toggle">
        <input
          checked={showHeatDataPoints}
          type="checkbox"
          onChange={(event) => setShowHeatDataPoints(event.target.checked)}
        />
        <span>Show data points</span>
      </label>
    </div>
  );
}
