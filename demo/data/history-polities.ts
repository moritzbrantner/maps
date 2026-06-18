import {
  createGeoJsonTransitionPlan,
  interpolateTemporalGeoJsonGeometry,
  interpolateGeoJsonTransitionPlan,
  type GeoJsonTransitionPlan,
  type TemporalGeoJsonGeometryFeatureCollection,
  type TemporalGeoJsonGeometryFeature,
  type TemporalGeoJsonSupportedGeometry,
} from "@moritzbrantner/maps";

export type DemoHistoricalPolityRegion =
  | "atlantic"
  | "central"
  | "eastern"
  | "nordic"
  | "southern"
  | "ottoman";

export type DemoHistoricalPolityPrecision = "approximate" | "generalized";

export type DemoHistoricalPolityLineage = {
  entersFrom: string[];
  exitsTo: string[];
  morphGroup: string;
};

export type DemoHistoricalPolityProperties = {
  kind: "historical-polity";
  label: string;
  polityId: string;
  region: DemoHistoricalPolityRegion;
  precision: DemoHistoricalPolityPrecision;
  sceneYear: number;
  conditioned?: true;
  lineage?: DemoHistoricalPolityLineage;
  note?: string;
  displayOpacity?: number;
  sourceIds?: Array<string | number>;
  sourcePartPath?: string;
  targetIds?: Array<string | number>;
  targetPartPath?: string;
  transitionKind?: string;
};

export type DemoHistoricalPolitySceneValidationIssue = {
  code: "invalid-geometry" | "missing-lineage" | "unclosed-ring" | "undetailed-ring";
  message: string;
  polityId: string;
  sceneYear: number;
};

type HistoricalPolityInput = {
  geometry: TemporalGeoJsonSupportedGeometry;
  label: string;
  note?: string;
  polityId: string;
  precision?: DemoHistoricalPolityPrecision;
  region: DemoHistoricalPolityRegion;
};

type DemoHistoricalPolityScene = {
  label: string;
  year: number;
  collection: TemporalGeoJsonGeometryFeatureCollection<DemoHistoricalPolityProperties>;
};

type HistoricalPolityRenderableFeature = {
  id?: string | number;
  properties?: Partial<DemoHistoricalPolityProperties> | null;
};

const historyVisibleOpacityThreshold = 0.05;
const historyMinimumRingCoordinateCount = 24;
const demoHistoricalPolityPlaybackFrameCache = new Map<
  number,
  TemporalGeoJsonGeometryFeatureCollection<DemoHistoricalPolityProperties>
>();

