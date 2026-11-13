import { useState } from "react";
import { Button } from "@moritzbrantner/ui";
import {
  BeeLineMeasurementLayer,
  FlowLayer,
  GeoJsonLayer,
  HeatLayer,
  MapControls,
  MapView,
  PointLayer,
  type MapBeeLineMeasurement,
  type MapBeeLineMeasurementDraft,
  type MapSurfaceController,
  type MapViewState,
} from "../src";

const POINTS = [
  { id: "berlin", longitude: 13.405, latitude: 52.52, label: "Berlin", metrics: { demand: 8 } },
  { id: "east", longitude: 13.8, latitude: 52.5, label: "East", metrics: { demand: 4 } },
];
const INITIAL: MapViewState = { center: [13.405, 52.52], zoom: 8, bearing: 35, pitch: 0 };

/** A controlled consumer: the application retains completed measurements and save policy. */
export function MapsMeasurementRuntimeAcceptance() {
  const [measurements, setMeasurements] = useState<MapBeeLineMeasurement[]>([]);
  const [draft, setDraft] = useState<MapBeeLineMeasurementDraft | null>(null);
  const [measuring, setMeasuring] = useState(true);
  const [controller, setController] = useState<MapSurfaceController | null>(null);
  const [view, setView] = useState(INITIAL);
  const [selected, setSelected] = useState<string | null>(null);
  const [saved, setSaved] = useState("");
  return (
    <main style={{ padding: 16 }}>
      <MapView
        flatRuntime="maps"
        fitToData={false}
        initialViewState={INITIAL}
        mapStyle={{ tiles: false }}
        mapLabel="Controlled measurement Map View"
        onMapControllerReady={setController}
        onViewStateChange={setView}
        style={{ height: "80vh" }}
      >
        <HeatLayer points={POINTS} weightMetric="demand" />
        <GeoJsonLayer
          featureCollection={{
            type: "FeatureCollection",
            features: [
              {
                type: "Feature",
                id: "region",
                properties: {},
                geometry: {
                  type: "Polygon",
                  coordinates: [
                    [
                      [13.1, 52.35],
                      [13.65, 52.35],
                      [13.65, 52.65],
                      [13.1, 52.65],
                      [13.1, 52.35],
                    ],
                  ],
                },
              },
            ],
          }}
        />
        <FlowLayer flows={[{ id: "connection", from: [13.25, 52.4], to: [13.75, 52.6] }]} />
        <PointLayer
          points={POINTS}
          onFeatureSelect={(point) => setSelected(point?.point.id ?? null)}
        />
        <BeeLineMeasurementLayer
          measurementMode={measuring ? "bee-line" : "none"}
          measurements={measurements}
          measurementDistanceFormat="meters"
          onMeasurementDraftChange={setDraft}
          onMeasurementCreate={(result) =>
            setMeasurements((current) => [
              ...current,
              { id: `measurement-${current.length + 1}`, from: result.from, to: result.to },
            ])
          }
          onMeasurementSelect={(measurement) => setSelected(measurement?.id ?? null)}
        />
        <MapControls aria-label="Measurement controls">
          <Button onClick={() => setMeasuring((current) => !current)}>
            {measuring ? "Navigate map" : "Measure distance"}
          </Button>
          <Button
            onClick={() => controller?.setViewState({ ...controller.getViewState(), pitch: 25 })}
          >
            Tilt map
          </Button>
          <Button
            onClick={() => controller?.setViewState({ ...controller.getViewState(), pitch: 0 })}
          >
            Reset tilt
          </Button>
          <Button onClick={() => setMeasurements([])}>Clear measurements</Button>
          <Button onClick={() => setSaved(JSON.stringify(measurements))}>Save measurements</Button>
        </MapControls>
      </MapView>
      <output aria-label="Measurement draft">
        {draft ? (draft.formattedDistance ?? "Choose endpoint") : "No draft"}
      </output>
      <output aria-label="Completed measurements">{JSON.stringify(measurements)}</output>
      <output aria-label="Selected map item">{selected ?? "none"}</output>
      <output aria-label="Saved measurements">{saved}</output>
      <output aria-label="Measurement camera">
        {JSON.stringify({
          center: view.center,
          zoom: view.zoom,
          bearing: view.bearing ?? 0,
          pitch: view.pitch ?? 0,
        })}
      </output>
    </main>
  );
}
