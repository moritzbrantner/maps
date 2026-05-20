export type MapCoordinate = [longitude: number, latitude: number];

export type MapMeasurementMode = "none" | "bee-line";

export type MapDistanceFormat = "metric" | "imperial" | "meters";

export type MapBeeLineMeasurement = {
  id: string;
  from: MapCoordinate;
  to: MapCoordinate;
  label?: string;
};

export type MapBeeLineMeasurementDraft = {
  from: MapCoordinate;
  to?: MapCoordinate;
  distanceMeters?: number;
  formattedDistance?: string;
};

export type MapBeeLineMeasurementResult = {
  from: MapCoordinate;
  to: MapCoordinate;
  distanceMeters: number;
  formattedDistance: string;
};

export type MapMeasurementProps = {
  measurementMode?: MapMeasurementMode;
  measurements?: readonly MapBeeLineMeasurement[];
  measurementDistanceFormat?: MapDistanceFormat;
  measurementLineColor?: string;
  measurementDraftLineColor?: string;
  onMeasurementCreate?: (measurement: MapBeeLineMeasurementResult) => void;
  onMeasurementDraftChange?: (draft: MapBeeLineMeasurementDraft | null) => void;
  onMeasurementSelect?: (measurement: MapBeeLineMeasurement | null) => void;
};

const EARTH_RADIUS_METERS = 6_371_008.8;

export function normalizeMapCoordinate(coordinate: readonly number[] | null | undefined) {
  if (!coordinate || coordinate.length < 2) {
    return null;
  }

  const [longitude, latitude] = coordinate;

  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) {
    return null;
  }

  if (latitude < -90 || latitude > 90) {
    return null;
  }

  return [normalizeLongitude(longitude), latitude] as MapCoordinate;
}

export function getBeeLineDistanceMeters(
  fromCoordinate: readonly number[] | null | undefined,
  toCoordinate: readonly number[] | null | undefined,
) {
  const from = normalizeMapCoordinate(fromCoordinate);
  const to = normalizeMapCoordinate(toCoordinate);

  if (!from || !to) {
    return null;
  }

  const fromLatitude = toRadians(from[1]);
  const toLatitude = toRadians(to[1]);
  const deltaLatitude = toRadians(to[1] - from[1]);
  const deltaLongitude = toRadians(shortestLongitudeDelta(from[0], to[0]));
  const haversine =
    Math.sin(deltaLatitude / 2) ** 2 +
    Math.cos(fromLatitude) * Math.cos(toLatitude) * Math.sin(deltaLongitude / 2) ** 2;

  return 2 * EARTH_RADIUS_METERS * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

export function formatMapDistance(
  distanceMeters: number,
  measurementDistanceFormat: MapDistanceFormat = "metric",
) {
  const safeDistance = Number.isFinite(distanceMeters) ? Math.max(0, distanceMeters) : 0;

  if (measurementDistanceFormat === "meters") {
    return `${Math.round(safeDistance).toLocaleString("en")} m`;
  }

  if (measurementDistanceFormat === "imperial") {
    const feet = safeDistance * 3.280839895;

    if (feet < 5280) {
      return `${Math.round(feet).toLocaleString("en")} ft`;
    }

    return `${formatDistanceUnit(feet / 5280)} mi`;
  }

  if (safeDistance < 1000) {
    return `${Math.round(safeDistance).toLocaleString("en")} m`;
  }

  return `${formatDistanceUnit(safeDistance / 1000)} km`;
}

export function getBeeLineMeasurementLabel(
  measurement: Pick<MapBeeLineMeasurement, "from" | "label" | "to">,
  measurementDistanceFormat: MapDistanceFormat = "metric",
) {
  if (measurement.label) {
    return measurement.label;
  }

  const distanceMeters = getBeeLineDistanceMeters(measurement.from, measurement.to);

  return distanceMeters === null ? null : formatMapDistance(distanceMeters, measurementDistanceFormat);
}

export function getBeeLineMidpoint(
  fromCoordinate: readonly number[] | null | undefined,
  toCoordinate: readonly number[] | null | undefined,
) {
  const from = normalizeMapCoordinate(fromCoordinate);
  const to = normalizeMapCoordinate(toCoordinate);

  if (!from || !to) {
    return null;
  }

  const deltaLongitude = shortestLongitudeDelta(from[0], to[0]);

  return [normalizeLongitude(from[0] + deltaLongitude / 2), (from[1] + to[1]) / 2] as MapCoordinate;
}

function formatDistanceUnit(value: number) {
  return value >= 10 ? value.toFixed(1) : value.toFixed(2);
}

function normalizeLongitude(longitude: number) {
  if (longitude >= -180 && longitude <= 180) {
    return longitude === -180 ? 180 : longitude;
  }

  const normalized = ((((longitude + 180) % 360) + 360) % 360) - 180;

  return normalized === -180 ? 180 : normalized;
}

function shortestLongitudeDelta(fromLongitude: number, toLongitude: number) {
  return ((((toLongitude - fromLongitude + 180) % 360) + 360) % 360) - 180;
}

function toRadians(value: number) {
  return (value * Math.PI) / 180;
}