const rawDemoHistoricalPolityScenes: DemoHistoricalPolityScene[] = [
  scene(800, [
    polity("carolingian-empire", "Carolingian Empire", "central", rect(-5, 42, 15, 54)),
    polity(
      "byzantine-empire",
      "Byzantine Empire",
      "southern",
      multi([rect(15, 37, 30, 45), rect(22, 35, 36, 41)]),
    ),
    polity("emirate-cordoba", "Emirate of Cordoba", "southern", rect(-9, 36, -1, 43)),
    polity("kingdom-asturias", "Kingdom of Asturias", "atlantic", rect(-9, 42, -3, 44)),
    polity(
      "papal-central-italian-states",
      "Papal / Central Italian States",
      "southern",
      rect(10, 41, 15, 45),
    ),
    polity("first-bulgarian-empire", "First Bulgarian Empire", "eastern", rect(20, 42, 29, 48)),
    polity("anglo-saxon-kingdoms", "Anglo-Saxon Kingdoms", "atlantic", rect(-6, 50, 2, 56)),
    polity(
      "norse-realms",
      "Norse Realms",
      "nordic",
      multi([rect(5, 57, 13, 63), rect(10, 55, 17, 58)]),
    ),
  ]),
  scene(1000, [
    polity("france", "Kingdom of France", "atlantic", rect(-5, 43, 6, 51)),
    polity("holy-roman-empire", "Holy Roman Empire", "central", rect(5, 45, 16, 55)),
    polity(
      "byzantine-empire",
      "Byzantine Empire",
      "southern",
      multi([rect(18, 38, 30, 45), rect(24, 36, 36, 41)]),
    ),
    polity("al-andalus", "Al-Andalus", "southern", rect(-9, 36, -1, 42)),
    polity(
      "christian-iberian-kingdoms",
      "Christian Iberian Kingdoms",
      "atlantic",
      rect(-9, 41, 3, 44),
    ),
    polity("england", "Kingdom of England", "atlantic", rect(-6, 50, 2, 56)),
    polity("poland", "Kingdom of Poland", "eastern", rect(14, 49, 24, 55)),
    polity("hungary", "Kingdom of Hungary", "central", rect(15, 45, 23, 49)),
    polity("kievan-rus", "Kievan Rus", "eastern", rect(24, 49, 38, 58)),
    polity("denmark", "Denmark", "nordic", rect(8, 54, 13, 58)),
    polity("norway", "Norway", "nordic", rect(5, 58, 12, 66)),
    polity("sweden", "Sweden", "nordic", rect(12, 57, 22, 66)),
  ]),
  scene(1200, [
    polity("france", "Kingdom of France", "atlantic", rect(-5, 43, 7, 51)),
    polity("holy-roman-empire", "Holy Roman Empire", "central", rect(6, 45, 17, 55)),
    polity(
      "angevin-lands",
      "Kingdom of England / Angevin Lands",
      "atlantic",
      multi([rect(-6, 50, 2, 56), rect(-2, 44, 4, 49)]),
    ),
    polity("castile", "Crown of Castile", "southern", rect(-8, 37, -2, 43)),
    polity("aragon", "Crown of Aragon", "southern", rect(-2, 40, 4, 43)),
    polity("portugal", "Portugal", "atlantic", rect(-9, 37, -6, 42)),
    polity(
      "byzantine-empire",
      "Byzantine Empire",
      "southern",
      multi([rect(20, 38, 29, 43), rect(25, 36, 34, 40)]),
    ),
    polity("second-bulgarian-empire", "Second Bulgarian Empire", "eastern", rect(22, 42, 29, 47)),
    polity("hungary", "Kingdom of Hungary", "central", rect(15, 45, 24, 50)),
    polity("poland", "Poland", "eastern", rect(14, 50, 24, 55)),
    polity("rus-principalities", "Rus Principalities", "eastern", rect(24, 50, 39, 58)),
    polity("denmark", "Denmark", "nordic", rect(8, 54, 13, 58)),
    polity("norway", "Norway", "nordic", rect(5, 58, 12, 66)),
    polity("sweden", "Sweden", "nordic", rect(12, 57, 23, 66)),
  ]),
  scene(1450, [
    polity("france", "Kingdom of France", "atlantic", rect(-5, 43, 7, 51)),
    polity("england", "Kingdom of England", "atlantic", rect(-6, 50, 2, 56)),
    polity("holy-roman-empire", "Holy Roman Empire", "central", rect(6, 45, 17, 55)),
    polity("castile", "Castile", "southern", rect(-8, 37, -2, 43)),
    polity("aragon", "Aragon", "southern", rect(-2, 40, 4, 43)),
    polity("portugal", "Portugal", "atlantic", rect(-9, 37, -6, 42)),
    polity(
      "ottoman-empire",
      "Ottoman Empire",
      "ottoman",
      multi([rect(20, 39, 31, 46), rect(25, 36, 39, 42)]),
    ),
    polity("hungary", "Kingdom of Hungary", "central", rect(15, 45, 24, 50)),
    polity("poland-lithuania", "Poland-Lithuania", "eastern", rect(16, 49, 32, 57)),
    polity("muscovy", "Muscovy", "eastern", rect(30, 53, 42, 60)),
    polity(
      "denmark-norway",
      "Denmark-Norway",
      "nordic",
      multi([rect(5, 58, 12, 66), rect(8, 54, 13, 58)]),
    ),
    polity("sweden", "Sweden", "nordic", rect(12, 57, 23, 66)),
    polity("venice", "Venice", "southern", rect(11, 44, 18, 46)),
  ]),
  scene(1648, [
    polity("france", "France", "atlantic", rect(-5, 43, 8, 51)),
    polity("spain", "Spain", "southern", rect(-8, 36, 4, 43)),
    polity("portugal", "Portugal", "atlantic", rect(-9, 37, -6, 42)),
    polity("england-scotland", "England and Scotland", "atlantic", rect(-7, 50, 2, 59)),
    polity("holy-roman-empire", "Holy Roman Empire", "central", rect(6, 47, 16, 55)),
    polity("dutch-republic", "Dutch Republic", "atlantic", rect(3, 51, 7, 54)),
    polity("sweden", "Sweden", "nordic", multi([rect(12, 57, 23, 66), rect(14, 54, 20, 57)])),
    polity(
      "denmark-norway",
      "Denmark-Norway",
      "nordic",
      multi([rect(5, 58, 12, 66), rect(8, 54, 13, 58)]),
    ),
    polity(
      "polish-lithuanian-commonwealth",
      "Polish-Lithuanian Commonwealth",
      "eastern",
      rect(16, 49, 34, 57),
    ),
    polity("russia", "Russia", "eastern", rect(32, 52, 45, 61)),
    polity("habsburg-monarchy", "Habsburg Monarchy", "central", rect(13, 45, 25, 50)),
    polity(
      "ottoman-empire",
      "Ottoman Empire",
      "ottoman",
      multi([rect(19, 39, 31, 47), rect(25, 36, 40, 42)]),
    ),
  ]),
  scene(1815, [
    polity("france", "France", "atlantic", rect(-5, 43, 8, 51)),
    polity("united-kingdom", "United Kingdom", "atlantic", rect(-8, 50, 2, 59)),
    polity("spain", "Spain", "southern", rect(-8, 36, 4, 43)),
    polity("portugal", "Portugal", "atlantic", rect(-9, 37, -6, 42)),
    polity("netherlands", "Netherlands", "atlantic", rect(3, 50, 7, 53)),
    polity("german-confederation", "German Confederation", "central", rect(6, 47, 15, 54)),
    polity("austrian-empire", "Austrian Empire", "central", rect(12, 45, 26, 50)),
    polity("prussia", "Prussia", "central", multi([rect(11, 51, 19, 55), rect(19, 53, 24, 56)])),
    polity("russian-empire", "Russian Empire", "eastern", rect(24, 49, 45, 62)),
    polity(
      "ottoman-empire",
      "Ottoman Empire",
      "ottoman",
      multi([rect(20, 39, 31, 46), rect(26, 36, 41, 42)]),
    ),
    polity("sweden-norway", "Sweden-Norway", "nordic", rect(5, 57, 24, 66)),
    polity("denmark", "Denmark", "nordic", rect(8, 54, 12, 57)),
    polity(
      "sardinia",
      "Kingdom of Sardinia",
      "southern",
      multi([rect(7, 44, 10, 46), rect(8, 39, 10, 41)]),
    ),
    polity(
      "two-sicilies",
      "Two Sicilies",
      "southern",
      multi([rect(13, 37, 17, 42), rect(12, 38, 15, 39)]),
    ),
    polity("papal-states", "Papal States", "southern", rect(11, 41, 14, 44)),
  ]),
  scene(2000, [
    polity("france", "France", "atlantic", rect(-5, 43, 8, 51), "generalized"),
    polity("united-kingdom", "United Kingdom", "atlantic", rect(-8, 50, 2, 59), "generalized"),
    polity("spain", "Spain", "southern", rect(-8, 36, 4, 43), "generalized"),
    polity("portugal", "Portugal", "atlantic", rect(-9, 37, -6, 42), "generalized"),
    polity("germany", "Germany", "central", rect(6, 47, 15, 55), "generalized"),
    polity(
      "italy",
      "Italy",
      "southern",
      multi([rect(7, 44, 14, 47), rect(10, 37, 18, 44)]),
      "generalized",
    ),
    polity(
      "benelux",
      "Netherlands / Belgium / Luxembourg aggregate",
      "atlantic",
      rect(2, 49, 7, 54),
      "generalized",
    ),
    polity("poland", "Poland", "eastern", rect(14, 49, 24, 55), "generalized"),
    polity("ukraine", "Ukraine", "eastern", rect(22, 45, 40, 52), "generalized"),
    polity("belarus", "Belarus", "eastern", rect(23, 51, 33, 56), "generalized"),
    polity("russia", "Russia", "eastern", rect(30, 53, 45, 62), "generalized"),
    polity("turkey", "Turkey", "ottoman", rect(26, 36, 42, 42), "generalized"),
    polity("greece", "Greece", "southern", rect(20, 36, 27, 42), "generalized"),
    polity(
      "nordic-states",
      "Nordic States aggregate",
      "nordic",
      multi([rect(5, 57, 24, 66), rect(20, 59, 32, 70)]),
      "generalized",
    ),
    polity(
      "balkan-states",
      "Balkan States aggregate",
      "southern",
      rect(14, 41, 25, 47),
      "generalized",
    ),
  ]),
];

