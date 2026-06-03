import { fireEvent, render, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";

import { GeoJsonTimelineEditor, createGeoJsonTimelineDocument } from ".";
import type { TemporalGeoJsonGeometryFeatureCollection } from "./temporal-geojson-types";

vi.mock("@moritzbrantner/timeline-editor", async () => {
  const React = await import("react");

  return {
    TimelineEditor({
      className,
      document,
      onViewportChange,
      renderItem,
      viewport,
    }: {
      className?: string;
      document: {
        durationMs?: number;
        tracks: Array<{ items: Array<{ id: string; label?: string }> }>;
      };
      onViewportChange?: (viewport: { pixelsPerSecond: number }) => void;
      renderItem?: (context: { item: { id: string; label?: string } }) => React.ReactNode;
      viewport?: { pixelsPerSecond: number };
    }) {
      const pixelsPerSecond = viewport?.pixelsPerSecond ?? 80;
      const widthPx = 144 + Math.max(((document.durationMs ?? 0) / 1_000) * pixelsPerSecond, 640);

      return React.createElement(
        "div",
        {
          className,
          "data-slot": "timeline-editor",
          onWheel: (event: React.WheelEvent<HTMLDivElement>) => {
            if (!event.ctrlKey) {
              return;
            }

            event.preventDefault();
            onViewportChange?.({
              pixelsPerSecond: pixelsPerSecond + (event.deltaY < 0 ? 16 : -16),
            });
          },
        },
        React.createElement(
          "div",
          { style: { width: widthPx } },
          document.tracks.flatMap((track) =>
            track.items.map((item) =>
              React.createElement(
                "div",
                { key: item.id },
                renderItem?.({ item }) ?? item.label ?? item.id,
              ),
            ),
          ),
        ),
      );
    },
    getTimelineEditorItemTransformValuesAt: () => ({}),
    normalizeTimelineEditorDocument: <TDocument,>(document: TDocument) => document,
    setTimelineEditorItemTransform: <TTrack,>(tracks: TTrack) => tracks,
  };
});

const timelineCollection = {
  features: [
    {
      geometry: {
        coordinates: [10, 50],
        type: "Point",
      },
      id: "point-1",
      properties: {
        label: "Point 1",
      },
      type: "Feature",
    },
  ],
  type: "FeatureCollection",
} satisfies TemporalGeoJsonGeometryFeatureCollection;

describe("@moritzbrantner/maps GeoJsonTimelineEditor", () => {
  test("keeps uncontrolled viewport zoom state between wheel events", async () => {
    const handleViewportChange = vi.fn();
    const document = createGeoJsonTimelineDocument(timelineCollection, { durationMs: 10_000 });
    const { container } = render(
      <GeoJsonTimelineEditor document={document} onViewportChange={handleViewportChange} />,
    );
    const editor = container.querySelector<HTMLElement>("[data-slot='timeline-editor']")!;
    const getContentWidth = () => editor.querySelector<HTMLElement>(":scope > div")?.style.width;

    expect(getContentWidth()).toBe("944px");

    fireEvent.wheel(editor, {
      clientX: 100,
      ctrlKey: true,
      deltaY: -120,
    });

    await waitFor(() => {
      expect(getContentWidth()).toBe("1104px");
    });

    fireEvent.wheel(editor, {
      clientX: 100,
      ctrlKey: true,
      deltaY: -120,
    });

    await waitFor(() => {
      expect(getContentWidth()).toBe("1264px");
    });

    fireEvent.wheel(editor, {
      clientX: 100,
      ctrlKey: true,
      deltaY: 120,
    });

    await waitFor(() => {
      expect(getContentWidth()).toBe("1104px");
    });
    expect(handleViewportChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ pixelsPerSecond: 96 }),
    );
  });
});
