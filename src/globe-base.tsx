"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { feature } from "topojson-client";
import worldTopology from "world-atlas/countries-50m.json";

import {
  createGlobeGraticuleLines,
  createVisibleSvgPath,
  getGlobeRadius,
  getGlobeSphereRotation,
  GLOBE_VIEWBOX_HEIGHT,
  GLOBE_VIEWBOX_WIDTH,
  type GlobeViewState,
} from "./map-display";

type GeoJsonPosition = [longitude: number, latitude: number];
type GeoJsonPolygon = {
  coordinates: GeoJsonPosition[][];
  type: "Polygon";
};
type GeoJsonMultiPolygon = {
  coordinates: GeoJsonPosition[][][];
  type: "MultiPolygon";
};
type GeoJsonCountryFeature = {
  geometry: GeoJsonMultiPolygon | GeoJsonPolygon | null;
  type: "Feature";
};
type GeoJsonFeatureCollection = {
  features: GeoJsonCountryFeature[];
  type: "FeatureCollection";
};

const TEXTURE_HEIGHT = 1024;
const TEXTURE_WIDTH = 2048;

export function GlobeBase({ viewState }: { viewState: GlobeViewState }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewStateRef = useRef(viewState);

  viewStateRef.current = viewState;

  useEffect(() => {
    const container = containerRef.current;

    if (!container) {
      return;
    }

    if (typeof WebGLRenderingContext === "undefined") {
      return;
    }

    let animationFrame = 0;
    let renderer: THREE.WebGLRenderer;

    try {
      renderer = new THREE.WebGLRenderer({
        alpha: true,
        antialias: true,
        powerPreference: "high-performance",
      });
    } catch {
      return;
    }

    renderer.setClearAlpha(0);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.domElement.className = "mb-maps__globe-canvas";
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(
      -GLOBE_VIEWBOX_WIDTH / 2,
      GLOBE_VIEWBOX_WIDTH / 2,
      GLOBE_VIEWBOX_HEIGHT / 2,
      -GLOBE_VIEWBOX_HEIGHT / 2,
      0.1,
      2000,
    );

    camera.position.set(0, 0, 1000);
    camera.lookAt(0, 0, 0);

    const texture = new THREE.CanvasTexture(createGlobeMapTextureCanvas());
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = renderer.capabilities.getMaxAnisotropy();

    const sphere = new THREE.Mesh(
      new THREE.SphereGeometry(1, 128, 96),
      new THREE.MeshStandardMaterial({
        map: texture,
        metalness: 0,
        roughness: 0.72,
      }),
    );

    scene.add(sphere);
    scene.add(new THREE.AmbientLight(0xffffff, 1.9));

    const keyLight = new THREE.DirectionalLight(0xffffff, 1.45);
    keyLight.position.set(-280, 320, 700);
    scene.add(keyLight);

    const rimLight = new THREE.DirectionalLight(0x8bd3ff, 0.9);
    rimLight.position.set(500, -180, 420);
    scene.add(rimLight);

    const resize = () => {
      const rect = container.getBoundingClientRect();
      const width = Math.max(1, rect.width);
      const height = Math.max(1, rect.height);
      const aspect = width / height;
      const viewBoxAspect = GLOBE_VIEWBOX_WIDTH / GLOBE_VIEWBOX_HEIGHT;
      let frustumWidth = GLOBE_VIEWBOX_WIDTH;
      let frustumHeight = GLOBE_VIEWBOX_HEIGHT;

      if (aspect > viewBoxAspect) {
        frustumWidth = GLOBE_VIEWBOX_HEIGHT * aspect;
      } else {
        frustumHeight = GLOBE_VIEWBOX_WIDTH / aspect;
      }

      camera.left = -frustumWidth / 2;
      camera.right = frustumWidth / 2;
      camera.top = frustumHeight / 2;
      camera.bottom = -frustumHeight / 2;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
    };

    const resizeObserver = new ResizeObserver(resize);

    resizeObserver.observe(container);
    resize();

    const render = () => {
      const current = viewStateRef.current;
      const radius = getGlobeRadius(current.zoom);

      camera.position.set(0, 0, radius + 1000);
      camera.near = 1;
      camera.far = radius * 2 + 2000;
      camera.updateProjectionMatrix();
      sphere.scale.setScalar(radius);
      const rotation = getGlobeSphereRotation(current);
      sphere.rotation.set(rotation.x, rotation.y, rotation.z);
      renderer.render(scene, camera);
      animationFrame = requestAnimationFrame(render);
    };

    render();

    return () => {
      cancelAnimationFrame(animationFrame);
      resizeObserver.disconnect();
      sphere.geometry.dispose();
      texture.dispose();
      (sphere.material as THREE.Material).dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);

  return <div aria-hidden="true" className="mb-maps__globe-renderer" ref={containerRef} />;
}

export function GlobeSvgOverlayBase({ viewState }: { viewState: GlobeViewState }) {
  const radius = getGlobeRadius(viewState.zoom);

  return (
    <>
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

export function createGlobeMapTextureCanvas() {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");

  canvas.width = TEXTURE_WIDTH;
  canvas.height = TEXTURE_HEIGHT;

  if (!context) {
    return canvas;
  }

  const ocean = context.createLinearGradient(0, 0, 0, TEXTURE_HEIGHT);

  ocean.addColorStop(0, "#dbeafe");
  ocean.addColorStop(0.52, "#38bdf8");
  ocean.addColorStop(1, "#0f766e");
  context.fillStyle = ocean;
  context.fillRect(0, 0, TEXTURE_WIDTH, TEXTURE_HEIGHT);
  drawLatitudeBands(context);

  const countries = feature(
    worldTopology,
    worldTopology.objects.countries,
  ) as unknown as GeoJsonFeatureCollection;
  const land = feature(worldTopology, worldTopology.objects.land) as unknown as GeoJsonFeatureCollection;

  context.fillStyle = "#64a874";
  context.strokeStyle = "rgba(21, 94, 117, 0.28)";
  context.lineWidth = 1.2;
  drawFeatureCollection(context, land, true);

  context.strokeStyle = "rgba(248, 250, 252, 0.42)";
  context.lineWidth = 0.62;
  drawFeatureCollection(context, countries, false);

  return canvas;
}

function drawLatitudeBands(context: CanvasRenderingContext2D) {
  context.save();

  for (let latitude = -60; latitude <= 60; latitude += 30) {
    const y = latitudeToTextureY(latitude);

    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(TEXTURE_WIDTH, y);
    context.strokeStyle = "rgba(255, 255, 255, 0.14)";
    context.lineWidth = latitude === 0 ? 2 : 1;
    context.stroke();
  }

  context.restore();
}

function drawFeatureCollection(
  context: CanvasRenderingContext2D,
  collection: GeoJsonFeatureCollection,
  fill: boolean,
) {
  for (const currentFeature of collection.features) {
    const geometry = currentFeature.geometry;

    if (!geometry) {
      continue;
    }

    if (geometry.type === "Polygon") {
      drawPolygon(context, geometry.coordinates, fill);
      continue;
    }

    for (const polygon of geometry.coordinates) {
      drawPolygon(context, polygon, fill);
    }
  }
}

function drawPolygon(context: CanvasRenderingContext2D, rings: GeoJsonPosition[][], fill: boolean) {
  context.beginPath();

  for (const ring of rings) {
    if (ring.length === 0) {
      continue;
    }

    const [first, ...rest] = ring;

    context.moveTo(longitudeToTextureX(first[0]), latitudeToTextureY(first[1]));

    for (const coordinate of rest) {
      context.lineTo(longitudeToTextureX(coordinate[0]), latitudeToTextureY(coordinate[1]));
    }

    context.closePath();
  }

  if (fill) {
    context.fill();
  }

  context.stroke();
}

function longitudeToTextureX(longitude: number) {
  return ((longitude + 180) / 360) * TEXTURE_WIDTH;
}

function latitudeToTextureY(latitude: number) {
  return ((90 - latitude) / 180) * TEXTURE_HEIGHT;
}