export function formatDemoHistoricalPolityYear(year: number) {
  return `${Math.round(year)} AD`;
}

export function getDemoHistoricalPolityFrame(
  year: number,
): TemporalGeoJsonGeometryFeatureCollection<DemoHistoricalPolityProperties> {
  return getDemoHistoricalPolityFrameWithPlanCache(year);
}

export function getDemoHistoricalPolityFrameWithPlanCache(
  year: number,
  planCache?: Map<string, GeoJsonTransitionPlan<DemoHistoricalPolityProperties>>,
): TemporalGeoJsonGeometryFeatureCollection<DemoHistoricalPolityProperties> {
  const clampedYear = clamp(
    year,
    demoHistoricalPolityScenes[0]!.year,
    demoHistoricalPolityScenes.at(-1)!.year,
  );
  const exactScene = demoHistoricalPolityScenes.find((scene) => scene.year === clampedYear);

  if (exactScene) {
    return exactScene.collection;
  }

  return getInterpolatedDemoHistoricalPolityFrame(clampedYear, planCache);
}

export function getDemoHistoricalPolityPlaybackFrame(
  year: number,
): TemporalGeoJsonGeometryFeatureCollection<DemoHistoricalPolityProperties> {
  const clampedYear = clamp(
    year,
    demoHistoricalPolityScenes[0]!.year,
    demoHistoricalPolityScenes.at(-1)!.year,
  );

  if (Number.isInteger(clampedYear)) {
    const cachedFrame = demoHistoricalPolityPlaybackFrameCache.get(clampedYear);

    if (cachedFrame) {
      return cachedFrame;
    }

    const frame = createDemoHistoricalPolityPlaybackFrame(clampedYear);

    demoHistoricalPolityPlaybackFrameCache.set(clampedYear, frame);

    return frame;
  }

  return createDemoHistoricalPolityPlaybackFrame(clampedYear);
}

