"use client";

import type React from "react";

import { joinClassNames } from "./map-display";
import { MapLegend, type MapLegendProps } from "./map-components";

export type MapLegendValueFormat = (value: number) => React.ReactNode;

export type MapColorRampLegendProps = MapLegendProps & {
  stops: readonly [value: number, color: string][];
  title?: React.ReactNode;
  valueDomain?: readonly [min: number, max: number];
  valueFormat?: MapLegendValueFormat;
};

export type MapSizeLegendProps = MapLegendProps & {
  color?: string;
  getRadius: (value: number) => number;
  title?: React.ReactNode;
  valueFormat?: MapLegendValueFormat;
  values: readonly number[];
};

export type MapCategoryLegendProps = MapLegendProps & {
  items: readonly { color: string; label: React.ReactNode }[];
  title?: React.ReactNode;
};

export type MapFlowLegendProps = MapLegendProps & {
  color?: string;
  getWidth: (value: number) => number;
  title?: React.ReactNode;
  valueFormat?: MapLegendValueFormat;
  values: readonly number[];
};

export function MapColorRampLegend({
  children,
  className,
  stops,
  title,
  valueDomain,
  valueFormat = defaultLegendValueFormat,
  ...props
}: MapColorRampLegendProps) {
  const validStops = stops.filter(([value]) => Number.isFinite(value));
  const domain = valueDomain ?? getLegendValueDomain(validStops);
  const gradient = validStops.length
    ? `linear-gradient(90deg, ${validStops
        .map(([value, color]) => `${color} ${getStopPercent(value, domain).toFixed(2)}%`)
        .join(", ")})`
    : undefined;

  return (
    <MapLegend {...props} className={joinClassNames("mb-maps__legend--color-ramp", className)}>
      {title ? <div className="mb-maps__legend-title">{title}</div> : null}
      <div className="mb-maps__legend-ramp" style={{ background: gradient }} />
      <div className="mb-maps__legend-row">
        <span className="mb-maps__legend-label">{valueFormat(domain[0])}</span>
        <span className="mb-maps__legend-label">{valueFormat(domain[1])}</span>
      </div>
      {children}
    </MapLegend>
  );
}

export function MapSizeLegend({
  children,
  className,
  color = "#0f172a",
  getRadius,
  title,
  valueFormat = defaultLegendValueFormat,
  values,
  ...props
}: MapSizeLegendProps) {
  return (
    <MapLegend {...props} className={joinClassNames("mb-maps__legend--size", className)}>
      {title ? <div className="mb-maps__legend-title">{title}</div> : null}
      {values.map((value) => {
        const radius = Math.max(0, getRadius(value));
        const size = Math.max(4, radius * 2);

        return (
          <div className="mb-maps__legend-row" key={value}>
            <span
              aria-hidden="true"
              className="mb-maps__legend-symbol mb-maps__legend-symbol--circle"
              style={{
                "--mb-maps-legend-color": color,
                height: size,
                width: size,
              } as React.CSSProperties}
            />
            <span className="mb-maps__legend-label">{valueFormat(value)}</span>
          </div>
        );
      })}
      {children}
    </MapLegend>
  );
}

export function MapCategoryLegend({
  children,
  className,
  items,
  title,
  ...props
}: MapCategoryLegendProps) {
  return (
    <MapLegend {...props} className={joinClassNames("mb-maps__legend--category", className)}>
      {title ? <div className="mb-maps__legend-title">{title}</div> : null}
      {items.map((item, index) => (
        <div className="mb-maps__legend-row" key={index}>
          <span
            aria-hidden="true"
            className="mb-maps__legend-symbol"
            style={{ "--mb-maps-legend-color": item.color } as React.CSSProperties}
          />
          <span className="mb-maps__legend-label">{item.label}</span>
        </div>
      ))}
      {children}
    </MapLegend>
  );
}

export function MapFlowLegend({
  children,
  className,
  color = "#0f766e",
  getWidth,
  title,
  valueFormat = defaultLegendValueFormat,
  values,
  ...props
}: MapFlowLegendProps) {
  return (
    <MapLegend {...props} className={joinClassNames("mb-maps__legend--flow", className)}>
      {title ? <div className="mb-maps__legend-title">{title}</div> : null}
      {values.map((value) => (
        <div className="mb-maps__legend-row" key={value}>
          <span
            aria-hidden="true"
            className="mb-maps__legend-symbol mb-maps__legend-symbol--line"
            style={{
              "--mb-maps-legend-color": color,
              "--mb-maps-legend-line-width": `${Math.max(1, getWidth(value))}px`,
            } as React.CSSProperties}
          />
          <span className="mb-maps__legend-label">{valueFormat(value)}</span>
        </div>
      ))}
      {children}
    </MapLegend>
  );
}

function defaultLegendValueFormat(value: number) {
  return Number.isInteger(value) ? value.toLocaleString() : value.toLocaleString(undefined, {
    maximumFractionDigits: 2,
  });
}

function getLegendValueDomain(stops: readonly [value: number, color: string][]) {
  if (stops.length === 0) {
    return [0, 1] as const;
  }

  return [stops[0]![0], stops[stops.length - 1]![0]] as const;
}

function getStopPercent(value: number, domain: readonly [min: number, max: number]) {
  const span = domain[1] - domain[0];

  if (!Number.isFinite(span) || Math.abs(span) <= 1e-12) {
    return 0;
  }

  return Math.max(0, Math.min(100, ((value - domain[0]) / span) * 100));
}
