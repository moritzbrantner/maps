import { useCallback, useMemo, useRef, useState, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { GeoJsonLayer, type GeoJsonLayerProps } from "../../src/geojson-layer";
import { MapsOverlayLayers, type MapsOverlayLayersController } from "../../src/maps-overlay-layers";

declare global {
  interface Window {
    mapsRetentionWork: { projected: number; styled: number };
  }
}
window.mapsRetentionWork = { projected: 0, styled: 0 };
const data: GeoJsonLayerProps["featureCollection"] = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      id: "route",
      properties: {},
      geometry: {
        type: "LineString",
        coordinates: Array.from({ length: 10000 }, (_, i) => [
          (120 * i) / 9999,
          30 + 20 * Math.sin((2 * Math.PI * i) / 9999),
        ]),
      },
    },
  ],
};
const style = () => {
  window.mapsRetentionWork.styled++;
  return { lineColor: "#2563eb", lineWidth: 5 };
};
const getViewport = () => null;
const unproject = () => null;
function Acceptance() {
  const [hovered, setHovered] = useState(false);
  const [selected, setSelected] = useState(false);
  const [offset, setOffset] = useState(0);
  const [visible, setVisible] = useState(true);
  const controller = useRef<MapsOverlayLayersController>(null);
  const project = useCallback(
    ([longitude, latitude]: [number, number]) => {
      window.mapsRetentionWork.projected++;
      return { x: 30 + longitude * 5 + offset, y: 310 - latitude * 5 };
    },
    [offset],
  );
  const surface = useMemo<ComponentProps<typeof MapsOverlayLayers>["surface"]>(
    () => ({
      handleFeatureHover: (feature) => setHovered(feature != null),
      handleFeatureClick: (feature) => setSelected(feature != null),
      handleFeatureContextMenu: () => {},
      isFeatureHovered: () => hovered,
      isFeatureSelected: () => selected,
      setViewState: () => {},
    }),
    [hovered, selected],
  );
  return (
    <main>
      <h1>Retained GeoJSON geometry</h1>
      <p>
        10,000 coordinates. Pointer interaction changes highlighting without rebuilding the route.
      </p>
      <div
        className="surface"
        data-testid="surface"
        onPointerMove={(event) =>
          controller.current?.handleHoverAtClientPoint(event.clientX, event.clientY)
        }
        onPointerLeave={() => controller.current?.clearHover()}
        onClick={(event) =>
          controller.current?.handleClickAtClientPoint(event.clientX, event.clientY)
        }
      >
        <MapsOverlayLayers
          ref={controller}
          surface={surface}
          project={project}
          getViewport={getViewport}
          unproject={unproject}
        >
          {visible && <GeoJsonLayer featureCollection={data} getFeatureStyle={style} />}
        </MapsOverlayLayers>
      </div>
      <output data-testid="interaction">
        Hovered: {String(hovered)}; selected: {String(selected)}
      </output>
      <button onClick={() => setOffset((value) => value + 25)}>Pan camera</button>
      <button onClick={() => setVisible((value) => !value)}>
        {visible ? "Remove layer" : "Restore layer"}
      </button>
      <p>
        Geometry and screen positions are retained; camera and data changes still invalidate their
        respective work.
      </p>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Acceptance />);
