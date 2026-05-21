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

export function FeatureOverlays({
  popup,
  tooltip,
  onClosePopup,
}: {
  popup: FeatureOverlayState | null;
  tooltip: FeatureOverlayState | null;
  onClosePopup: () => void;
}) {
  useEffect(() => {
    if (!popup) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClosePopup();
      }
    }

    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClosePopup, popup]);

  if (!tooltip && !popup) {
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
    </div>
  );
}

function createOverlayStyle(position: FeatureOverlayPosition, offsetY: number) {
  return {
    left: Math.max(8, position.x),
    top: Math.max(8, position.y + offsetY),
  };
}
