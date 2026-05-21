"use client";

import {
  createGlobeGraticuleLines,
  createVisibleSvgPath,
  getGlobeRadius,
  GLOBE_VIEWBOX_HEIGHT,
  GLOBE_VIEWBOX_WIDTH,
  projectGlobeCoordinate,
  type GlobeProjectionResult,
  type GlobeViewState,
} from "./map-display";

const globeLandmasses: ReadonlyArray<ReadonlyArray<[longitude: number, latitude: number]>> = [
  [
    [-168, 72],
    [-146, 70],
    [-126, 61],
    [-124, 49],
    [-117, 33],
    [-105, 24],
    [-96, 16],
    [-84, 10],
    [-79, 18],
    [-66, 18],
    [-60, 45],
    [-52, 55],
    [-62, 63],
    [-86, 71],
    [-116, 74],
    [-144, 73],
    [-168, 72],
  ],
  [
    [-82, 12],
    [-70, 12],
    [-50, 5],
    [-35, -8],
    [-43, -23],
    [-54, -37],
    [-68, -55],
    [-76, -42],
    [-73, -16],
    [-82, 0],
    [-82, 12],
  ],
  [
    [-52, 60],
    [-37, 65],
    [-22, 75],
    [-40, 83],
    [-62, 76],
    [-72, 68],
    [-52, 60],
  ],
  [
    [-10, 36],
    [0, 52],
    [22, 70],
    [60, 72],
    [100, 70],
    [140, 61],
    [170, 55],
    [160, 36],
    [137, 33],
    [121, 20],
    [105, 8],
    [81, 8],
    [70, 25],
    [50, 30],
    [44, 12],
    [35, 31],
    [29, 45],
    [12, 43],
    [0, 36],
    [-10, 36],
  ],
  [
    [-17, 35],
    [5, 37],
    [30, 31],
    [42, 12],
    [51, -2],
    [40, -20],
    [31, -35],
    [18, -35],
    [7, -25],
    [-5, -12],
    [-17, 5],
    [-17, 35],
  ],
  [
    [113, -11],
    [130, -10],
    [153, -24],
    [145, -39],
    [121, -35],
    [112, -22],
    [113, -11],
  ],
  [
    [-180, -70],
    [-130, -74],
    [-70, -72],
    [-10, -75],
    [50, -70],
    [110, -74],
    [180, -70],
  ],
  [
    [47, -13],
    [50, -18],
    [49, -25],
    [45, -25],
    [43, -18],
    [47, -13],
  ],
  [
    [138, 35],
    [142, 40],
    [145, 44],
    [140, 45],
    [136, 38],
    [138, 35],
  ],
];

export function GlobeBase({ viewState }: { viewState: GlobeViewState }) {
  const radius = getGlobeRadius(viewState.zoom);

  return (
    <>
      <defs>
        <radialGradient id="mb-maps-globe-ocean" cx="38%" cy="30%" r="70%">
          <stop offset="0%" stopColor="#f8fafc" />
          <stop offset="58%" stopColor="#bae6fd" />
          <stop offset="100%" stopColor="#0f766e" />
        </radialGradient>
      </defs>
      <circle
        className="mb-maps__globe-ocean"
        cx={GLOBE_VIEWBOX_WIDTH / 2}
        cy={GLOBE_VIEWBOX_HEIGHT / 2}
        r={radius}
      />
      <g className="mb-maps__globe-land">
        {createGlobeLandPaths(viewState).map((path, index) => (
          <path d={path} key={index} />
        ))}
      </g>
      <g className="mb-maps__globe-graticule">
        {createGlobeGraticuleLines(viewState).map((line, index) => {
          const path = createVisibleSvgPath(line);

          return path ? <path d={path} key={index} /> : null;
        })}
      </g>
      <circle
        className="mb-maps__globe-rim"
        cx={GLOBE_VIEWBOX_WIDTH / 2}
        cy={GLOBE_VIEWBOX_HEIGHT / 2}
        r={radius}
      />
    </>
  );
}

export function createGlobeLandPaths(viewState: GlobeViewState) {
  return globeLandmasses.flatMap((landmass) =>
    createVisibleSvgPolygons(landmass.map((coordinate) => projectGlobeCoordinate(coordinate, viewState))),
  );
}

function createVisibleSvgPolygons(points: readonly GlobeProjectionResult[]) {
  const paths: string[] = [];
  let segment: GlobeProjectionResult[] = [];

  for (const point of points) {
    if (!point.visible) {
      pushSegment(paths, segment);
      segment = [];
      continue;
    }

    segment.push(point);
  }

  pushSegment(paths, segment);

  return paths;
}

function pushSegment(paths: string[], segment: readonly GlobeProjectionResult[]) {
  if (segment.length < 3) {
    return;
  }

  paths.push(`${createVisibleSvgPath(segment)}Z`);
}
