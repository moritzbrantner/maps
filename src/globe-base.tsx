"use client";

import { useEffect, useMemo, useRef } from "react";
import { geoOrthographic, geoPath } from "d3-geo";
import type { GeoPermissibleObjects } from "d3-geo";
import * as THREE from "three";
import { feature, mesh } from "topojson-client";
import worldTopology from "world-atlas/countries-110m.json";

import {
  createGlobeGraticuleLines,
  createVisibleSvgPath,
  getGlobeRadius,
  getGlobeSphereRotation,
  GLOBE_VIEWBOX_HEIGHT,
  GLOBE_VIEWBOX_WIDTH,
  type GlobeViewState,
} from "./map-display";

const globeLand = feature(worldTopology, worldTopology.objects.land) as GeoPermissibleObjects;
const globeCountryBorders = mesh(
  worldTopology,
  worldTopology.objects.countries,
  (left, right) => left !== right,
) as GeoPermissibleObjects;

export type GlobeBasemapPaths = {
  countryBorderPath: string;
  landPath: string;
};

export function GlobeBase({ viewState }: { viewState: GlobeViewState }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const renderSchedulerRef = useRef<ReturnType<typeof createGlobeRenderScheduler> | null>(null);
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

    const material = new THREE.MeshStandardMaterial({
      color: 0x38bdf8,
      metalness: 0,
      roughness: 0.72,
    });
    const sphere = new THREE.Mesh(
      new THREE.SphereGeometry(1, 96, 64),
      material,
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
      renderSchedulerRef.current?.scheduleRender();
    };

    const resizeObserver = new ResizeObserver(resize);

    resizeObserver.observe(container);

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
    };

    const renderScheduler = createGlobeRenderScheduler(render);

    renderSchedulerRef.current = renderScheduler;
    resize();
    renderScheduler.scheduleRender();

    return () => {
      renderScheduler.cancel();
      renderSchedulerRef.current = null;
      resizeObserver.disconnect();
      sphere.geometry.dispose();
      material.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);

  useEffect(() => {
    viewStateRef.current = viewState;
    renderSchedulerRef.current?.scheduleRender();
  }, [viewState.center[0], viewState.center[1], viewState.zoom]);

  return <div aria-hidden="true" className="mb-maps__globe-renderer" ref={containerRef} />;
}

export function GlobeSvgOverlayBase({ viewState }: { viewState: GlobeViewState }) {
  const radius = getGlobeRadius(viewState.zoom);
  const basemapPaths = useMemo(
    () => createGlobeBasemapPaths(viewState),
    [viewState.center[0], viewState.center[1], viewState.zoom],
  );
  const graticulePaths = useMemo(
    () =>
      createGlobeGraticuleLines(viewState)
        .map(createVisibleSvgPath)
        .filter((path): path is string => Boolean(path)),
    [viewState.center[0], viewState.center[1], viewState.zoom],
  );

  return (
    <>
      <g className="mb-maps__globe-land">
        <path d={basemapPaths.landPath} />
      </g>
      <path className="mb-maps__globe-country-borders" d={basemapPaths.countryBorderPath} />
      <g className="mb-maps__globe-graticule">
        {graticulePaths.map((path, index) => (
          <path d={path} key={index} />
        ))}
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

export function createGlobeRenderScheduler(render: () => void) {
  let animationFrame = 0;

  return {
    cancel() {
      if (animationFrame) {
        cancelAnimationFrame(animationFrame);
        animationFrame = 0;
      }
    },
    scheduleRender() {
      if (animationFrame) {
        cancelAnimationFrame(animationFrame);
      }

      animationFrame = requestAnimationFrame(() => {
        animationFrame = 0;
        render();
      });
    },
  };
}

export function createGlobeBasemapPaths(viewState: GlobeViewState): GlobeBasemapPaths {
  const path = geoPath(createGlobeBasemapProjection(viewState));

  return {
    countryBorderPath: path(globeCountryBorders) ?? "",
    landPath: path(globeLand) ?? "",
  };
}

export function projectGlobeBasemapCoordinate(
  coordinate: [longitude: number, latitude: number],
  viewState: GlobeViewState,
) {
  return createGlobeBasemapProjection(viewState)(coordinate);
}

function createGlobeBasemapProjection(viewState: GlobeViewState) {
  return geoOrthographic()
    .scale(getGlobeRadius(viewState.zoom))
    .translate([GLOBE_VIEWBOX_WIDTH / 2, GLOBE_VIEWBOX_HEIGHT / 2])
    .rotate([-viewState.center[0], -viewState.center[1]])
    .clipAngle(90)
    .precision(0.25);
}
