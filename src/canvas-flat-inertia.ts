export type MapsPanVelocity = {
  x: number;
  y: number;
};

export type MapsKineticPanState = {
  elapsedMs: number;
  velocity: MapsPanVelocity;
};

export type MapsKineticPanStep = {
  deltaX: number;
  deltaY: number;
  next: MapsKineticPanState | null;
};

const SAMPLE_WINDOW_MS = 96;
const MAX_SAMPLE_GAP_MS = 80;
const MAX_RELEASE_IDLE_MS = 80;
const MAX_SPEED_PX_PER_MS = 2.5;
const START_SPEED_PX_PER_MS = 0.08;
const STOP_SPEED_PX_PER_MS = 0.02;
const MAX_DURATION_MS = 700;
const MAX_FRAME_DELTA_MS = 48;
const HALF_LIFE_MS = 140;
const DECAY_RATE = Math.LN2 / HALF_LIFE_MS;

type PanSample = {
  deltaX: number;
  deltaY: number;
  elapsedMs: number;
};

export function createMapsPanVelocityTracker() {
  const samples: PanSample[] = [];

  return {
    clear() {
      samples.length = 0;
    },
    record(deltaX: number, deltaY: number, elapsedMs: number) {
      if (
        !Number.isFinite(deltaX) ||
        !Number.isFinite(deltaY) ||
        !Number.isFinite(elapsedMs) ||
        elapsedMs <= 0 ||
        elapsedMs > MAX_SAMPLE_GAP_MS
      ) {
        samples.length = 0;
        return;
      }

      samples.push({ deltaX, deltaY, elapsedMs });
      let total = samples.reduce((sum, sample) => sum + sample.elapsedMs, 0);
      while (samples.length > 1 && total > SAMPLE_WINDOW_MS) {
        const removed = samples.shift();
        if (removed) total -= removed.elapsedMs;
      }
    },
    release(idleMs: number): MapsPanVelocity | null {
      if (!Number.isFinite(idleMs) || idleMs < 0 || idleMs > MAX_RELEASE_IDLE_MS) {
        samples.length = 0;
        return null;
      }

      const totalElapsedMs = samples.reduce((sum, sample) => sum + sample.elapsedMs, 0);
      if (totalElapsedMs <= 0) {
        samples.length = 0;
        return null;
      }

      const velocity = clampVelocity({
        x: samples.reduce((sum, sample) => sum + sample.deltaX, 0) / totalElapsedMs,
        y: samples.reduce((sum, sample) => sum + sample.deltaY, 0) / totalElapsedMs,
      });
      samples.length = 0;

      return speed(velocity) >= START_SPEED_PX_PER_MS ? velocity : null;
    },
  };
}

export function createMapsKineticPanState(
  velocity: MapsPanVelocity,
): MapsKineticPanState | null {
  if (!Number.isFinite(velocity.x) || !Number.isFinite(velocity.y)) return null;
  const bounded = clampVelocity(velocity);
  return speed(bounded) >= START_SPEED_PX_PER_MS
    ? { elapsedMs: 0, velocity: bounded }
    : null;
}

export function advanceMapsKineticPan(
  state: MapsKineticPanState,
  elapsedMs: number,
): MapsKineticPanStep {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) {
    return { deltaX: 0, deltaY: 0, next: state };
  }

  if (elapsedMs > MAX_FRAME_DELTA_MS || state.elapsedMs >= MAX_DURATION_MS) {
    return { deltaX: 0, deltaY: 0, next: null };
  }

  const stepMs = Math.min(elapsedMs, MAX_DURATION_MS - state.elapsedMs);
  const decay = Math.exp(-DECAY_RATE * stepMs);
  const integralScale = (1 - decay) / DECAY_RATE;
  const deltaX = state.velocity.x * integralScale;
  const deltaY = state.velocity.y * integralScale;
  const nextVelocity = {
    x: state.velocity.x * decay,
    y: state.velocity.y * decay,
  };
  const nextElapsedMs = state.elapsedMs + stepMs;
  const done =
    nextElapsedMs >= MAX_DURATION_MS || speed(nextVelocity) < STOP_SPEED_PX_PER_MS;

  return {
    deltaX,
    deltaY,
    next: done ? null : { elapsedMs: nextElapsedMs, velocity: nextVelocity },
  };
}

function clampVelocity(velocity: MapsPanVelocity): MapsPanVelocity {
  const magnitude = speed(velocity);
  if (magnitude <= MAX_SPEED_PX_PER_MS || magnitude === 0) return velocity;
  const scale = MAX_SPEED_PX_PER_MS / magnitude;
  return {
    x: velocity.x * scale,
    y: velocity.y * scale,
  };
}

function speed(velocity: MapsPanVelocity) {
  return Math.hypot(velocity.x, velocity.y);
}