function createDemoHistoricalPolityPlaybackFrame(
  clampedYear: number,
): TemporalGeoJsonGeometryFeatureCollection<DemoHistoricalPolityProperties> {
  if (clampedYear === demoHistoricalPolityScenes[0]!.year) {
    return withDemoHistoricalPolityDisplayOpacity(demoHistoricalPolityScenes[0]!.collection);
  }

  if (clampedYear === demoHistoricalPolityScenes.at(-1)!.year) {
    return withDemoHistoricalPolityDisplayOpacity(demoHistoricalPolityScenes.at(-1)!.collection);
  }

  return getDemoHistoricalPolityDisplayFrame(clampedYear);
}

export function isDemoHistoricalPolityVisibleFeature(feature: HistoricalPolityRenderableFeature) {
  return (feature.properties?.displayOpacity ?? 1) > historyVisibleOpacityThreshold;
}

export function getDemoHistoricalPolityRenderFeatureId(
  feature: HistoricalPolityRenderableFeature,
  _year: number,
) {
  const properties = feature.properties;

  return String(feature.id ?? properties?.polityId ?? properties?.label ?? "historical-polity");
}

function getDemoHistoricalPolityDisplayFrame(
  year: number,
): TemporalGeoJsonGeometryFeatureCollection<DemoHistoricalPolityProperties> {
  const nextSceneIndex = demoHistoricalPolityScenes.findIndex((scene) => scene.year > year);
  const previousScene = demoHistoricalPolityScenes[nextSceneIndex - 1]!;
  const nextScene = demoHistoricalPolityScenes[nextSceneIndex]!;
  const progress = (year - previousScene.year) / (nextScene.year - previousScene.year);
  const previousById = new Map(
    previousScene.collection.features.map((feature) => [feature.properties?.polityId, feature]),
  );
  const nextById = new Map(
    nextScene.collection.features.map((feature) => [feature.properties?.polityId, feature]),
  );
  const polityIds = getAllDemoHistoricalPolityIds();

  return {
    features: polityIds.map((polityId) => {
      const previousFeature = previousById.get(polityId);
      const nextFeature = nextById.get(polityId);
      const fallbackFeature = getAnyDemoHistoricalPolityFeature(polityId)!;

      if (previousFeature && nextFeature) {
        return createDemoHistoricalPolityDisplayFeature(
          nextFeature,
          interpolateDemoHistoricalPolityGeometry(previousFeature, nextFeature, progress),
          1,
        );
      }

      if (previousFeature) {
        const lineageTargetFeature = getDemoHistoricalPolityLineageFeature(
          previousFeature.properties?.lineage?.exitsTo,
          nextById,
        );

        return createDemoHistoricalPolityDisplayFeature(
          previousFeature,
          lineageTargetFeature
            ? interpolateDemoHistoricalPolityGeometry(
                previousFeature,
                lineageTargetFeature,
                progress,
              )
            : previousFeature.geometry,
          1 - progress,
        );
      }

      if (nextFeature) {
        const lineageSourceFeature = getDemoHistoricalPolityLineageFeature(
          nextFeature.properties?.lineage?.entersFrom,
          previousById,
        );

        return createDemoHistoricalPolityDisplayFeature(
          nextFeature,
          lineageSourceFeature
            ? interpolateDemoHistoricalPolityGeometry(lineageSourceFeature, nextFeature, progress)
            : nextFeature.geometry,
          progress,
        );
      }

      return createDemoHistoricalPolityDisplayFeature(fallbackFeature, fallbackFeature.geometry, 0);
    }),
    type: "FeatureCollection",
  };
}

function getDemoHistoricalPolityLineageFeature(
  polityIds: readonly string[] | undefined,
  featuresById: Map<
    string | undefined,
    TemporalGeoJsonGeometryFeature<DemoHistoricalPolityProperties>
  >,
) {
  for (const polityId of polityIds ?? []) {
    const feature = featuresById.get(polityId);

    if (feature) {
      return feature;
    }
  }

  return null;
}

function interpolateDemoHistoricalPolityGeometry(
  previousFeature: TemporalGeoJsonGeometryFeature<DemoHistoricalPolityProperties>,
  nextFeature: TemporalGeoJsonGeometryFeature<DemoHistoricalPolityProperties>,
  progress: number,
) {
  const previousGeometry = previousFeature.geometry;
  const nextGeometry = nextFeature.geometry;

  if (!previousGeometry || !nextGeometry) {
    return nextGeometry ?? previousGeometry;
  }

  return (
    interpolateTemporalGeoJsonGeometry(previousGeometry, nextGeometry, progress, {
      fallback: "hold",
      minResampleCoordinates: 24,
      partMatchingStrategy: "auto",
      strategy: "vertex-union",
    }) ?? (progress < 0.5 ? previousGeometry : nextGeometry)
  );
}

