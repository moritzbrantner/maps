import { Map as MapLibreMap, MercatorCoordinate } from "maplibre-gl";

const SCENARIO_SCHEMA_VERSION = "maps.engine-scenario/v1";
const OBSERVATION_SCHEMA_VERSION = "maps.engine-observation/v1";
const CAMERA_WORLD_PAN_V1 = "camera-world-pan-v1";
const TILE_SIZE = 512;

/**
 * Execute the canonical camera scenario through public MapLibre APIs and emit
 * the Maps-owned normalized observation contract. MapLibre internals never
 * cross this adapter boundary.
 */
export async function executeMapLibreCameraScenario(scenario) {
  validateScenario(scenario);

  const container = document.createElement("div");
  container.style.position = "fixed";
  container.style.left = "-10000px";
  container.style.top = "0";
  setViewportSize(container, scenario.viewport);
  document.body.append(container);

  const map = new MapLibreMap({
    attributionControl: false,
    bearing: scenario.initialCamera.bearing,
    center: [scenario.initialCamera.longitude, scenario.initialCamera.latitude],
    container,
    fadeDuration: 0,
    interactive: false,
    pitch: scenario.initialCamera.pitch,
    renderWorldCopies: true,
    style: { version: 8, sources: {}, layers: [] },
    zoom: scenario.initialCamera.zoom,
  });

  try {
    await waitForLoad(map);

    const states = [captureState(map, scenario, 0, "initial")];
    for (const [index, operation] of scenario.operations.entries()) {
      applyOperation(map, container, operation);
      states.push(captureState(map, scenario, index + 1, operation.type));
    }

    return {
      schemaVersion: OBSERVATION_SCHEMA_VERSION,
      scenarioId: scenario.id,
      implementation: {
        name: "maplibre-gl",
        protocol: "maps-reference/camera-v1",
      },
      declaredObservations: [...scenario.observations],
      runtimePhases: [...scenario.runtimePhases],
      states,
    };
  } finally {
    map.remove();
    container.remove();
  }
}

function validateScenario(scenario) {
  if (scenario?.schemaVersion !== SCENARIO_SCHEMA_VERSION) {
    throw new Error(`unsupported Maps engine scenario schema ${scenario?.schemaVersion}`);
  }
  if (scenario.id !== CAMERA_WORLD_PAN_V1) {
    throw new Error(`unsupported MapLibre reference scenario ${scenario.id}`);
  }
}

function waitForLoad(map) {
  if (map.loaded()) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const onError = (event) => {
      map.off("load", onLoad);
      reject(event.error ?? new Error("MapLibre reference failed to load"));
    };
    const onLoad = () => {
      map.off("error", onError);
      resolve();
    };

    map.once("error", onError);
    map.once("load", onLoad);
  });
}

function applyOperation(map, container, operation) {
  switch (operation.type) {
    case "set-center":
      map.jumpTo({ center: [operation.longitude, operation.latitude] });
      return;
    case "set-zoom":
      map.jumpTo({ zoom: operation.zoom });
      return;
    case "resize":
      setViewportSize(container, operation);
      map.resize();
      return;
    default:
      throw new Error(`unsupported camera operation ${operation.type}`);
  }
}

function setViewportSize(container, viewport) {
  if (!(viewport.width > 0) || !(viewport.height > 0)) {
    throw new Error("camera reference viewport must be positive");
  }
  container.style.width = `${viewport.width}px`;
  container.style.height = `${viewport.height}px`;
}

function captureState(map, scenario, sequence, operation) {
  const center = map.getCenter();
  const viewport = {
    width: map.getContainer().clientWidth,
    height: map.getContainer().clientHeight,
  };

  return {
    sequence,
    operation,
    camera: {
      longitude: canonicalZero(wrapLongitude(center.lng)),
      latitude: canonicalZero(center.lat),
      zoom: canonicalZero(map.getZoom()),
      bearing: canonicalZero(map.getBearing()),
      pitch: canonicalZero(map.getPitch()),
      viewport,
    },
    visibleBounds: visibleBounds(map, viewport),
    projections: scenario.coordinates.map((input) => captureProjection(map, input)),
  };
}

function visibleBounds(map, viewport) {
  const middleX = viewport.width / 2;
  const middleY = viewport.height / 2;
  const north = map.unproject([middleX, 0]).lat;
  const south = map.unproject([middleX, viewport.height]).lat;
  const worldSize = TILE_SIZE * 2 ** map.getZoom();

  if (viewport.width >= worldSize) {
    return {
      west: -180,
      south: canonicalZero(Math.min(south, north)),
      east: 180,
      north: canonicalZero(Math.max(south, north)),
      crossesAntimeridian: false,
      spansFullWorld: true,
    };
  }

  const west = wrapLongitude(map.unproject([0, middleY]).lng);
  const east = wrapLongitude(map.unproject([viewport.width, middleY]).lng);

  return {
    west: canonicalZero(west),
    south: canonicalZero(Math.min(south, north)),
    east: canonicalZero(east),
    north: canonicalZero(Math.max(south, north)),
    crossesAntimeridian: west > east,
    spansFullWorld: false,
  };
}

function captureProjection(map, input) {
  const world = MercatorCoordinate.fromLngLat({ lng: input[0], lat: input[1] });
  const screen = map.project(input);
  const unprojected = map.unproject(screen);

  return {
    input: input.map(canonicalZero),
    wrappedLongitude: canonicalZero(wrapLongitude(input[0])),
    world: [canonicalZero(world.x), canonicalZero(world.y)],
    screen: [canonicalZero(screen.x), canonicalZero(screen.y)],
    unprojected: [
      canonicalZero(wrapLongitude(unprojected.lng)),
      canonicalZero(unprojected.lat),
    ],
  };
}

function wrapLongitude(longitude) {
  return ((((longitude + 180) % 360) + 360) % 360) - 180;
}

function canonicalZero(value) {
  return Object.is(value, -0) || value === 0 ? 0 : value;
}
