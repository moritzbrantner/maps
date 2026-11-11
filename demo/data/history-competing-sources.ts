import type { HistoricalMapFeatureReconstruction } from "@moritzbrantner/maps";

/**
 * Explicitly SYNTHETIC competing-source fixture for the History tab (#231 phase C).
 *
 * The regions, names, dates, geometry, sources and disagreements below are all invented to
 * demonstrate how a Map View presents ONE consumer-chosen boundary reconstruction with its
 * source status and attributed alternative interpretations (Atlas Decision 1.12). None of it is
 * historical evidence, none of it is derived from CShapes-Europe (ADR 0005), and the
 * alternatives are explanation only: they have no geometry and are never drawn.
 */
export const demoCompetingSourcesCaveat =
  "Synthetic fixture: these regions, dates, sources and disagreements are invented to show how one chosen reconstruction and its attributed alternatives are presented. Not historical evidence.";

export type DemoCompetingSourcesRegion = {
  label: string;
  polityId: string;
};

export type DemoCompetingSourcesScene = {
  label: string;
  /** The chosen reconstruction drawn at this milestone, per region. Absent regions are not drawn. */
  regions: { polityId: string; ring: [number, number][] }[];
  year: number;
};

export const demoCompetingSourcesRegions: DemoCompetingSourcesRegion[] = [
  { label: "Sample Borderland (synthetic)", polityId: "synthetic-borderland" },
  { label: "Sample Upland (synthetic)", polityId: "synthetic-upland" },
];

function box(west: number, south: number, east: number, north: number): [number, number][] {
  return [
    [west, south],
    [east, south],
    [east, north],
    [west, north],
    [west, south],
  ];
}

/** Held milestone snapshots of the chosen reconstruction (ADR 0005 snap/hold). */
export const demoCompetingSourcesScenes: DemoCompetingSourcesScene[] = [
  {
    label: "1850 AD",
    regions: [
      { polityId: "synthetic-borderland", ring: box(6, 46, 10, 48.5) },
      { polityId: "synthetic-upland", ring: box(10, 46, 13, 48.5) },
    ],
    year: 1850,
  },
  {
    label: "1900 AD",
    regions: [
      { polityId: "synthetic-borderland", ring: box(6, 46, 11, 48.5) },
      { polityId: "synthetic-upland", ring: box(11, 46, 13, 48.5) },
    ],
    year: 1900,
  },
  {
    label: "1950 AD",
    regions: [{ polityId: "synthetic-upland", ring: box(9, 46, 13, 48.5) }],
    year: 1950,
  },
];

const synthetic = "(synthetic source invented for this demo)";

/**
 * The consumer's chosen reconstruction per period, keyed by polity ID. Periods match the held
 * milestone snapshots that draw each region.
 */
export const demoCompetingSourcesReconstructions: Record<
  string,
  HistoricalMapFeatureReconstruction[]
> = {
  "synthetic-borderland": [
    {
      alternatives: [
        {
          attribution: `Illustrative Chronicle B ${synthetic}`,
          disagreement:
            "Places the eastern boundary about one degree further east, along the river, inside the area drawn here as Sample Upland.",
          evidence: "An invented toll register naming river crossings.",
          limitations: "Invented for this demo; described as compiled decades later.",
        },
        {
          attribution: `Illustrative Atlas C ${synthetic}`,
          disagreement: "Excludes the northern valley from Sample Borderland.",
          evidence: "An invented printed map.",
          limitations: "Invented for this demo; described as a small-scale overview map.",
        },
      ],
      attribution: `Illustrative Survey A ${synthetic}`,
      end: 1900,
      label: "1850–1899",
      limitations: "Straight-line outline: the fixture does not model terrain.",
      start: 1850,
      status: "reconstructed",
      uncertainty: "Eastern edge uncertain by about one degree (invented).",
    },
    {
      attribution: `Illustrative Treaty Map D ${synthetic}`,
      end: 1950,
      label: "1900–1949",
      limitations: "Straight-line outline: the fixture does not model terrain.",
      start: 1900,
      status: "documentary",
    },
  ],
  "synthetic-upland": [
    {
      attribution: `Illustrative Gazetteer E ${synthetic}`,
      label: "from 1850",
      limitations: "Deliberately coarse outline.",
      start: 1850,
      status: "approximate",
    },
  ],
};