function createDemoHistoricalPolityDisplayFeature(
  feature: TemporalGeoJsonGeometryFeature<DemoHistoricalPolityProperties>,
  geometry: TemporalGeoJsonGeometryFeature<DemoHistoricalPolityProperties>["geometry"],
  displayOpacity: number,
): TemporalGeoJsonGeometryFeature<DemoHistoricalPolityProperties> {
  return {
    geometry,
    id: feature.properties?.polityId ?? feature.id,
    properties: {
      ...feature.properties!,
      displayOpacity,
      sourceIds: undefined,
      sourcePartPath: undefined,
      targetIds: undefined,
      targetPartPath: undefined,
      transitionKind: undefined,
    },
    type: "Feature",
  };
}

function withDemoHistoricalPolityDisplayOpacity(
  collection: TemporalGeoJsonGeometryFeatureCollection<DemoHistoricalPolityProperties>,
): TemporalGeoJsonGeometryFeatureCollection<DemoHistoricalPolityProperties> {
  const featuresById = new Map(
    collection.features.map((feature) => [feature.properties?.polityId, feature]),
  );

  return {
    features: getAllDemoHistoricalPolityIds().map((polityId) => {
      const feature = featuresById.get(polityId) ?? getAnyDemoHistoricalPolityFeature(polityId)!;

      return createDemoHistoricalPolityDisplayFeature(
        feature,
        feature.geometry,
        featuresById.has(polityId) ? 1 : 0,
      );
    }),
    type: "FeatureCollection",
  };
}

function getAllDemoHistoricalPolityIds() {
  return [
    ...new Set(
      demoHistoricalPolityScenes.flatMap((scene) =>
        scene.collection.features.flatMap((feature) => feature.properties?.polityId ?? []),
      ),
    ),
  ];
}

function getAnyDemoHistoricalPolityFeature(polityId: string) {
  return (
    demoHistoricalPolityScenes
      .flatMap((scene) => scene.collection.features)
      .find((feature) => feature.properties?.polityId === polityId) ?? null
  );
}

function getInterpolatedDemoHistoricalPolityFrame(
  year: number,
  planCache?: Map<string, GeoJsonTransitionPlan<DemoHistoricalPolityProperties>>,
): TemporalGeoJsonGeometryFeatureCollection<DemoHistoricalPolityProperties> {
  const nextSceneIndex = demoHistoricalPolityScenes.findIndex((scene) => scene.year > year);
  const previousScene = demoHistoricalPolityScenes[nextSceneIndex - 1]!;
  const nextScene = demoHistoricalPolityScenes[nextSceneIndex]!;
  const progress = (year - previousScene.year) / (nextScene.year - previousScene.year);
  const plan = getDemoHistoricalPolityTransitionPlan(previousScene, nextScene, planCache);

  return interpolateGeoJsonTransitionPlan(plan, progress);
}

function getDemoHistoricalPolityTransitionPlan(
  previousScene: DemoHistoricalPolityScene,
  nextScene: DemoHistoricalPolityScene,
  planCache?: Map<string, GeoJsonTransitionPlan<DemoHistoricalPolityProperties>>,
) {
  const planKey = `${previousScene.year}-${nextScene.year}`;
  const cachedPlan = planCache?.get(planKey);

  if (cachedPlan) {
    return cachedPlan;
  }

  const plan = createGeoJsonTransitionPlan(previousScene.collection, nextScene.collection, {
    algorithm: "topology-plan",
    partMatchingStrategy: "auto",
    topologyStrategy: "voronoi-partition",
  });

  planCache?.set(planKey, plan);

  return plan;
}

function prepareDemoHistoricalPolityScenes(
  scenes: DemoHistoricalPolityScene[],
): DemoHistoricalPolityScene[] {
  return scenes.map((inputScene) => ({
    ...inputScene,
    collection: {
      features: inputScene.collection.features.map((feature) => ({
        ...feature,
        geometry: conditionDemoHistoricalPolityGeometry(feature.geometry),
        properties: {
          ...feature.properties!,
          conditioned: true,
          lineage: getDemoHistoricalPolityLineage(feature.properties!.polityId),
        },
      })),
      type: "FeatureCollection",
    },
  }));
}

function getDemoHistoricalPolityLineage(polityId: string): DemoHistoricalPolityLineage {
  return (
    demoHistoricalPolityLineage[polityId] ?? {
      entersFrom: [polityId],
      exitsTo: [polityId],
      morphGroup: polityId,
    }
  );
}

