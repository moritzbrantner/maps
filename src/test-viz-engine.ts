type Dataset = {
  kind: string;
  [key: string]: unknown;
};

type Layer = {
  datasetId: string;
  kind: string;
  [key: string]: unknown;
};

let nextEngineId = 0;

export function createVizEngine() {
  const engineId = nextEngineId++;
  let nextDatasetId = 0;
  let nextLayerId = 0;
  const datasets = new Map<string, Dataset>();
  const layers = new Map<string, Layer>();

  return {
    addDataset(dataset: Dataset) {
      const id = `test-dataset-${engineId}-${nextDatasetId++}`;
      datasets.set(id, dataset);
      return id;
    },
    removeDataset(datasetId: string) {
      datasets.delete(datasetId);
    },
    addLayer(layer: Layer) {
      const id = `test-layer-${engineId}-${nextLayerId++}`;
      layers.set(id, layer);
      return id;
    },
    removeLayer(layerId: string) {
      layers.delete(layerId);
    },
    computeFrame({ viewport }: { viewport: unknown }) {
      return {
        layers: [],
        metadata: {
          generatedAt: 0,
        },
        stats: {
          backend: "js",
          backendImplementation: "js",
          datasetCount: datasets.size,
          durationMs: 0,
          layerCount: layers.size,
        },
        viewport,
      };
    },
  };
}
