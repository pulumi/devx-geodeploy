import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import ThreeGlobe from "three-globe";
import { theme } from "./theme";
import { endpointFor, pointColor } from "./pointColor";
import { createStyledGlobeMaterial } from "./globeShader";
import { createSkybox } from "./skyboxShader";
import { createDitheredLabelSprite, disposeLabelSprite, positionLabelAboveSurface } from "./labelSprite";
import type { ApplyRecord, DeploymentPlan, MonitorRecord, RegionPlan } from "./types";

export interface GlobeProps {
  plan: DeploymentPlan | null;
  apply: ApplyRecord | null;
  monitor: MonitorRecord | null;
  selectedGeoId: string | null;
  onSelect: (geoId: string) => void;
}

interface GlobePoint {
  geoId: string;
  kind: "demand" | "deployment";
  lat: number;
  lng: number;
  color: string;
  altitude: number;
  radius: number;
}

interface GlobeArc {
  geoId: string;
  startLat: number;
  startLng: number;
  endLat: number;
  endLng: number;
  color: string;
}

// Any Object3D mesh three-globe creates for a data-bound layer (points, arcs,
// ...) gets the source datum attached directly as `.__data` (see
// ThreeDigest/DataBindMapper in three-globe's source — not part of its public
// .d.ts, but a stable internal convention). Vanilla three-globe (unlike the
// react-globe.gl wrapper) ships no onPointClick/onHover helpers at all, so we
// raycast against the scene ourselves and read this property back off
// whatever mesh we hit.
interface ThreeObjWithData extends THREE.Object3D {
  __data?: unknown;
  __globeObjType?: string;
}

// Kept essentially flush with the surface (not 0 exactly, to avoid z-fighting
// against the globe/bump geometry). Confirmed live: a non-trivial altitude
// (this used to be 0.012-0.02) makes a raised point marker visually
// parallax-shift away from its true lat/lng at any non-nadir camera angle —
// reported as "off a bit on latitude and longitude" for real, correct
// coordinates. The "selected" state is now distinguished by color/radius
// only, never altitude, so selecting a point can't reintroduce this.
const POINT_ALTITUDE = 0.001;

function regionToPoints(
  region: RegionPlan,
  apply: ApplyRecord | null,
  planRequestId: string,
  selectedGeoId: string | null,
): GlobePoint[] {
  const selected = region.geoId === selectedGeoId;
  return [
    {
      geoId: region.geoId,
      kind: "demand",
      lat: region.demandCentroid.lat,
      lng: region.demandCentroid.lon, // three-globe uses `lng`, plan data uses `lon`
      color: selected ? theme.color.selectionHighlight : theme.color.demandBlue,
      altitude: POINT_ALTITUDE,
      radius: selected ? 1.1 : 0.8,
    },
    {
      geoId: region.geoId,
      kind: "deployment",
      lat: region.centroid.lat,
      lng: region.centroid.lon,
      color: selected ? theme.color.selectionHighlight : pointColor(region, apply, planRequestId),
      altitude: POINT_ALTITUDE,
      radius: selected ? 1.1 : 0.8,
    },
  ];
}

function regionToArc(region: RegionPlan, selectedGeoId: string | null): GlobeArc {
  const selected = region.geoId === selectedGeoId;
  return {
    geoId: region.geoId,
    startLat: region.demandCentroid.lat,
    startLng: region.demandCentroid.lon,
    endLat: region.centroid.lat,
    endLng: region.centroid.lon,
    color: selected ? theme.color.selectionHighlight : theme.color.accent,
  };
}