const demoHistoricalPolityLineage: Record<string, DemoHistoricalPolityLineage> = {
  "al-andalus": {
    entersFrom: ["emirate-cordoba"],
    exitsTo: ["castile", "aragon", "portugal"],
    morphGroup: "iberia",
  },
  "anglo-saxon-kingdoms": {
    entersFrom: ["anglo-saxon-kingdoms"],
    exitsTo: ["england"],
    morphGroup: "britain",
  },
  aragon: {
    entersFrom: ["christian-iberian-kingdoms", "al-andalus"],
    exitsTo: ["spain"],
    morphGroup: "iberia",
  },
  "austrian-empire": {
    entersFrom: ["habsburg-monarchy"],
    exitsTo: ["austrian-empire"],
    morphGroup: "danube",
  },
  benelux: {
    entersFrom: ["netherlands", "dutch-republic"],
    exitsTo: ["benelux"],
    morphGroup: "low-countries",
  },
  "byzantine-empire": {
    entersFrom: ["byzantine-empire"],
    exitsTo: ["byzantine-empire", "ottoman-empire"],
    morphGroup: "eastern-mediterranean",
  },
  "carolingian-empire": {
    entersFrom: ["carolingian-empire"],
    exitsTo: ["france", "holy-roman-empire"],
    morphGroup: "carolingian-successors",
  },
  castile: {
    entersFrom: ["christian-iberian-kingdoms", "al-andalus"],
    exitsTo: ["spain"],
    morphGroup: "iberia",
  },
  "christian-iberian-kingdoms": {
    entersFrom: ["kingdom-asturias"],
    exitsTo: ["castile", "aragon", "portugal"],
    morphGroup: "iberia",
  },
  "denmark-norway": {
    entersFrom: ["denmark", "norway"],
    exitsTo: ["denmark", "sweden-norway"],
    morphGroup: "nordic-unions",
  },
  "emirate-cordoba": {
    entersFrom: ["emirate-cordoba"],
    exitsTo: ["al-andalus", "christian-iberian-kingdoms"],
    morphGroup: "iberia",
  },
  england: {
    entersFrom: ["anglo-saxon-kingdoms"],
    exitsTo: ["angevin-lands", "england-scotland", "united-kingdom"],
    morphGroup: "britain",
  },
  "england-scotland": {
    entersFrom: ["england"],
    exitsTo: ["united-kingdom"],
    morphGroup: "britain",
  },
  france: {
    entersFrom: ["carolingian-empire", "france"],
    exitsTo: ["france"],
    morphGroup: "france",
  },
  "german-confederation": {
    entersFrom: ["holy-roman-empire"],
    exitsTo: ["germany", "prussia", "austrian-empire"],
    morphGroup: "central-europe",
  },
  germany: {
    entersFrom: ["german-confederation", "prussia"],
    exitsTo: ["germany"],
    morphGroup: "central-europe",
  },
  "habsburg-monarchy": {
    entersFrom: ["hungary", "holy-roman-empire"],
    exitsTo: ["austrian-empire"],
    morphGroup: "danube",
  },
  "holy-roman-empire": {
    entersFrom: ["carolingian-empire", "holy-roman-empire"],
    exitsTo: ["german-confederation", "habsburg-monarchy"],
    morphGroup: "central-europe",
  },
  "kingdom-asturias": {
    entersFrom: ["kingdom-asturias"],
    exitsTo: ["christian-iberian-kingdoms"],
    morphGroup: "iberia",
  },
  "kievan-rus": {
    entersFrom: ["kievan-rus"],
    exitsTo: ["rus-principalities"],
    morphGroup: "rus",
  },
  "nordic-states": {
    entersFrom: ["sweden-norway", "denmark", "sweden"],
    exitsTo: ["nordic-states"],
    morphGroup: "nordic",
  },
  "norse-realms": {
    entersFrom: ["norse-realms"],
    exitsTo: ["denmark", "norway", "sweden"],
    morphGroup: "nordic",
  },
  "ottoman-empire": {
    entersFrom: ["byzantine-empire", "ottoman-empire"],
    exitsTo: ["turkey", "balkan-states", "greece"],
    morphGroup: "ottoman-successors",
  },
  "poland-lithuania": {
    entersFrom: ["poland"],
    exitsTo: ["polish-lithuanian-commonwealth", "poland", "ukraine", "belarus"],
    morphGroup: "poland-lithuania",
  },
  "polish-lithuanian-commonwealth": {
    entersFrom: ["poland-lithuania"],
    exitsTo: ["poland", "ukraine", "belarus", "russian-empire"],
    morphGroup: "poland-lithuania",
  },
  prussia: {
    entersFrom: ["german-confederation"],
    exitsTo: ["germany"],
    morphGroup: "central-europe",
  },
  russia: {
    entersFrom: ["muscovy", "russian-empire"],
    exitsTo: ["russian-empire", "russia"],
    morphGroup: "russia",
  },
  "russian-empire": {
    entersFrom: ["russia", "polish-lithuanian-commonwealth"],
    exitsTo: ["russia", "ukraine", "belarus", "poland"],
    morphGroup: "russia",
  },
  "rus-principalities": {
    entersFrom: ["kievan-rus"],
    exitsTo: ["muscovy", "poland-lithuania"],
    morphGroup: "rus",
  },
  "second-bulgarian-empire": {
    entersFrom: ["first-bulgarian-empire"],
    exitsTo: ["ottoman-empire", "balkan-states"],
    morphGroup: "balkans",
  },
  "sweden-norway": {
    entersFrom: ["sweden", "norway"],
    exitsTo: ["nordic-states"],
    morphGroup: "nordic",
  },
  "united-kingdom": {
    entersFrom: ["england", "england-scotland"],
    exitsTo: ["united-kingdom"],
    morphGroup: "britain",
  },
};

