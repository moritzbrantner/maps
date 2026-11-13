"use client";

import {
  useContext,
  useEffect,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { MapSurfaceContext } from "./map-surface-context";
import type { MapsLayerInteraction, MapsLayerInteractionEvent } from "./maps-layer-interaction";
import type { BeeLineMeasurementLayerProps } from "./measurement-map-layer";
import {
  formatMapDistance,
  getBeeLineDistanceMeters,
  getBeeLineMeasurementLabel,
  getBeeLineMidpoint,
  normalizeMapCoordinate,
  type MapBeeLineMeasurementDraft,
  type MapCoordinate,
} from "./measurement";

/** Canvas is only a presentation/picking adapter; geographic projection belongs to Rust. */
export function MapsBeeLineMeasurementLayer({
  interaction,
  measurements = [],
  measurementMode = "none",
  measurementDistanceFormat = "metric",
  measurementLineColor = "#0f766e",
  measurementDraftLineColor = measurementLineColor,
  layerId,
  onMeasurementCreate,
  onMeasurementDraftChange,
  onMeasurementSelect,
}: BeeLineMeasurementLayerProps & { interaction: MapsLayerInteraction }) {
  const surface = useContext(MapSurfaceContext);
  const generatedId = useId();
  const id = layerId ?? `measurement-${generatedId}`;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const draftRef = useRef<MapBeeLineMeasurementDraft | null>(null);
  const [pitched, setPitched] = useState(false);
  const measuring = measurementMode === "bee-line";
  const registerMode = surface?.registerInteractionMode;

  const clearDraft = useEffectEvent(() => {
    if (draftRef.current) {
      draftRef.current = null;
      onMeasurementDraftChange?.(null);
    }
  });

  const draw = useEffectEvent(() => {
    const canvas = canvasRef.current;
    const container = canvas?.parentElement;
    if (!canvas || !container) return;
    const { width, height } = container.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    canvas.dataset.measurementCount = String(measurements.length);
    canvas.dataset.measurementDraft = draftRef.current ? "true" : "false";
    if (width <= 0 || height <= 0) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.scale(ratio, ratio);
    context.font = "12px sans-serif";
    context.textAlign = "center";
    context.textBaseline = "middle";
    const line = (
      from: MapCoordinate,
      to: MapCoordinate | undefined,
      color: string,
      label: string | null,
      draft: boolean,
    ) => {
      const start = interaction.project(from);
      const end = to ? interaction.project(to) : null;
      if (!start) return;
      context.strokeStyle = color;
      context.fillStyle = color;
      context.lineWidth = 3;
      context.setLineDash(draft ? [6, 4] : []);
      if (end) {
        context.beginPath();
        context.moveTo(start.x, start.y);
        context.lineTo(end.x, end.y);
        context.stroke();
      }
      context.setLineDash([]);
      for (const point of end ? [start, end] : [start]) {
        context.beginPath();
        context.arc(point.x, point.y, 4, 0, Math.PI * 2);
        context.fill();
      }
      const midpoint = to ? getBeeLineMidpoint(from, to) : null;
      const position = midpoint ? interaction.project(midpoint) : null;
      if (position && label) {
        const textWidth = context.measureText(label).width;
        context.fillStyle = "#ffffff";
        context.fillRect(position.x - textWidth / 2 - 5, position.y - 10, textWidth + 10, 20);
        context.fillStyle = color;
        context.fillText(label, position.x, position.y);
      }
    };
    for (const measurement of measurements) {
      const from = normalizeMapCoordinate(measurement.from);
      const to = normalizeMapCoordinate(measurement.to);
      if (from && to)
        line(
          from,
          to,
          measurementLineColor,
          getBeeLineMeasurementLabel(measurement, measurementDistanceFormat),
          false,
        );
    }
    const draft = draftRef.current;
    if (draft)
      line(draft.from, draft.to, measurementDraftLineColor, draft.formattedDistance ?? null, true);
    canvas.dataset.measurementCount = String(measurements.length);
    canvas.dataset.measurementDraft = draft ? "true" : "false";
  });

  const handleInteraction = useEffectEvent((event: MapsLayerInteractionEvent): boolean => {
    if (event.type === "cancel") {
      clearDraft();
      draw();
      return false;
    }
    if (event.type === "camera") {
      const unsupported = interaction.getPitch() !== 0;
      setPitched(unsupported);
      if (unsupported) clearDraft();
      draw();
      return false;
    }
    if (measuring && interaction.getMode() === "measurement") {
      if (interaction.getPitch() !== 0) return true;
      const coordinate = normalizeMapCoordinate(event.coordinates);
      if (!coordinate) return true;
      const from = draftRef.current?.from;
      if (!from) {
        if (event.type === "click") {
          draftRef.current = { from: coordinate };
          onMeasurementDraftChange?.(draftRef.current);
        }
      } else {
        const distanceMeters = getBeeLineDistanceMeters(from, coordinate);
        if (distanceMeters === null) return true;
        const result = {
          from,
          to: coordinate,
          distanceMeters,
          formattedDistance: formatMapDistance(distanceMeters, measurementDistanceFormat),
        };
        if (event.type === "click") {
          onMeasurementCreate?.(result);
          clearDraft();
        } else {
          draftRef.current = result;
          onMeasurementDraftChange?.(result);
        }
      }
      draw();
      return true;
    }
    if (event.type === "click" && interaction.getMode() === "none") {
      // Picking is screen-space presentation work, against the current projected line.
      for (const measurement of [...measurements].reverse()) {
        const from = normalizeMapCoordinate(measurement.from);
        const to = normalizeMapCoordinate(measurement.to);
        const start = from ? interaction.project(from) : null;
        const end = to ? interaction.project(to) : null;
        if (!start || !end) continue;
        const dx = end.x - start.x;
        const dy = end.y - start.y;
        const lengthSquared = dx * dx + dy * dy;
        const t =
          lengthSquared === 0
            ? 0
            : Math.max(
                0,
                Math.min(
                  1,
                  ((event.position.x - start.x) * dx + (event.position.y - start.y) * dy) /
                    lengthSquared,
                ),
              );
        if (
          Math.hypot(event.position.x - start.x - t * dx, event.position.y - start.y - t * dy) <= 8
        ) {
          onMeasurementSelect?.(measurement);
          return true;
        }
      }
    }
    return false;
  });

  useEffect(() => {
    if (!measuring) return;
    return registerMode?.(id, "measurement");
  }, [id, measuring, registerMode]);
  useEffect(() => {
    const unsubscribe = interaction.subscribe((event) => handleInteraction(event));
    return () => {
      unsubscribe();
      clearDraft();
    };
  }, [interaction]);
  useEffect(() => {
    clearDraft();
    draw();
  }, [measuring, measurementDistanceFormat]);
  useLayoutEffect(() => {
    draw();
  });
  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => draw());
    if (canvasRef.current?.parentElement) observer.observe(canvasRef.current.parentElement);
    return () => observer.disconnect();
  }, []);

  return (
    <>
      <canvas
        aria-hidden="true"
        ref={canvasRef}
        data-map-measurement-runtime="maps"
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          pointerEvents: "none",
          zIndex: 2,
        }}
      />
      {measuring && (
        <span
          role="status"
          style={{
            position: "absolute",
            bottom: 24,
            left: 12,
            zIndex: 3,
            background: "white",
            padding: 4,
            pointerEvents: "none",
          }}
        >
          {pitched
            ? "Measurement requires zero pitch. Reset map tilt to measure."
            : "Choose two locations to measure. Escape cancels."}
        </span>
      )}
    </>
  );
}
