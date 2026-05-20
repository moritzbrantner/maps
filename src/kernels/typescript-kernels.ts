export type FlatKernelInput = Float64Array | readonly number[];

export function resampleLineFlat(
  coordinates: FlatKernelInput,
  coordinateCount: number,
): Float64Array {
  validateFlatCoordinates(coordinates, 2, "line coordinates");
  validateCoordinateCount(coordinateCount, 2);

  const sourceCount = coordinates.length / 2;

  if (sourceCount === coordinateCount) {
    return new Float64Array(coordinates);
  }

  const distances = getCumulativeDistancesFlat(coordinates, false);
  const totalDistance = distances.at(-1) ?? 0;

  if (totalDistance === 0) {
    return repeatFlatPosition(coordinates, coordinateCount);
  }

  const samples = new Float64Array(coordinateCount * 2);
  let segmentIndex = 0;

  for (let index = 0; index < coordinateCount; index += 1) {
    const offset = index * 2;

    if (index === coordinateCount - 1) {
      samples[offset] = coordinates[(sourceCount - 1) * 2]!;
      samples[offset + 1] = coordinates[(sourceCount - 1) * 2 + 1]!;
      continue;
    }

    const sample = interpolateAlongPathFromSegmentFlat(
      coordinates,
      distances,
      (totalDistance * index) / (coordinateCount - 1),
      false,
      segmentIndex,
    );

    samples[offset] = sample.x;
    samples[offset + 1] = sample.y;
    segmentIndex = sample.segmentIndex;
  }

  return samples;
}

export function resampleRingFlat(
  openRing: FlatKernelInput,
  coordinateCount: number,
): Float64Array {
  validateFlatCoordinates(openRing, 3, "ring coordinates");
  validateCoordinateCount(coordinateCount, 3);

  const distances = getCumulativeDistancesFlat(openRing, true);
  const totalDistance = distances.at(-1) ?? 0;

  if (totalDistance === 0) {
    return repeatFlatPosition(openRing, coordinateCount);
  }

  const samples = new Float64Array(coordinateCount * 2);
  let segmentIndex = 0;

  for (let index = 0; index < coordinateCount; index += 1) {
    const sample = interpolateAlongPathFromSegmentFlat(
      openRing,
      distances,
      (totalDistance * index) / coordinateCount,
      true,
      segmentIndex,
    );
    const offset = index * 2;

    samples[offset] = sample.x;
    samples[offset + 1] = sample.y;
    segmentIndex = sample.segmentIndex;
  }

  return samples;
}

function validateFlatCoordinates(
  coordinates: FlatKernelInput,
  minPoints: number,
  label: string,
) {
  if (coordinates.length < minPoints * 2) {
    throw new Error(`${label} must contain at least ${minPoints} positions`);
  }

  if (coordinates.length % 2 !== 0) {
    throw new Error(`${label} length must be even`);
  }

  for (const value of coordinates) {
    if (!Number.isFinite(value)) {
      throw new Error(`${label} must be finite`);
    }
  }
}

function validateCoordinateCount(coordinateCount: number, minimum: number) {
  if (!Number.isInteger(coordinateCount) || coordinateCount < minimum) {
    throw new Error(`coordinate count must be an integer of at least ${minimum}`);
  }
}

function getCumulativeDistancesFlat(coordinates: FlatKernelInput, closed: boolean) {
  const pointCount = coordinates.length / 2;
  const segmentCount = closed ? pointCount : pointCount - 1;
  const distances = new Float64Array(segmentCount + 1);

  for (let index = 0; index < segmentCount; index += 1) {
    const startOffset = index * 2;
    const endOffset = ((index + 1) % pointCount) * 2;

    distances[index + 1] =
      distances[index]! +
      Math.hypot(
        coordinates[endOffset]! - coordinates[startOffset]!,
        coordinates[endOffset + 1]! - coordinates[startOffset + 1]!,
      );
  }

  return distances;
}

function interpolateAlongPathFromSegmentFlat(
  coordinates: FlatKernelInput,
  distances: Float64Array,
  targetDistance: number,
  closed: boolean,
  startSegmentIndex: number,
) {
  const pointCount = coordinates.length / 2;
  const segmentCount = closed ? pointCount : pointCount - 1;
  const clampedTargetDistance = Math.min(Math.max(targetDistance, 0), distances.at(-1) ?? 0);

  for (let index = startSegmentIndex; index < segmentCount; index += 1) {
    const segmentStartDistance = distances[index]!;
    const segmentEndDistance = distances[index + 1]!;

    if (clampedTargetDistance > segmentEndDistance) {
      continue;
    }

    const startOffset = index * 2;
    const endOffset = ((index + 1) % pointCount) * 2;
    const segmentLength = segmentEndDistance - segmentStartDistance;
    const progress =
      segmentLength === 0 ? 0 : (clampedTargetDistance - segmentStartDistance) / segmentLength;
    const startX = coordinates[startOffset]!;
    const startY = coordinates[startOffset + 1]!;

    return {
      segmentIndex: index,
      x: startX + (coordinates[endOffset]! - startX) * progress,
      y: startY + (coordinates[endOffset + 1]! - startY) * progress,
    };
  }

  const fallbackOffset = (pointCount - 1) * 2;

  return {
    segmentIndex: Math.max(segmentCount - 1, 0),
    x: coordinates[fallbackOffset]!,
    y: coordinates[fallbackOffset + 1]!,
  };
}

function repeatFlatPosition(coordinates: FlatKernelInput, coordinateCount: number) {
  const samples = new Float64Array(coordinateCount * 2);

  for (let index = 0; index < coordinateCount; index += 1) {
    const offset = index * 2;

    samples[offset] = coordinates[0]!;
    samples[offset + 1] = coordinates[1]!;
  }

  return samples;
}