export const demoHistoricalPolityScenes: DemoHistoricalPolityScene[] =
  prepareDemoHistoricalPolityScenes(rawDemoHistoricalPolityScenes);

export function validateDemoHistoricalPolityScenes(
  scenes: readonly DemoHistoricalPolityScene[] = demoHistoricalPolityScenes,
): DemoHistoricalPolitySceneValidationIssue[] {
  return scenes.flatMap((scene) =>
    scene.collection.features.flatMap((feature) => {
      const polityId = feature.properties?.polityId ?? String(feature.id ?? "historical-polity");
      const sceneYear = feature.properties?.sceneYear ?? scene.year;
      const issues: DemoHistoricalPolitySceneValidationIssue[] = [];

      if (!feature.properties?.lineage && feature.properties?.conditioned) {
        issues.push({
          code: "missing-lineage",
          message: "Historical Polity Scenes must include explicit lineage metadata.",
          polityId,
          sceneYear,
        });
      }

      if (feature.geometry?.type === "Polygon") {
        issues.push(
          ...validateDemoHistoricalPolityPolygon(feature.geometry.coordinates, polityId, sceneYear),
        );

        return issues;
      }

      if (feature.geometry?.type === "MultiPolygon") {
        issues.push(
          ...feature.geometry.coordinates.flatMap((polygon) =>
            validateDemoHistoricalPolityPolygon(polygon, polityId, sceneYear),
          ),
        );

        return issues;
      }

      issues.push({
        code: "invalid-geometry",
        message: "Historical Polity Scenes must use Polygon or MultiPolygon geometries.",
        polityId,
        sceneYear,
      });

      return issues;
    }),
  );
}

function conditionDemoHistoricalPolityGeometry(
  geometry: TemporalGeoJsonGeometryFeature<DemoHistoricalPolityProperties>["geometry"],
): TemporalGeoJsonGeometryFeature<DemoHistoricalPolityProperties>["geometry"] {
  if (!geometry) {
    return geometry;
  }

  if (geometry.type === "Polygon") {
    return {
      coordinates: conditionDemoHistoricalPolityPolygon(geometry.coordinates),
      type: "Polygon",
    };
  }

  if (geometry.type === "MultiPolygon") {
    return {
      coordinates: geometry.coordinates.map(conditionDemoHistoricalPolityPolygon),
      type: "MultiPolygon",
    };
  }

  return geometry;
}

function validateDemoHistoricalPolityPolygon(
  polygon: readonly (readonly (readonly number[])[])[],
  polityId: string,
  sceneYear: number,
): DemoHistoricalPolitySceneValidationIssue[] {
  return polygon.flatMap((ring) => validateDemoHistoricalPolityRing(ring, polityId, sceneYear));
}

function validateDemoHistoricalPolityRing(
  ring: readonly (readonly number[])[],
  polityId: string,
  sceneYear: number,
): DemoHistoricalPolitySceneValidationIssue[] {
  const issues: DemoHistoricalPolitySceneValidationIssue[] = [];
  const first = ring[0];
  const last = ring.at(-1);

  if (ring.length < historyMinimumRingCoordinateCount) {
    issues.push({
      code: "undetailed-ring",
      message: "Historical Polity polygon rings must use at least 24 coordinates.",
      polityId,
      sceneYear,
    });
  }

  if (!first || !last || first[0] !== last[0] || first[1] !== last[1]) {
    issues.push({
      code: "unclosed-ring",
      message: "Historical Polity polygon rings must be closed.",
      polityId,
      sceneYear,
    });
  }

  return issues;
}

function conditionDemoHistoricalPolityPolygon(
  polygon: readonly (readonly (readonly number[])[])[],
) {
  return polygon.map((ring, ringIndex) =>
    conditionDemoHistoricalPolityRing(
      ring.map((position) => [Number(position[0]), Number(position[1])] as [number, number]),
      ringIndex === 0,
    ),
  );
}

function conditionDemoHistoricalPolityRing(ring: readonly [number, number][], isShell: boolean) {
  const finiteRing = ring.filter(
    (position) => Number.isFinite(position[0]) && Number.isFinite(position[1]),
  );
  const openRing = removeClosingDemoHistoricalPolityPosition(finiteRing);
  const detailedRing = resampleDemoHistoricalPolityOpenRing(
    openRing,
    Math.max(historyMinimumRingCoordinateCount - 1, openRing.length),
  );
  const closedRing = closeDemoHistoricalPolityRing(detailedRing);
  const shouldReverse = isShell
    ? getDemoHistoricalPolityRingArea(closedRing) < 0
    : getDemoHistoricalPolityRingArea(closedRing) > 0;

  return shouldReverse ? [...closedRing].reverse() : closedRing;
}

