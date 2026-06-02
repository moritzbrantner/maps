export function formatDemoCoordinate([longitude, latitude]: [longitude: number, latitude: number]) {
  return `${longitude.toFixed(2)}, ${latitude.toFixed(2)}`;
}

export function formatTemperatureValue(value: number) {
  return `${value.toFixed(1)} C`;
}

export function getHeatLayerColorRamp(color: string) {
  return [
    [0, "rgba(15, 23, 42, 0)"],
    [0.18, "#67e8f9"],
    [0.58, color],
    [1, "#dc2626"],
  ] as const;
}
