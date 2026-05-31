"use client";

import {
  Children,
  isValidElement,
  type HTMLAttributes,
  type ReactElement,
  type ReactNode,
} from "react";

import { joinClassNames } from "./map-display";

const MAP_VIEW_SLOT = Symbol.for("@moritzbrantner/maps/map-view-slot");

type MapViewSlot = "layers" | "overlay";
type MapViewSlotComponent = {
  [MAP_VIEW_SLOT]?: MapViewSlot;
};

export type MapLayersProps = {
  children?: ReactNode;
};

export function MapLayers({ children }: MapLayersProps) {
  return <>{children}</>;
}

(MapLayers as MapViewSlotComponent)[MAP_VIEW_SLOT] = "layers";

export type MapOverlayPosition =
  | "bottom"
  | "bottom-left"
  | "bottom-right"
  | "left"
  | "right"
  | "top"
  | "top-left"
  | "top-right";

export type MapOverlayProps = Omit<HTMLAttributes<HTMLDivElement>, "children"> & {
  children?: ReactNode;
  position?: MapOverlayPosition;
};

export function MapOverlay({
  children,
  className,
  position = "top-right",
  ...props
}: MapOverlayProps) {
  return (
    <div
      {...props}
      className={joinClassNames(
        "mb-maps__overlay",
        `mb-maps__overlay--${position}`,
        className,
      )}
    >
      {children}
    </div>
  );
}

(MapOverlay as MapViewSlotComponent)[MAP_VIEW_SLOT] = "overlay";

export type MapControlsProps = MapOverlayProps;

export function MapControls({
  className,
  position = "top-right",
  role = "toolbar",
  ...props
}: MapControlsProps) {
  return (
    <MapOverlay
      {...props}
      className={joinClassNames("mb-maps__controls", className)}
      position={position}
      role={role}
    />
  );
}

(MapControls as MapViewSlotComponent)[MAP_VIEW_SLOT] = "overlay";

export type MapLegendProps = MapOverlayProps;

export function MapLegend({
  className,
  position = "bottom-left",
  role = "region",
  ...props
}: MapLegendProps) {
  return (
    <MapOverlay
      {...props}
      className={joinClassNames("mb-maps__legend", className)}
      position={position}
      role={role}
    />
  );
}

(MapLegend as MapViewSlotComponent)[MAP_VIEW_SLOT] = "overlay";

export function splitMapViewChildren(children: ReactNode) {
  const layers: ReactNode[] = [];
  const overlays: ReactNode[] = [];

  Children.forEach(children, (child) => {
    if (!isValidElement(child)) {
      layers.push(child);
      return;
    }

    const slot = getMapViewSlot(child);

    if (slot === "overlay") {
      overlays.push(child);
      return;
    }

    if (slot === "layers") {
      layers.push((child as ReactElement<MapLayersProps>).props.children);
      return;
    }

    layers.push(child);
  });

  return { layers, overlays };
}

function getMapViewSlot(element: ReactElement) {
  return (element.type as MapViewSlotComponent)[MAP_VIEW_SLOT] ?? null;
}