export function Globe({ plan, apply, monitor, selectedGeoId, onSelect }: GlobeProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const globeRef = useRef<ThreeGlobe | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const labelSpritesRef = useRef<THREE.Sprite[]>([]);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  // Mount: build the scene/camera/renderer/controls/globe exactly once.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const width = container.clientWidth || 800;
    const height = container.clientHeight || 600;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(theme.color.bg);

    const camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 2000);
    camera.position.set(0, 0, 320);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setClearColor(new THREE.Color(theme.color.bg), 1);
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(width, height);
    container.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.minDistance = 150;
    controls.maxDistance = 800;

    scene.add(new THREE.AmbientLight(0xffffff, 1.4));
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.6);
    dirLight.position.set(1, 1, 1);
    scene.add(dirLight);

    // False-color (magenta/yellow/lavender) dithered space backdrop, styled
    // to match the globe rather than a realistic starfield — see
    // skyboxShader.ts. Added as a scene sibling, never a child of `globe`,
    // so it's invisible to the click-to-select raycasting below (which only
    // ever calls `intersectObject(globe, true)`).
    const skybox = createSkybox();
    scene.add(skybox);

    const globe = new ThreeGlobe()
      // Stylized purple/orange dithered material (see globeShader.ts) in
      // place of three-globe's default globeImageUrl/bumpImageUrl material
      // pipeline. It still reads the same bundled, real-geography NASA
      // night-lights image (example/img/earth-night.jpg, bundled with
      // three-globe's own npm package — zero-network, license-clean) as a
      // luminance mask, so continents/city-lights vs. ocean are still real
      // geography, just re-colored and dithered rather than photorealistic.
      .globeMaterial(createStyledGlobeMaterial("/textures/earth-night.jpg", "/textures/earth-water.png"))
      .showAtmosphere(true)
      .atmosphereColor(theme.color.accent)
      .atmosphereAltitude(0.15)
      .pointLat((d) => (d as GlobePoint).lat)
      .pointLng((d) => (d as GlobePoint).lng)
      .pointColor((d) => (d as GlobePoint).color)
      .pointAltitude((d) => (d as GlobePoint).altitude)
      .pointRadius((d) => (d as GlobePoint).radius)
      .arcStartLat((d) => (d as GlobeArc).startLat)
      .arcStartLng((d) => (d as GlobeArc).startLng)
      .arcEndLat((d) => (d as GlobeArc).endLat)
      .arcEndLng((d) => (d as GlobeArc).endLng)
      .arcColor((d: object) => (d as GlobeArc).color)
      .arcDashLength(0.4)
      .arcDashGap(0.15)
      .arcDashAnimateTime(2500)
      .arcStroke(0.4)
      .arcAltitudeAutoScale(0.35);

    // Verified directly against the decoded image (not assumed): the
    // bundled earth-night.jpg is a standard Greenwich-centered equirectangular
    // map (North America on the left third, Europe/Africa centered, Asia/
    // Australia on the right), exactly the convention three-globe's own
    // built-in `globeObj.rotation.y = -Math.PI/2` ("face prime meridian along
    // Z axis") is built to pair with. An earlier version of this file applied
    // a manual `map.offset.x = 0.5` UV shift on top of that, on the mistaken
    // assumption the bundled texture was dateline-centered — that shift is
    // what put US/DE/AU markers over the wrong part of the map. No manual
    // texture offset is needed; three-globe's default mapping is correct as
    // long as the image itself is standard-centered, which this one is.
    // This still applies verbatim now that the texture is loaded manually
    // inside globeShader.ts's `createStyledGlobeMaterial` rather than via
    // three-globe's `.globeImageUrl()`: `globeObj.rotation.y` is set once at
    // mesh-creation time, independent of whatever material is attached (see
    // globeShader.ts's doc comment), so swapping in the custom dithered
    // material via `.globeMaterial()` doesn't touch this mapping at all —
    // do not reintroduce a texture offset here.
    scene.add(globe);
    globeRef.current = globe;
    sceneRef.current = scene;
    cameraRef.current = camera;

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();

    function onClick(event: MouseEvent) {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObject(globe, true);
      for (const hit of hits) {
        const obj = hit.object as ThreeObjWithData;
        if (obj.__globeObjType === "point" && obj.__data) {
          const geoId = (obj.__data as GlobePoint).geoId;
          if (geoId) {
            onSelectRef.current(geoId);
            return;
          }
        }
      }
    }
    renderer.domElement.addEventListener("click", onClick);

    let frameId = 0;
    const animate = () => {
      frameId = requestAnimationFrame(animate);
      // Slow, independent ambient rotation — distinct from user-driven
      // OrbitControls camera movement — so the backdrop feels like it's
      // gently accompanying the scene rather than either chasing the camera
      // one-to-one or sitting perfectly inert.
      skybox.rotation.y += 0.00004;
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    const resizeObserver = new ResizeObserver(() => {
      const w = container.clientWidth;
      const h = container.clientHeight;
      if (w === 0 || h === 0) return;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    });
    resizeObserver.observe(container);

    return () => {
      cancelAnimationFrame(frameId);
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener("click", onClick);
      controls.dispose();
      skybox.geometry.dispose();
      (skybox.material as THREE.Material).dispose();
      for (const sprite of labelSpritesRef.current) {
        disposeLabelSprite(sprite);
      }
      labelSpritesRef.current = [];
      renderer.dispose();
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement);
      }
      globeRef.current = null;
      sceneRef.current = null;
      cameraRef.current = null;
    };
    // Intentionally runs once on mount; data updates are pushed via the
    // effect below, and onSelect changes flow through onSelectRef.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Data updates: recompute points/arcs/labels whenever the plan, apply
  // state, monitor (for CPU utilization), or selection changes, without
  // tearing down the scene.
  useEffect(() => {
    const globe = globeRef.current;
    if (!globe) return;
    const regions = plan?.regions ?? [];
    const planRequestId = plan?.requestId ?? "";
    const points: GlobePoint[] = regions.flatMap((region) =>
      regionToPoints(region, apply, planRequestId, selectedGeoId),
    );
    const arcs: GlobeArc[] = regions.map((region) => regionToArc(region, selectedGeoId));
    globe.pointsData(points);
    globe.arcsData(arcs);

    // Sprite creation now waits on web-font loading (see labelSprite.ts), so
    // this run can finish after a newer one has already started (e.g. a
    // fast SSE monitor update landing mid-flight) — `cancelled` drops a
    // stale run's results instead of undoing whatever the newer run already
    // applied.
    let cancelled = false;
    void (async () => {
      const utilByGeoId = new Map((monitor?.lastResize?.utilization.regions ?? []).map((u) => [u.geoId, u]));

      // Multiple demand geos can legitimately resolve to the exact same
      // deployment centroid (e.g. two regions both landing on the same
      // cheapest AWS region under the deterministic fallback, which never
      // considers geography) — their labels would otherwise render on top
      // of each other at the identical 3D position. Regions sharing a
      // (rounded) centroid get stacked at increasing altitude instead, so
      // every label stays readable without changing where anything's pin
      // actually sits.
      const centroidKey = (c: { lat: number; lon: number }) => `${c.lat.toFixed(2)},${c.lon.toFixed(2)}`;
      const stackIndexByGeoId = new Map<string, number>();
      const seenCounts = new Map<string, number>();
      for (const region of regions) {
        const key = centroidKey(region.centroid);
        const stackIndex = seenCounts.get(key) ?? 0;
        stackIndexByGeoId.set(region.geoId, stackIndex);
        seenCounts.set(key, stackIndex + 1);
      }

      const newSprites = await Promise.all(
        regions.map(async (region) => {
          const util = utilByGeoId.get(region.geoId);
          const selected = region.geoId === selectedGeoId;
          const subtitleLines: string[] = [];
          if (util && util.error === undefined) {
            subtitleLines.push(`${(util.cpuUtilPct * 100).toFixed(0)}% cpu`);
          }
          const endpoint = endpointFor(region, apply, planRequestId);
          if (endpoint) {
            // Canvas has no text-wrapping of its own (see labelSprite.ts) —
            // a real load-balancer hostname/IP is short enough to usually
            // fit as-is, but truncate defensively rather than let a rare
            // long one overflow the label's fixed width.
            subtitleLines.push(endpoint.length > 42 ? `${endpoint.slice(0, 39)}…` : endpoint);
          }
          const sprite = await createDitheredLabelSprite({
            title: region.geoId,
            subtitleLines,
            titleColor: selected ? theme.color.selectionHighlight : theme.color.labelText,
            subtitleColor: selected ? theme.color.selectionHighlight : theme.color.labelText,
            titleFontFamily: theme.font.display,
            subtitleFontFamily: theme.font.sans,
          });
          const stackIndex = stackIndexByGeoId.get(region.geoId) ?? 0;
          positionLabelAboveSurface(sprite, region.centroid.lat, region.centroid.lon, 0.08 + stackIndex * 0.12);
          return sprite;
        }),
      );
      if (cancelled) {
        for (const sprite of newSprites) disposeLabelSprite(sprite);
        return;
      }
      // Rebuilt wholesale (same pattern as pointsData/arcsData above) rather
      // than diffed in place — the region count is always small, and this
      // keeps label content (utilization numbers change on every monitor
      // poll) trivially always in sync with no separate create-vs-update
      // bookkeeping.
      for (const sprite of labelSpritesRef.current) {
        globe.remove(sprite);
        disposeLabelSprite(sprite);
      }
      for (const sprite of newSprites) globe.add(sprite);
      labelSpritesRef.current = newSprites;
    })();

    return () => {
      cancelled = true;
    };
  }, [plan, apply, monitor, selectedGeoId]);

  return <div ref={containerRef} style={{ width: "100%", height: "100%" }} />;
}