function resampleDemoHistoricalPolityOpenRing(ring: readonly [number, number][], count: number) {
  if (ring.length < 3) {
    return ring.map(cloneDemoHistoricalPolityPosition);
  }

  const closedRing = closeDemoHistoricalPolityRing(ring);
  const segmentLengths = closedRing.slice(0, -1).map((position, index) => {
    const nextPosition = closedRing[index + 1]!;

    return Math.hypot(nextPosition[0] - position[0], nextPosition[1] - position[1]);
  });
  const perimeter = segmentLengths.reduce((sum, length) => sum + length, 0);

  if (perimeter <= 0) {
    return ring.map(cloneDemoHistoricalPolityPosition);
  }

  return Array.from({ length: count }, (_, sampleIndex) => {
    const targetDistance = (perimeter * sampleIndex) / count;
    let elapsedDistance = 0;

    for (let segmentIndex = 0; segmentIndex < segmentLengths.length; segmentIndex += 1) {
      const segmentLength = segmentLengths[segmentIndex]!;

      if (elapsedDistance + segmentLength >= targetDistance) {
        const start = closedRing[segmentIndex]!;
        const end = closedRing[segmentIndex + 1]!;
        const ratio = segmentLength === 0 ? 0 : (targetDistance - elapsedDistance) / segmentLength;

        return [start[0] + (end[0] - start[0]) * ratio, start[1] + (end[1] - start[1]) * ratio] as [
          number,
          number,
        ];
      }

      elapsedDistance += segmentLength;
    }

    return cloneDemoHistoricalPolityPosition(closedRing.at(-2)!);
  });
}

function closeDemoHistoricalPolityRing(ring: readonly [number, number][]) {
  if (ring.length === 0) {
    return [];
  }

  const openRing = removeClosingDemoHistoricalPolityPosition(ring);
  const first = openRing[0]!;

  return [
    ...openRing.map(cloneDemoHistoricalPolityPosition),
    cloneDemoHistoricalPolityPosition(first),
  ];
}

function removeClosingDemoHistoricalPolityPosition(ring: readonly [number, number][]) {
  if (ring.length >= 2 && sameDemoHistoricalPolityPosition(ring[0]!, ring.at(-1)!)) {
    return ring.slice(0, -1);
  }

  return [...ring];
}

function sameDemoHistoricalPolityPosition(left: [number, number], right: [number, number]) {
  return left[0] === right[0] && left[1] === right[1];
}

function cloneDemoHistoricalPolityPosition(position: [number, number]) {
  return [position[0], position[1]] as [number, number];
}

function getDemoHistoricalPolityRingArea(ring: readonly [number, number][]) {
  return (
    ring.slice(0, -1).reduce((sum, position, index) => {
      const nextPosition = ring[index + 1]!;

      return sum + position[0] * nextPosition[1] - nextPosition[0] * position[1];
    }, 0) / 2
  );
}

function scene(year: number, polities: HistoricalPolityInput[]): DemoHistoricalPolityScene {
  return {
    collection: {
      features: polities.map((item) => ({
        geometry: item.geometry,
        id: item.polityId,
        properties: {
          kind: "historical-polity",
          label: item.label,
          note: item.note,
          polityId: item.polityId,
          precision: item.precision ?? "approximate",
          region: item.region,
          sceneYear: year,
        },
        type: "Feature",
      })),
      type: "FeatureCollection",
    },
    label: formatDemoHistoricalPolityYear(year),
    year,
  };
}

function polity(
  polityId: string,
  label: string,
  region: DemoHistoricalPolityRegion,
  geometry: TemporalGeoJsonSupportedGeometry,
  precision?: DemoHistoricalPolityPrecision,
  note?: string,
): HistoricalPolityInput {
  return { geometry, label, note, polityId, precision, region };
}

function rect(
  west: number,
  south: number,
  east: number,
  north: number,
): Extract<TemporalGeoJsonSupportedGeometry, { type: "Polygon" }> {
  const width = east - west;
  const height = north - south;

  return {
    coordinates: [
      [
        [west, south + height * 0.15],
        [west + width * 0.22, south],
        [west + width * 0.42, south + height * 0.1],
        [west + width * 0.66, south + height * 0.02],
        [east, south + height * 0.18],
        [east - width * 0.18, south + height * 0.34],
        [east - width * 0.03, south + height * 0.5],
        [east - width * 0.16, south + height * 0.72],
        [east - width * 0.06, north],
        [west + width * 0.7, north - height * 0.16],
        [west + width * 0.52, north - height * 0.06],
        [west + width * 0.25, north - height * 0.13],
        [west, north - height * 0.05],
        [west + width * 0.15, south + height * 0.7],
        [west + width * 0.04, south + height * 0.52],
        [west + width * 0.12, south + height * 0.3],
        [west, south + height * 0.15],
      ],
    ],
    type: "Polygon",
  };
}

function multi(
  polygons: Array<Extract<TemporalGeoJsonSupportedGeometry, { type: "Polygon" }>>,
): Extract<TemporalGeoJsonSupportedGeometry, { type: "MultiPolygon" }> {
  return {
    coordinates: polygons.map((polygon) => polygon.coordinates),
    type: "MultiPolygon",
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}
