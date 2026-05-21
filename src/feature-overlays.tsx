"use client";

import { useEffect, type ReactNode } from "react";

import { joinClassNames } from "./map-display";

export type FeatureOverlayPosition = {
  x: number;
  y: number;
};

export type FeatureOverlayState = {
  feature: unknown;
  position: FeatureOverlayPosition;
  render: (feature: unknown) => ReactNode;
};

export type ContextMenuOverlayState = {
  context: unknown;
  position: FeatureOverlayPosition;
  render: (context: unknown) => ReactNode;
};

export function FeatureOverlays({
  contextMenu,
  popup,
  tooltip,
  onCloseContextMenu,
  onClosePopup,
}: {
  contextMenu: ContextMenuOverlayState | null;
  popup: FeatureOverlayState | null;
  tooltip: FeatureOverlayState | null;
  onCloseContextMenu: () => void;
  onClosePopup: () => void;
}) {
  useEffect(() => {
    if (!popup && !contextMenu) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClosePopup();
        onCloseContextMenu();
      }
    }

    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [contextMenu, onCloseContextMenu, onClosePopup, popup]);

  if (!tooltip && !popup && !contextMenu) {
    return null;
  }

  return (
    <div className="mb-maps__feature-overlay" aria-live="polite">
      {tooltip ? (
        <div
          className="mb-maps__feature-tooltip"
          style={createOverlayStyle(tooltip.position, -12)}
        >
          {tooltip.render(tooltip.feature)}
        </div>
      ) : null}
      {popup ? (
        <div
          className={joinClassNames("mb-maps__feature-popup")}
          style={createOverlayStyle(popup.position, 12)}
          role="dialog"
        >
          {popup.render(popup.feature)}
        </div>
      ) : null}
      {contextMenu ? (
        <div
          className="mb-maps__context-menu"
          style={createContextMenuStyle(contextMenu.position)}
          role="menu"
          onClick={(event) => {
            event.stopPropagation();
          }}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          {contextMenu.render(contextMenu.context)}
        </div>
      ) : null}
    </div>
  );
}

function createOverlayStyle(position: FeatureOverlayPosition, offsetY: number) {
  return {
    left: Math.max(8, position.x),
    top: Math.max(8, position.y + offsetY),
  };
}

function createContextMenuStyle(position: FeatureOverlayPosition) {
  return {
    left: Math.max(8, position.x),
    top: Math.max(8, position.y),
  };
}
