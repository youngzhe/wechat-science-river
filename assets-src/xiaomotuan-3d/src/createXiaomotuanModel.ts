import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export type ProceduralModelOptions = {
  wireframe?: boolean;
  castShadow?: boolean;
  receiveShadow?: boolean;
  textureSize?: number;
  textureAnisotropy?: number;
  qualityPriority?: 'reference-fidelity' | 'balanced';
};

export type ProceduralModelRuntime = {
  nodes: Record<string, THREE.Object3D>;
  meshes: Record<string, THREE.Mesh>;
  sockets: Record<string, THREE.Object3D>;
  colliders: Record<string, unknown>;
  destructionGroups: Record<string, THREE.Object3D[]>;
};

type SculptMaterialSpec = Record<string, any>;

// bevelEnabled defaults to true on THREE.ExtrudeGeometry and rounds every
// corner — sharp/pointed profiles (blades, fork tines, spikes) need
// bevelEnabled: false plus lineTo()-only path segments near the tip, since a
// curve command cannot produce a true converging point.
function buildExtrudeShape(points: [number, number][], holes?: [number, number][][]): THREE.Shape {
  const shape = new THREE.Shape();
  if (points.length > 0) {
    shape.moveTo(points[0][0], points[0][1]);
    for (let i = 1; i < points.length; i += 1) {
      shape.lineTo(points[i][0], points[i][1]);
    }
  }
  // Cutouts (e.g. an oval wire-cutter hole) as THREE.Path added to shape.holes —
  // dep-free boolean subtraction via the tessellator, no CSG library needed.
  for (const loop of holes ?? []) {
    if (loop.length < 3) continue;
    const path = new THREE.Path();
    path.moveTo(loop[0][0], loop[0][1]);
    for (let i = 1; i < loop.length; i += 1) path.lineTo(loop[i][0], loop[i][1]);
    path.closePath();
    shape.holes.push(path);
  }
  return shape;
}

// Build an N-gon oval loop (for hole authoring from a compact {cx,cy,rx,ry} descriptor).
function ovalLoop(cx: number, cy: number, rx: number, ry: number, seg = 24): [number, number][] {
  const loop: [number, number][] = [];
  for (let i = 0; i < seg; i += 1) {
    const a = (i / seg) * Math.PI * 2;
    loop.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
  }
  return loop;
}

function buildExtrudeGeometry(profile: { points: [number, number][]; depth: number; holes?: [number, number][][]; ovalHoles?: { cx: number; cy: number; rx: number; ry: number }[] }): THREE.ExtrudeGeometry {
  const holes = [...(profile.holes ?? []), ...((profile.ovalHoles ?? []).map((o) => ovalLoop(o.cx, o.cy, o.rx, o.ry)))];
  const shape = buildExtrudeShape(profile.points, holes);
  return new THREE.ExtrudeGeometry(shape, {
    depth: profile.depth,
    bevelEnabled: false,
    steps: 1,
  });
}

type TaperedStation = { position: [number, number, number]; rx: number; rz: number; twist?: number };

// Frames come from PARALLEL TRANSPORT, not from a Frenet frame. A Frenet frame is defined by
// the curve's normal, which flips sign wherever the path has an inflection or straightens out,
// and every flip twists the surface 180 degrees within one segment. Carrying the previous frame
// forward and removing only its along-path component keeps the twist continuous. THREE's own
// extrudePath and TubeGeometry do not expose this, which is why this is hand-built.
function buildTaperedSweepGeometry(
  sweep: { stations: TaperedStation[]; radialSegments?: number; capEnds?: boolean },
): THREE.BufferGeometry {
  const stations = sweep.stations;
  if (stations.length < 2) throw new Error('tapered-sweep needs at least two stations');
  const radial = Math.max(3, sweep.radialSegments ?? 10);
  const centres = stations.map((s) => new THREE.Vector3(...s.position));

  const tangents = centres.map((_, i) => {
    const prev = centres[Math.max(0, i - 1)];
    const next = centres[Math.min(centres.length - 1, i + 1)];
    const t = next.clone().sub(prev);
    // Coincident neighbours would normalise to NaN and poison every downstream vertex.
    return t.lengthSq() < 1e-12 ? new THREE.Vector3(0, 1, 0) : t.normalize();
  });

  // Seed a reference axis that is not parallel to the first tangent, or the first cross
  // product is degenerate and the whole sweep collapses to a line.
  let ref = new THREE.Vector3(0, 0, 1);
  if (Math.abs(tangents[0].dot(ref)) > 0.9) ref = new THREE.Vector3(1, 0, 0);

  const normals: THREE.Vector3[] = [];
  const binormals: THREE.Vector3[] = [];
  let carried = ref.clone().sub(tangents[0].clone().multiplyScalar(ref.dot(tangents[0]))).normalize();
  for (let i = 0; i < tangents.length; i += 1) {
    const t = tangents[i];
    // Project the carried frame back onto the plane perpendicular to this tangent.
    const n = carried.clone().sub(t.clone().multiplyScalar(carried.dot(t)));
    if (n.lengthSq() < 1e-12) {
      const fallback = Math.abs(t.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
      n.copy(fallback.sub(t.clone().multiplyScalar(fallback.dot(t))));
    }
    n.normalize();
    normals.push(n);
    binormals.push(new THREE.Vector3().crossVectors(t, n).normalize());
    carried = n;
  }

  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const ringStart: number[] = [];
  const isPoint: boolean[] = [];

  for (let i = 0; i < stations.length; i += 1) {
    const st = stations[i];
    const v = i / (stations.length - 1);
    ringStart.push(positions.length / 3);
    // A station whose section has collapsed emits ONE vertex, not a ring of radius zero.
    // A degenerate ring still carries `radial` coincident vertices and `radial` zero-area
    // triangles, so the lock ends in a blunt cap the width of the floating-point noise
    // rather than at a point -- and a hair lock, a horn or a blade tip has to reach a point.
    if (st.rx <= 1e-6 && st.rz <= 1e-6) {
      isPoint.push(true);
      positions.push(centres[i].x, centres[i].y, centres[i].z);
      uvs.push(0.5, v);
      continue;
    }
    isPoint.push(false);
    const twist = ((st.twist ?? 0) * Math.PI) / 180;
    for (let j = 0; j <= radial; j += 1) {
      const theta = (j / radial) * Math.PI * 2 + twist;
      const offset = normals[i].clone().multiplyScalar(Math.cos(theta) * st.rx)
        .add(binormals[i].clone().multiplyScalar(Math.sin(theta) * st.rz));
      const p = centres[i].clone().add(offset);
      positions.push(p.x, p.y, p.z);
      uvs.push(j / radial, v);
    }
  }

  for (let i = 0; i < stations.length - 1; i += 1) {
    const a0 = ringStart[i];
    const b0 = ringStart[i + 1];
    if (isPoint[i] && isPoint[i + 1]) continue;   // two collapsed stations bound nothing
    for (let j = 0; j < radial; j += 1) {
      // Wound so the face normal points radially OUTWARD.
      //
      // Ring vertices advance from `normal` toward `binormal`, and binormal is
      // tangent x normal, so increasing theta runs counter-clockwise seen from the
      // far end of the segment. Taking the ring-to-ring edge first therefore puts
      // the cross product on the inside. Measured as signed volume on the built
      // mesh: every tapered-sweep came out negative -- a torso at -0.0674 and a
      // tail at -0.0044 against a positive ellipsoid head -- so every sweep this
      // generator has ever emitted rendered its back faces, with normals pointing
      // into the solid and every lighting judgement made on the wrong surface.
      if (isPoint[i]) indices.push(a0, b0 + j + 1, b0 + j);
      else if (isPoint[i + 1]) indices.push(a0 + j, a0 + j + 1, b0);
      else indices.push(a0 + j, a0 + j + 1, b0 + j, a0 + j + 1, b0 + j + 1, b0 + j);
    }
  }

  if (sweep.capEnds ?? true) {
    for (const end of [0, stations.length - 1]) {
      if (isPoint[end]) continue;   // a point end is already closed
      const centreIndex = positions.length / 3;
      positions.push(centres[end].x, centres[end].y, centres[end].z);
      uvs.push(0.5, end === 0 ? 0 : 1);
      const base = ringStart[end];
      for (let j = 0; j < radial; j += 1) {
        if (end === 0) indices.push(centreIndex, base + j + 1, base + j);
        else indices.push(centreIndex, base + j, base + j + 1);
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function readLayerNumber(value: unknown, keys: string[], fallback: number): number {
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of keys) {
      if (typeof record[key] === 'number') return record[key] as number;
    }
  }
  return fallback;
}

function hexToRgb(hex: string): [number, number, number] {
  const normalized = /^#[0-9a-f]{3}$/i.test(hex)
    ? '#' + hex.slice(1).split('').map((part) => part + part).join('')
    : hex;
  const value = /^#[0-9a-f]{6}$/i.test(normalized) ? Number.parseInt(normalized.slice(1), 16) : 0x8a7a5f;
  return [clampAlbedoChannel((value >> 16) & 255), clampAlbedoChannel((value >> 8) & 255), clampAlbedoChannel(value & 255)];
}

function materialPalette(spec: SculptMaterialSpec): string[] {
  const palette = spec.colorVariation?.palette;
  if (Array.isArray(palette) && palette.length > 0) return palette.filter((value) => typeof value === 'string');
  const secondary = spec.albedo?.secondary;
  const colors = [spec.baseColor ?? spec.color ?? spec.albedo?.dominant, ...(Array.isArray(secondary) ? secondary : [])];
  return colors.filter((value): value is string => typeof value === 'string' && value.startsWith('#'));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function clampAlbedoChannel(value: number): number {
  return Math.max(30, Math.min(240, Math.round(value)));
}

function clampPbrF0(value: number): number {
  return Math.max(0.02, Math.min(1, value));
}

function clampPbrIor(value: number): number {
  return Math.max(1, Math.min(2.5, value));
}

function clampPbrMetalness(value: number): number {
  return value >= 0.5 ? 1 : 0;
}

function clampedAlbedoColor(spec: SculptMaterialSpec): THREE.Color {
  const source = typeof spec.baseColor === 'string' ? spec.baseColor : '#8A7A5F';
  // setStyle with an explicit SRGBColorSpace, NOT the numeric constructor.
  //
  // `new THREE.Color(r, g, b)` treats its arguments as LINEAR working-space components,
  // while an authored `baseColor` hex is sRGB. Feeding one to the other skipped the
  // transfer function and lifted every dark albedo: #2e2a28, authored as a near-black
  // vinyl, rendered at roughly sRGB 0.46 — a mid grey. The error is largest exactly where
  // it matters most, because the transfer curve is steepest near black.
  return new THREE.Color().setStyle(source, THREE.SRGBColorSpace);
}

function smoothCurve(value: number): number {
  return value * value * (3 - 2 * value);
}

function periodicHash(x: number, y: number, seed: number, periodX: number, periodY: number): number {
  const wrappedX = ((x % periodX) + periodX) % periodX;
  const wrappedY = ((y % periodY) + periodY) % periodY;
  let value = Math.imul(wrappedX + seed * 17, 374761393) ^ Math.imul(wrappedY + seed * 31, 668265263);
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967295;
}

function periodicValueNoise(u: number, v: number, seed: number, periodX: number, periodY: number): number {
  const x = u * periodX;
  const y = v * periodY;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = smoothCurve(x - x0);
  const ty = smoothCurve(y - y0);
  const a = periodicHash(x0, y0, seed, periodX, periodY);
  const b = periodicHash(x0 + 1, y0, seed, periodX, periodY);
  const c = periodicHash(x0, y0 + 1, seed, periodX, periodY);
  const d = periodicHash(x0 + 1, y0 + 1, seed, periodX, periodY);
  return THREE.MathUtils.lerp(THREE.MathUtils.lerp(a, b, tx), THREE.MathUtils.lerp(c, d, tx), ty);
}

type SurfaceBand = {
  frequency: number;
  amplitude: number;
  stretchX: number;
  stretchY: number;
  ridge: boolean;
};

function surfaceBands(spec: SculptMaterialSpec): SurfaceBand[] {
  const source = Array.isArray(spec.surfaceFrequencyBands) ? spec.surfaceFrequencyBands : [];
  const parsed = source.flatMap((item: unknown) => {
    if (!item || typeof item !== 'object') return [];
    const band = item as Record<string, unknown>;
    const frequency = typeof band.frequency === 'number' ? band.frequency : 0;
    const amplitude = typeof band.amplitude === 'number' ? band.amplitude : 0;
    if (frequency <= 0 || amplitude <= 0) return [];
    const stretch = Array.isArray(band.stretch) ? band.stretch : [1, 1];
    const description = `${String(band.pattern ?? '')} ${String(band.role ?? '')}`.toLowerCase();
    return [{
      frequency,
      amplitude,
      stretchX: typeof stretch[0] === 'number' ? Math.max(0.1, stretch[0]) : 1,
      stretchY: typeof stretch[1] === 'number' ? Math.max(0.1, stretch[1]) : 1,
      ridge: /(ridge|groove|grain|fiber|striated|crack)/.test(description),
    }];
  });
  return parsed.length > 0 ? parsed : [
    { frequency: 2, amplitude: 0.42, stretchX: 1, stretchY: 1, ridge: false },
    { frequency: 12, amplitude: 0.22, stretchX: 1, stretchY: 1, ridge: false },
    { frequency: 56, amplitude: 0.08, stretchX: 1, stretchY: 1, ridge: false },
  ];
}

function sampleSurface(u: number, v: number, bands: SurfaceBand[], seed: number): number {
  let value = 0;
  let weight = 0;
  for (let index = 0; index < bands.length; index += 1) {
    const band = bands[index];
    const periodX = Math.max(1, Math.round(band.frequency * band.stretchX));
    const periodY = Math.max(1, Math.round(band.frequency * band.stretchY));
    let sample = periodicValueNoise(u, v, seed + index * 1013, periodX, periodY);
    if (band.ridge) sample = 1 - Math.abs(sample * 2 - 1);
    value += sample * band.amplitude;
    weight += band.amplitude;
  }
  return weight > 0 ? clamp01(value / weight) : 0.5;
}

function mixPalette(colors: [number, number, number][], value: number): [number, number, number] {
  if (colors.length === 1) return colors[0];
  const scaled = clamp01(value) * (colors.length - 1);
  const index = Math.min(colors.length - 2, Math.floor(scaled));
  const mix = scaled - index;
  const a = colors[index];
  const b = colors[index + 1];
  return [
    Math.round(THREE.MathUtils.lerp(a[0], b[0], mix)),
    Math.round(THREE.MathUtils.lerp(a[1], b[1], mix)),
    Math.round(THREE.MathUtils.lerp(a[2], b[2], mix)),
  ];
}

type ColorGradientStop = { offset: number; color: string };
type ColorGradientSpec = {
  type: 'linear' | 'radial';
  axis: [number, number];
  stops: ColorGradientStop[];
};

function parseRgba(value: string): [number, number, number] {
  const match = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(value);
  if (!match) return [138, 122, 95];
  return [clampAlbedoChannel(Number(match[1])), clampAlbedoChannel(Number(match[2])), clampAlbedoChannel(Number(match[3]))];
}

// Analytical per-pixel gradient sample. The extraction schema's colorGradient carries
// exact rgba(...) stop colors (see extract_part_color_recipe.py), so this samples the
// same trend directly in JS math rather than round-tripping through a Canvas 2D
// createLinearGradient/createRadialGradient object — same visual result, and it composes
// directly with the existing noise/height-correlated colorVariation blend below.
function sampleColorGradient(gradient: ColorGradientSpec, u: number, v: number): [number, number, number] {
  const stops = gradient.stops.length >= 2 ? gradient.stops : [{ offset: 0, color: 'rgba(138,122,95,1)' }, { offset: 1, color: 'rgba(138,122,95,1)' }];
  let t: number;
  if (gradient.type === 'radial') {
    const [cx, cy] = gradient.axis;
    const dx = u - cx;
    const dy = v - cy;
    const maxRadius = Math.max(0.001, Math.hypot(Math.max(cx, 1 - cx), Math.max(cy, 1 - cy)));
    t = clamp01(Math.hypot(dx, dy) / maxRadius);
  } else {
    const [ax, ay] = gradient.axis;
    const projection = (u - 0.5) * ax + (v - 0.5) * ay;
    const maxProjection = 0.5 * (Math.abs(ax) + Math.abs(ay)) || 0.5;
    t = clamp01(projection / maxProjection + 0.5);
  }
  const scaled = t * (stops.length - 1);
  const index = Math.min(stops.length - 2, Math.max(0, Math.floor(scaled)));
  const mix = scaled - index;
  const a = parseRgba(stops[index].color);
  const b = parseRgba(stops[index + 1].color);
  return [
    THREE.MathUtils.lerp(a[0], b[0], mix),
    THREE.MathUtils.lerp(a[1], b[1], mix),
    THREE.MathUtils.lerp(a[2], b[2], mix),
  ];
}

function writePixel(data: Uint8ClampedArray, offset: number, red: number, green: number, blue: number): void {
  data[offset] = Math.max(0, Math.min(255, Math.round(red)));
  data[offset + 1] = Math.max(0, Math.min(255, Math.round(green)));
  data[offset + 2] = Math.max(0, Math.min(255, Math.round(blue)));
  data[offset + 3] = 255;
}

function makeCanvas(size: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  return canvas;
}

function createMapTexture(
  canvas: HTMLCanvasElement,
  colorSpace: THREE.ColorSpace,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas);
  const projection = spec.textureProjection && typeof spec.textureProjection === 'object' ? spec.textureProjection : {};
  const repeat = Array.isArray(projection.repeat) ? projection.repeat : [2, 2];
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(
    typeof repeat[0] === 'number' ? repeat[0] : 2,
    typeof repeat[1] === 'number' ? repeat[1] : 2,
  );
  texture.anisotropy = Math.max(1, Math.round(options.textureAnisotropy ?? projection.anisotropy ?? 8));
  texture.needsUpdate = true;
  return texture;
}

type ProceduralTextureSet = {
  albedo: THREE.Texture;
  roughness: THREE.Texture;
  height: THREE.Texture;
  normal: THREE.Texture;
  ao: THREE.Texture;
  source: 'reference-pixel-extraction' | 'procedural';
};

function referenceMapUrl(spec: SculptMaterialSpec, channel: string): string | null {
  const reference = spec.referencePbr;
  if (!reference || typeof reference !== 'object') return null;
  if (reference.usable === false) return null;
  const confidence = typeof reference.confidence === 'number'
    ? reference.confidence
    : (typeof reference.estimatedFidelity === 'number' ? reference.estimatedFidelity : 0);
  const threshold = typeof reference.targetThreshold === 'number' ? reference.targetThreshold : 0.7;
  if (confidence < threshold) return null;
  const maps = reference.maps;
  if (!maps || typeof maps !== 'object') return null;
  const map = (maps as Record<string, unknown>)[channel];
  if (!map || typeof map !== 'object') return null;
  const record = map as Record<string, unknown>;
  const url = typeof record.url === 'string' && record.url.trim() ? record.url : record.path;
  return typeof url === 'string' && url.trim() ? url : null;
}

function createLoadedMapTexture(
  url: string,
  colorSpace: THREE.ColorSpace,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): THREE.Texture {
  const texture = new THREE.TextureLoader().load(url);
  const projection = spec.textureProjection && typeof spec.textureProjection === 'object' ? spec.textureProjection : {};
  const repeat = Array.isArray(projection.repeat) ? projection.repeat : [1, 1];
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(
    typeof repeat[0] === 'number' ? repeat[0] : 1,
    typeof repeat[1] === 'number' ? repeat[1] : 1,
  );
  texture.anisotropy = Math.max(1, Math.round(options.textureAnisotropy ?? projection.anisotropy ?? 8));
  texture.needsUpdate = true;
  return texture;
}

function makeReferenceTextureSet(spec: SculptMaterialSpec, options: ProceduralModelOptions): ProceduralTextureSet | null {
  const albedo = referenceMapUrl(spec, 'albedo');
  const roughness = referenceMapUrl(spec, 'roughness');
  const height = referenceMapUrl(spec, 'height');
  const normal = referenceMapUrl(spec, 'normal');
  const ao = referenceMapUrl(spec, 'ao');
  if (!albedo || !roughness || !height || !normal || !ao) return null;
  return {
    albedo: createLoadedMapTexture(albedo, THREE.SRGBColorSpace, spec, options),
    roughness: createLoadedMapTexture(roughness, THREE.NoColorSpace, spec, options),
    height: createLoadedMapTexture(height, THREE.NoColorSpace, spec, options),
    normal: createLoadedMapTexture(normal, THREE.NoColorSpace, spec, options),
    ao: createLoadedMapTexture(ao, THREE.NoColorSpace, spec, options),
    source: 'reference-pixel-extraction',
  };
}

function makeProceduralTextureSet(
  id: string,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): ProceduralTextureSet | null {
  if (typeof document === 'undefined') return null;
  const qualityFirst = (options.qualityPriority ?? 'reference-fidelity') === 'reference-fidelity';
  const requested = options.textureSize ?? spec.textureResolution;
  const requestedSize = typeof requested === 'number' && Number.isFinite(requested)
    ? requested
    : (qualityFirst ? 1024 : 512);
  const size = Math.max(256, Math.min(2048, 2 ** Math.round(Math.log2(requestedSize))));
  const canvases = {
    albedo: makeCanvas(size),
    roughness: makeCanvas(size),
    height: makeCanvas(size),
    normal: makeCanvas(size),
    ao: makeCanvas(size),
  };
  const contexts = {
    albedo: canvases.albedo.getContext('2d'),
    roughness: canvases.roughness.getContext('2d'),
    height: canvases.height.getContext('2d'),
    normal: canvases.normal.getContext('2d'),
    ao: canvases.ao.getContext('2d'),
  };
  if (!contexts.albedo || !contexts.roughness || !contexts.height || !contexts.normal || !contexts.ao) return null;
  const images = {
    albedo: contexts.albedo.createImageData(size, size),
    roughness: contexts.roughness.createImageData(size, size),
    height: contexts.height.createImageData(size, size),
    normal: contexts.normal.createImageData(size, size),
    ao: contexts.ao.createImageData(size, size),
  };
  const seed = hashString(id);
  const bands = surfaceBands(spec);
  const heightField = new Float32Array(size * size);
  const roughnessField = new Float32Array(size * size);
  const palette = materialPalette(spec);
  const fallback = typeof spec.baseColor === 'string' ? spec.baseColor : '#8A7A5F';
  const colors = (palette.length >= 2 ? palette : [fallback, '#6E614B', '#A08F70']).map(hexToRgb);
  const baseRoughness = clamp01(readLayerNumber(spec.roughness, ['base'], 0.76));
  const roughnessVariation = clamp01(readLayerNumber(spec.roughness, ['variation'], 0.18));
  const colorAmplitude = clamp01(readLayerNumber(spec.colorVariation, ['amplitude', 'variation'], 0.18));
  const heightCorrelation = clamp01(readLayerNumber(spec.colorVariation, ['heightCorrelation'], 0.3));
  const colorGradient: ColorGradientSpec | undefined = spec.colorGradient;
  for (let y = 0; y < size; y += 1) {
    const v = y / size;
    for (let x = 0; x < size; x += 1) {
      const u = x / size;
      const index = y * size + x;
      const height = sampleSurface(u, v, bands, seed + 101);
      const roughNoise = sampleSurface(u, v, bands, seed + 7001);
      const colorNoise = sampleSurface(u, v, bands, seed + 15013);
      heightField[index] = height;
      roughnessField[index] = clamp01(baseRoughness + (roughNoise - 0.5) * roughnessVariation * 2);
      let color: [number, number, number];
      if (colorGradient) {
        // Evidence-derived spatial gradient (Plan 1.3 Workstream C) takes priority
        // over the noise-based palette blend below — it is a measured trend, not a guess.
        color = sampleColorGradient(colorGradient, u, v);
      } else {
        const paletteValue = clamp01(
          0.5 + (colorNoise - 0.5) * colorAmplitude * 2 + (height - 0.5) * heightCorrelation
        );
        color = mixPalette(colors, paletteValue);
      }
      writePixel(images.albedo.data, index * 4, color[0], color[1], color[2]);
    }
  }
  const normalStrength = Math.max(0.05, readLayerNumber(spec.normal, ['strength', 'amplitude'], 0.35));
  const aoStrength = clamp01(readLayerNumber(spec.ambientOcclusion, ['cavityStrength', 'strength'], 0.35));
  for (let y = 0; y < size; y += 1) {
    const up = ((y - 1 + size) % size) * size;
    const down = ((y + 1) % size) * size;
    for (let x = 0; x < size; x += 1) {
      const left = (x - 1 + size) % size;
      const right = (x + 1) % size;
      const index = y * size + x;
      const center = heightField[index];
      const dx = (heightField[y * size + right] - heightField[y * size + left]) * normalStrength * 6;
      const dy = (heightField[down + x] - heightField[up + x]) * normalStrength * 6;
      const inverseLength = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const normalX = -dx * inverseLength;
      const normalY = -dy * inverseLength;
      const normalZ = inverseLength;
      const neighborAverage = (
        heightField[y * size + left] + heightField[y * size + right]
        + heightField[up + x] + heightField[down + x]
      ) * 0.25;
      const cavity = Math.max(0, neighborAverage - center);
      const ao = clamp01(1 - aoStrength * (cavity * 12 + (1 - center) * 0.16));
      const offset = index * 4;
      const heightByte = center * 255;
      const roughnessByte = roughnessField[index] * 255;
      writePixel(images.height.data, offset, heightByte, heightByte, heightByte);
      writePixel(images.roughness.data, offset, roughnessByte, roughnessByte, roughnessByte);
      writePixel(
        images.normal.data, offset,
        (normalX * 0.5 + 0.5) * 255,
        (normalY * 0.5 + 0.5) * 255,
        (normalZ * 0.5 + 0.5) * 255,
      );
      writePixel(images.ao.data, offset, ao * 255, ao * 255, ao * 255);
    }
  }
  contexts.albedo.putImageData(images.albedo, 0, 0);
  contexts.roughness.putImageData(images.roughness, 0, 0);
  contexts.height.putImageData(images.height, 0, 0);
  contexts.normal.putImageData(images.normal, 0, 0);
  contexts.ao.putImageData(images.ao, 0, 0);
  return {
    albedo: createMapTexture(canvases.albedo, THREE.SRGBColorSpace, spec, options),
    roughness: createMapTexture(canvases.roughness, THREE.NoColorSpace, spec, options),
    height: createMapTexture(canvases.height, THREE.NoColorSpace, spec, options),
    normal: createMapTexture(canvases.normal, THREE.NoColorSpace, spec, options),
    ao: createMapTexture(canvases.ao, THREE.NoColorSpace, spec, options),
    source: 'procedural',
  };
}

function createSculptMaterial(id: string, spec: SculptMaterialSpec, options: ProceduralModelOptions, denseComponent = false): THREE.MeshPhysicalMaterial {
  // A material that declares -- with evidence -- that its subject carries no texture
  // detail gets NO texture set. Synthesising one anyway is not a harmless default: the
  // branch below then forces color to white and roughness to 1 and reads both from the
  // generated maps, so the authored albedo and the reference-derived roughness are both
  // discarded, and the model gains mottling the reference does not have. Measured on the
  // tuxedo cat, whose black fur rendered as speckled grey-and-white from a palette that
  // only ever described two flat regions.
  const textureless = (spec.textureless as { declared?: boolean } | undefined)?.declared === true;
  const textures = textureless
    ? null
    : makeReferenceTextureSet(spec, options) ?? makeProceduralTextureSet(id, spec, options);
  const material = new THREE.MeshPhysicalMaterial({
    color: textures ? 0xffffff : clampedAlbedoColor(spec),
    roughness: textures ? 1 : clamp01(readLayerNumber(spec.roughness, ['base'], 0.76)),
    metalness: clampPbrMetalness(readLayerNumber(spec.metalness, ['base'], 0.0)),
    clearcoat: clamp01(readLayerNumber(spec.clearcoat, ['base', 'amount'], 0)),
    clearcoatRoughness: clamp01(readLayerNumber(spec.clearcoatRoughness, ['base'], 0.25)),
    transmission: clamp01(readLayerNumber(spec.transmission, ['base', 'amount'], 0)),
    ior: clampPbrIor(readLayerNumber(spec.ior, ['base', 'value'], 1.5)),
    thickness: Math.max(0, readLayerNumber(spec.thickness, ['base', 'amount'], 0)),
    attenuationDistance: Math.max(0.001, readLayerNumber(spec.attenuationDistance, ['base', 'value'], Infinity)),
    attenuationColor: new THREE.Color(typeof spec.attenuationColor === 'string' ? spec.attenuationColor : '#ffffff'),
    sheen: clamp01(readLayerNumber(spec.sheen, ['base', 'amount'], 0)),
    sheenColor: new THREE.Color(typeof spec.sheenColor === 'string' ? spec.sheenColor : '#ffffff'),
    sheenRoughness: clamp01(readLayerNumber(spec.sheenRoughness, ['base'], 1.0)),
    iridescence: clamp01(readLayerNumber(spec.iridescence, ['base', 'amount'], 0)),
    iridescenceIOR: clampPbrIor(readLayerNumber(spec.iridescenceIOR, ['base', 'value'], 1.3)),
    anisotropy: clamp01(readLayerNumber(spec.anisotropy, ['base', 'amount'], 0)),
    anisotropyRotation: readLayerNumber(spec.anisotropy, ['rotation'], 0),
    specularIntensity: clampPbrF0(readLayerNumber(spec.specularF0 ?? spec.f0 ?? spec.specularIntensity, ['base', 'value'], 1.0)),
    specularColor: new THREE.Color(typeof spec.specularColor === 'string' ? spec.specularColor : '#ffffff'),
    emissive: new THREE.Color(typeof spec.emissive === 'string' ? spec.emissive : '#000000'),
    emissiveIntensity: Math.max(0, readLayerNumber(spec.emissiveIntensity, ['base'], 1.0)),
    opacity: clamp01(readLayerNumber(spec.opacity, ['base'], 1)),
    transparent: readLayerNumber(spec.transmission, ['base', 'amount'], 0) > 0 || readLayerNumber(spec.opacity, ['base'], 1) < 1,
    alphaTest: Math.max(0, readLayerNumber(spec.alpha, ['cutoff', 'alphaTest'], 0)),
    wireframe: options.wireframe ?? false,
    side: spec.doubleSided === true ? THREE.DoubleSide : THREE.FrontSide,
    flatShading: spec.flatShading === true,
  });
  if (textures) {
    material.map = textures.albedo;
    material.roughnessMap = textures.roughness;
    material.normalMap = textures.normal;
    material.normalScale.setScalar(Math.max(0.05, readLayerNumber(spec.normal, ['strength', 'amplitude'], 0.35)));
    material.aoMap = textures.ao;
    material.aoMap.channel = 0;
    material.aoMapIntensity = readLayerNumber(spec.ambientOcclusion, ['cavityStrength', 'strength'], 0.35);
    const denseMesh = denseComponent || spec.denseMesh === true || spec.geometryDensity === 'dense' || spec.topologyClass === 'dense';
    const bumpScale = Math.max(0, readLayerNumber(spec.bump, ['amplitude', 'strength'], 0));
    const effectiveBumpScale = denseMesh ? Math.max(0.05, bumpScale) : bumpScale;
    if (effectiveBumpScale > 0) {
      material.bumpMap = textures.height;
      material.bumpScale = effectiveBumpScale;
    }
    const displacementScale = Math.max(0, readLayerNumber(spec.displacement, ['amplitude', 'strength'], 0));
    const effectiveDisplacementScale = denseMesh ? Math.max(0.005, displacementScale) : displacementScale;
    if (effectiveDisplacementScale > 0) {
      material.displacementMap = textures.height;
      material.displacementScale = effectiveDisplacementScale;
      material.displacementBias = -effectiveDisplacementScale * 0.5;
    }
  }
  material.envMapIntensity = readLayerNumber(spec, ['envMapIntensity'], 0.8);
  material.userData.sculptMaterial = spec;
  material.userData.proceduralMapsIndependent = true;
  material.userData.pbrConstraints = { albedoRange: [30, 240], binaryMetalness: true, f0Range: [0.02, 1], iorRange: [1, 2.5] };
  material.userData.pbrTextureSource = textures?.source ?? 'flat-fallback';
  material.userData.referencePbr = spec.referencePbr ?? null;
  material.userData.referenceMaterialId = spec.referenceMaterialId ?? spec.materialReference?.profileId ?? null;
  material.userData.materialEvidence = spec.materialEvidence ?? null;
  material.userData.validationViews = spec.materialReference?.validationViews ?? [];
  material.needsUpdate = true;
  return material;
}

type AttachmentEndpoint = {
  start: THREE.Vector3;
  midpoint: THREE.Vector3;
  quaternion: THREE.Quaternion;
  length: number;
  baseRadius: number;
  endRadius: number;
};

function readVector3(value: unknown, fallback: [number, number, number]): THREE.Vector3 {
  if (Array.isArray(value) && value.length === 3 && value.every((item) => typeof item === 'number')) {
    return new THREE.Vector3(value[0], value[1], value[2]);
  }
  return new THREE.Vector3(fallback[0], fallback[1], fallback[2]);
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function makeAttachmentEndpoint(attachment: unknown): AttachmentEndpoint | null {
  if (!attachment || typeof attachment !== 'object') return null;
  const record = attachment as Record<string, unknown>;
  const start = readVector3(record.localStart, [0, 0, 0]);
  const end = readVector3(record.localEnd, [0, 1, 0]);
  const delta = end.clone().sub(start);
  const length = delta.length();
  if (length <= 0.0001) return null;
  const direction = delta.clone().normalize();
  const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
  const baseRadius = Math.max(0.005, readNumber(record.baseRadius, 0.06));
  const endRadius = Math.max(0.003, readNumber(record.endRadius, baseRadius * 0.55));
  return {
    start,
    midpoint: delta.multiplyScalar(0.5),
    quaternion,
    length,
    baseRadius,
    endRadius,
  };
}

// Generated from ObjectSculptSpec target: Xiaomotuan IP
// Sculpt build pass: blockout
// This factory is intentionally pass-gated. Finish browser screenshot review before unlocking deeper passes.
export function createXiaomotuanIPModel(options: ProceduralModelOptions = {}): THREE.Group {
  const root = new THREE.Group();
  root.name = "Xiaomotuan IP";
  root.userData.reconstructionEvidence = {"itemFamily": null, "subtype": null, "componentAdapter": null, "route": null, "exactnessTier": null, "referenceCamera": {"solved": false, "fovDegrees": 40.0, "aspect": 1.0, "orientation": {"yaw": 0.0, "pitch": 0.0, "roll": 0.0}, "positionHint": [0.0, 0.0, 3.0], "note": "For likeness work, solve the reference camera (forge/stage1_intake/solve_camera_pose.py) so the review render aligns with the photo and the reference can be projected. Confirm by overlay review."}, "approximationNotes": []};
  root.userData.materialPipeline = {};
  root.userData.materialReferenceRegistry = null;

  const materialMap: Record<string, THREE.Material> = {};
  materialMap["body-charcoal"] = createSculptMaterial(
    "body-charcoal",
    {"id": "body-charcoal", "name": "Warm charcoal-brown plush body with gentle brightness lift", "type": "standard", "shaderModel": "MeshStandardMaterial / stylized IP PBR", "baseColor": "#493B33", "color": "#493B33", "albedo": {"dominant": "#493B33", "secondary": ["#745A47"], "samplingNotes": "Stylized authored palette; source illustration lighting is not treated as measured albedo."}, "colorVariation": {"palette": ["#493B33", "#745A47"], "pattern": "soft broad mottling", "amplitude": 0.1, "heightCorrelation": 0.15}, "textureResolution": 256, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.42, "role": "broad color and height breakup"}, {"id": "meso", "frequency": 12.0, "amplitude": 0.22, "role": "ridges, pores, grain, dents, or equivalent visible relief"}, {"id": "micro", "frequency": 56.0, "amplitude": 0.08, "role": "highlight breakup visible under grazing light"}], "roughness": {"base": 0.78, "variation": 0.08, "map": "independent subtle procedural field", "localResponse": "soft broad variation; keep cute forms readable"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "subtle broad painterly texture only", "strength": 0.12, "scale": 10.0, "space": "tangent"}, "bump": {"pattern": "subtle broad tactile variation", "amplitude": 0.01, "scale": 8.0}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.18, "contactShadowBias": 0.2, "notes": "Keep face and scarf folds soft; avoid muddy cavities."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#241B17"}, "localOverrides": [{"id": "warm-cheek-mottle", "region": "broad cheek and torso patches", "albedo": "rgba(116, 90, 71, 1.0)", "roughness": 0.76, "notes": "Low-amplitude warm mottling; avoid noisy pores."}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Preserve the original cute near-charcoal palette, lifted only slightly toward warm cocoa brown; keep teal scarf clearly distinct."},
    options
  );
  materialMap["scarf-teal"] = createSculptMaterial(
    "scarf-teal",
    {"id": "scarf-teal", "name": "High-contrast vivid teal scarf", "type": "standard", "shaderModel": "MeshStandardMaterial / stylized IP PBR", "baseColor": "#25BFA7", "color": "#25BFA7", "albedo": {"dominant": "#25BFA7", "secondary": ["#75E1CE"], "samplingNotes": "Stylized authored palette; source illustration lighting is not treated as measured albedo."}, "colorVariation": {"palette": ["#25BFA7", "#75E1CE"], "pattern": "subtle fabric variation", "amplitude": 0.06, "heightCorrelation": 0.15}, "textureResolution": 256, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.42, "role": "broad color and height breakup"}, {"id": "meso", "frequency": 12.0, "amplitude": 0.22, "role": "ridges, pores, grain, dents, or equivalent visible relief"}, {"id": "micro", "frequency": 56.0, "amplitude": 0.08, "role": "highlight breakup visible under grazing light"}], "roughness": {"base": 0.6, "variation": 0.08, "map": "independent subtle procedural field", "localResponse": "soft broad variation; keep cute forms readable"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "subtle broad painterly texture only", "strength": 0.12, "scale": 10.0, "space": "tangent"}, "bump": {"pattern": "subtle broad tactile variation", "amplitude": 0.01, "scale": 8.0}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.18, "contactShadowBias": 0.2, "notes": "Keep face and scarf folds soft; avoid muddy cavities."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#241B17"}, "localOverrides": [{"id": "bright-scarf-folds", "region": "raised scarf folds", "albedo": "rgba(117, 225, 206, 1.0)", "roughness": 0.67, "notes": "Lighter fold crests preserve strong contrast with body."}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Stylized and relightable; does not claim physical material recovery from the illustration."},
    options
  );
  materialMap["scarf-shadow"] = createSculptMaterial(
    "scarf-shadow",
    {"id": "scarf-shadow", "name": "Deep teal scarf folds", "type": "standard", "shaderModel": "MeshStandardMaterial / stylized IP PBR", "baseColor": "#117D70", "color": "#117D70", "albedo": {"dominant": "#117D70", "secondary": ["#2EA995"], "samplingNotes": "Stylized authored palette; source illustration lighting is not treated as measured albedo."}, "colorVariation": {"palette": ["#117D70", "#2EA995"], "pattern": "subtle fabric variation", "amplitude": 0.06, "heightCorrelation": 0.15}, "textureResolution": 256, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.42, "role": "broad color and height breakup"}, {"id": "meso", "frequency": 12.0, "amplitude": 0.22, "role": "ridges, pores, grain, dents, or equivalent visible relief"}, {"id": "micro", "frequency": 56.0, "amplitude": 0.08, "role": "highlight breakup visible under grazing light"}], "roughness": {"base": 0.68, "variation": 0.08, "map": "independent subtle procedural field", "localResponse": "soft broad variation; keep cute forms readable"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "subtle broad painterly texture only", "strength": 0.08, "scale": 10.0, "space": "tangent"}, "bump": {"pattern": "subtle broad tactile variation", "amplitude": 0.01, "scale": 8.0}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.18, "contactShadowBias": 0.2, "notes": "Keep face and scarf folds soft; avoid muddy cavities."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#241B17"}, "localOverrides": [], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Stylized and relightable; does not claim physical material recovery from the illustration."},
    options
  );
  materialMap["eye-sclera"] = createSculptMaterial(
    "eye-sclera",
    {"id": "eye-sclera", "name": "Cream sclera", "type": "standard", "shaderModel": "MeshStandardMaterial / stylized IP PBR", "baseColor": "#FFF0D7", "color": "#FFF0D7", "albedo": {"dominant": "#FFF0D7", "secondary": ["#F5DDB6"], "samplingNotes": "Stylized authored palette; source illustration lighting is not treated as measured albedo."}, "colorVariation": {"palette": ["#FFF0D7", "#F5DDB6"], "pattern": "flat", "amplitude": 0.06, "heightCorrelation": 0.15}, "textureResolution": 256, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.42, "role": "broad color and height breakup"}, {"id": "meso", "frequency": 12.0, "amplitude": 0.22, "role": "ridges, pores, grain, dents, or equivalent visible relief"}, {"id": "micro", "frequency": 56.0, "amplitude": 0.08, "role": "highlight breakup visible under grazing light"}], "roughness": {"base": 0.3, "variation": 0.025, "map": "independent subtle procedural field", "localResponse": "soft broad variation; keep cute forms readable"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "smooth", "strength": 0.04, "scale": 10.0, "space": "tangent"}, "bump": {"pattern": "none", "amplitude": 0.0, "scale": 8.0}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.18, "contactShadowBias": 0.2, "notes": "Keep face and scarf folds soft; avoid muddy cavities."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#241B17"}, "localOverrides": [], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Stylized and relightable; does not claim physical material recovery from the illustration.", "clearcoat": 0.32},
    options
  );
  materialMap["eye-amber"] = createSculptMaterial(
    "eye-amber",
    {"id": "eye-amber", "name": "Amber iris", "type": "standard", "shaderModel": "MeshStandardMaterial / stylized IP PBR", "baseColor": "#E98723", "color": "#E98723", "albedo": {"dominant": "#E98723", "secondary": ["#FFC24E"], "samplingNotes": "Stylized authored palette; source illustration lighting is not treated as measured albedo."}, "colorVariation": {"palette": ["#E98723", "#FFC24E"], "pattern": "flat", "amplitude": 0.06, "heightCorrelation": 0.15}, "textureResolution": 256, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.42, "role": "broad color and height breakup"}, {"id": "meso", "frequency": 12.0, "amplitude": 0.22, "role": "ridges, pores, grain, dents, or equivalent visible relief"}, {"id": "micro", "frequency": 56.0, "amplitude": 0.08, "role": "highlight breakup visible under grazing light"}], "roughness": {"base": 0.18, "variation": 0.025, "map": "independent subtle procedural field", "localResponse": "soft broad variation; keep cute forms readable"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "smooth", "strength": 0.02, "scale": 10.0, "space": "tangent"}, "bump": {"pattern": "none", "amplitude": 0.0, "scale": 8.0}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.18, "contactShadowBias": 0.2, "notes": "Keep face and scarf folds soft; avoid muddy cavities."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#241B17"}, "localOverrides": [], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Stylized and relightable; does not claim physical material recovery from the illustration.", "clearcoat": 0.32},
    options
  );
  materialMap["eye-pupil"] = createSculptMaterial(
    "eye-pupil",
    {"id": "eye-pupil", "name": "Deep warm pupil", "type": "standard", "shaderModel": "MeshStandardMaterial / stylized IP PBR", "baseColor": "#28150F", "color": "#28150F", "albedo": {"dominant": "#28150F", "secondary": ["#4A2A1C"], "samplingNotes": "Stylized authored palette; source illustration lighting is not treated as measured albedo."}, "colorVariation": {"palette": ["#28150F", "#4A2A1C"], "pattern": "flat", "amplitude": 0.06, "heightCorrelation": 0.15}, "textureResolution": 256, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.42, "role": "broad color and height breakup"}, {"id": "meso", "frequency": 12.0, "amplitude": 0.22, "role": "ridges, pores, grain, dents, or equivalent visible relief"}, {"id": "micro", "frequency": 56.0, "amplitude": 0.08, "role": "highlight breakup visible under grazing light"}], "roughness": {"base": 0.16, "variation": 0.025, "map": "independent subtle procedural field", "localResponse": "soft broad variation; keep cute forms readable"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "smooth", "strength": 0.0, "scale": 10.0, "space": "tangent"}, "bump": {"pattern": "none", "amplitude": 0.0, "scale": 8.0}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.18, "contactShadowBias": 0.2, "notes": "Keep face and scarf folds soft; avoid muddy cavities."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#241B17"}, "localOverrides": [], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Stylized and relightable; does not claim physical material recovery from the illustration.", "clearcoat": 0.32},
    options
  );
  materialMap["tuft-cream"] = createSculptMaterial(
    "tuft-cream",
    {"id": "tuft-cream", "name": "Warm cream crown tufts", "type": "standard", "shaderModel": "MeshStandardMaterial / stylized IP PBR", "baseColor": "#F2D28E", "color": "#F2D28E", "albedo": {"dominant": "#F2D28E", "secondary": ["#FFE8B3"], "samplingNotes": "Stylized authored palette; source illustration lighting is not treated as measured albedo."}, "colorVariation": {"palette": ["#F2D28E", "#FFE8B3"], "pattern": "subtle fabric variation", "amplitude": 0.06, "heightCorrelation": 0.15}, "textureResolution": 256, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.42, "role": "broad color and height breakup"}, {"id": "meso", "frequency": 12.0, "amplitude": 0.22, "role": "ridges, pores, grain, dents, or equivalent visible relief"}, {"id": "micro", "frequency": 56.0, "amplitude": 0.08, "role": "highlight breakup visible under grazing light"}], "roughness": {"base": 0.42, "variation": 0.08, "map": "independent subtle procedural field", "localResponse": "soft broad variation; keep cute forms readable"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "subtle broad painterly texture only", "strength": 0.04, "scale": 10.0, "space": "tangent"}, "bump": {"pattern": "subtle broad tactile variation", "amplitude": 0.01, "scale": 8.0}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.18, "contactShadowBias": 0.2, "notes": "Keep face and scarf folds soft; avoid muddy cavities."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#241B17"}, "localOverrides": [], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Stylized and relightable; does not claim physical material recovery from the illustration."},
    options
  );
  materialMap["face-line"] = createSculptMaterial(
    "face-line",
    {"id": "face-line", "name": "Warm dark face lines", "type": "standard", "shaderModel": "MeshStandardMaterial / stylized IP PBR", "baseColor": "#2C1B15", "color": "#2C1B15", "albedo": {"dominant": "#2C1B15", "secondary": ["#4B3025"], "samplingNotes": "Stylized authored palette; source illustration lighting is not treated as measured albedo."}, "colorVariation": {"palette": ["#2C1B15", "#4B3025"], "pattern": "soft broad mottling", "amplitude": 0.1, "heightCorrelation": 0.15}, "textureResolution": 256, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.42, "role": "broad color and height breakup"}, {"id": "meso", "frequency": 12.0, "amplitude": 0.22, "role": "ridges, pores, grain, dents, or equivalent visible relief"}, {"id": "micro", "frequency": 56.0, "amplitude": 0.08, "role": "highlight breakup visible under grazing light"}], "roughness": {"base": 0.58, "variation": 0.08, "map": "independent subtle procedural field", "localResponse": "soft broad variation; keep cute forms readable"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "subtle broad painterly texture only", "strength": 0.0, "scale": 10.0, "space": "tangent"}, "bump": {"pattern": "subtle broad tactile variation", "amplitude": 0.01, "scale": 8.0}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.18, "contactShadowBias": 0.2, "notes": "Keep face and scarf folds soft; avoid muddy cavities."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#241B17"}, "localOverrides": [], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Stylized and relightable; does not claim physical material recovery from the illustration."},
    options
  );
  materialMap["hidden"] = createSculptMaterial(
    "hidden",
    {"id": "hidden", "name": "Invisible root material", "type": "standard", "shaderModel": "MeshStandardMaterial / stylized IP PBR", "baseColor": "#000000", "color": "#000000", "albedo": {"dominant": "#000000", "secondary": ["#000000"], "samplingNotes": "Stylized authored palette; source illustration lighting is not treated as measured albedo."}, "colorVariation": {"palette": ["#000000", "#000000"], "pattern": "soft broad mottling", "amplitude": 0.1, "heightCorrelation": 0.15}, "textureResolution": 256, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.42, "role": "broad color and height breakup"}, {"id": "meso", "frequency": 12.0, "amplitude": 0.22, "role": "ridges, pores, grain, dents, or equivalent visible relief"}, {"id": "micro", "frequency": 56.0, "amplitude": 0.08, "role": "highlight breakup visible under grazing light"}], "roughness": {"base": 1.0, "variation": 0.08, "map": "independent subtle procedural field", "localResponse": "soft broad variation; keep cute forms readable"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "subtle broad painterly texture only", "strength": 0.0, "scale": 10.0, "space": "tangent"}, "bump": {"pattern": "subtle broad tactile variation", "amplitude": 0.01, "scale": 8.0}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.18, "contactShadowBias": 0.2, "notes": "Keep face and scarf folds soft; avoid muddy cavities."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#241B17"}, "localOverrides": [], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Stylized and relightable; does not claim physical material recovery from the illustration."},
    options
  );

  const nodes: Record<string, THREE.Object3D> = { root };
  const meshes: Record<string, THREE.Mesh> = {};
  const sockets: Record<string, THREE.Object3D> = {};
  const colliders: Record<string, unknown> = {};
  const destructionGroups: Record<string, THREE.Object3D[]> = {};

  const endpoint_root_0 = makeAttachmentEndpoint(null);
  const node_root_0 = new THREE.Group();
  node_root_0.name = "Xiaomotuan Static Root__pivot";
  node_root_0.scale.set(1, 1, 1);
  if (endpoint_root_0) {
    node_root_0.position.copy(endpoint_root_0.start);
    node_root_0.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_root_0.position.set(0.0, 0.0, 0.0);
    node_root_0.rotation.set(0.0, 0.0, 0.0);
  }
  node_root_0.userData.sculptComponent = {"id": "root", "name": "Xiaomotuan Static Root", "level": "macro", "role": "root", "importance": 1.0, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Character (root) is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": null, "attachment": null, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 1.0}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hidden"}}, "material": "hidden", "materialLayers": ["hidden"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(73, 59, 51, 1.0)", "secondaryAlbedo": "rgba(116, 90, 71, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.5, "notes": "Grouping node uses the original dark body silhouette with a gentle warm lift plus teal scarf."}};
  node_root_0.userData.actionProfile = {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hidden"}};
  (nodes["root"] ?? root).add(node_root_0);
  nodes["root"] = node_root_0;
  const mesh_root_0Geometry = endpoint_root_0
    ? new THREE.CylinderGeometry(endpoint_root_0.endRadius, endpoint_root_0.baseRadius, endpoint_root_0.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_root_0) {
    mesh_root_0Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_root_0 = new THREE.Mesh(
    mesh_root_0Geometry,
    materialMap["hidden"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_root_0.name = "Xiaomotuan Static Root";
  if (endpoint_root_0) {
    mesh_root_0.position.copy(endpoint_root_0.midpoint);
    mesh_root_0.quaternion.copy(endpoint_root_0.quaternion);
  }
  mesh_root_0.castShadow = options.castShadow ?? true;
  mesh_root_0.receiveShadow = options.receiveShadow ?? true;
  mesh_root_0.userData.sculptComponent = {"id": "root", "name": "Xiaomotuan Static Root", "level": "macro", "role": "root", "importance": 1.0, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Character (root) is a discrete primitive body part assembled onto the humanoid rig, not a continuous sculpt or shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": null, "attachment": null, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 1.0}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hidden"}}, "material": "hidden", "materialLayers": ["hidden"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(73, 59, 51, 1.0)", "secondaryAlbedo": "rgba(116, 90, 71, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.5, "notes": "Grouping node uses the original dark body silhouette with a gentle warm lift plus teal scarf."}};
  node_root_0.add(mesh_root_0);
  meshes["root"] = mesh_root_0;
  colliders["root"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_root_0);

  const endpoint_head_shell_1 = makeAttachmentEndpoint(null);
  const node_head_shell_1 = new THREE.Group();
  node_head_shell_1.name = "Head Shell__pivot";
  node_head_shell_1.scale.set(1, 1, 1);
  if (endpoint_head_shell_1) {
    node_head_shell_1.position.copy(endpoint_head_shell_1.start);
    node_head_shell_1.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_head_shell_1.position.set(0.0, 0.15, 0.0);
    node_head_shell_1.rotation.set(0.0, 0.0, 0.0);
  }
  node_head_shell_1.userData.sculptComponent = {"id": "head-shell", "name": "Head Shell", "level": "macro", "role": "body", "importance": 1.0, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Head Shell uses continuous-sculpt topology based on its observed rounded or cloth silhouette.", "geometryDescriptor": {"topologyIntent": "organic deformed mesh", "edgeTreatment": {"type": "soft", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": {"parentId": "root", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.02], "contactType": "overlap", "overlap": 0.025, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.74, "height": 0.78, "depth": 0.56, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0.15, 0], "rotation": [0, 0, 0], "scale": [0.74, 0.78, 0.56]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "head", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "body-charcoal", "materialLayers": ["body-charcoal"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["head-contour", "chibi-face-proportion"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(73, 59, 51, 1.0)", "secondaryAlbedo": "rgba(116, 90, 71, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.72, "notes": "Original warm charcoal-brown palette with a modest brightness lift; exact values are in the linked material."}};
  node_head_shell_1.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "head", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}};
  (nodes["root"] ?? root).add(node_head_shell_1);
  nodes["head-shell"] = node_head_shell_1;
  const mesh_head_shell_1Geometry = endpoint_head_shell_1
    ? new THREE.CylinderGeometry(endpoint_head_shell_1.endRadius, endpoint_head_shell_1.baseRadius, endpoint_head_shell_1.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_head_shell_1) {
    mesh_head_shell_1Geometry.scale(0.74, 0.78, 0.56);
  }
  const mesh_head_shell_1 = new THREE.Mesh(
    mesh_head_shell_1Geometry,
    materialMap["body-charcoal"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_head_shell_1.name = "Head Shell";
  if (endpoint_head_shell_1) {
    mesh_head_shell_1.position.copy(endpoint_head_shell_1.midpoint);
    mesh_head_shell_1.quaternion.copy(endpoint_head_shell_1.quaternion);
  }
  mesh_head_shell_1.castShadow = options.castShadow ?? true;
  mesh_head_shell_1.receiveShadow = options.receiveShadow ?? true;
  mesh_head_shell_1.userData.sculptComponent = {"id": "head-shell", "name": "Head Shell", "level": "macro", "role": "body", "importance": 1.0, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Head Shell uses continuous-sculpt topology based on its observed rounded or cloth silhouette.", "geometryDescriptor": {"topologyIntent": "organic deformed mesh", "edgeTreatment": {"type": "soft", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": {"parentId": "root", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.02], "contactType": "overlap", "overlap": 0.025, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.74, "height": 0.78, "depth": 0.56, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0.15, 0], "rotation": [0, 0, 0], "scale": [0.74, 0.78, 0.56]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "head", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "body-charcoal", "materialLayers": ["body-charcoal"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["head-contour", "chibi-face-proportion"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(73, 59, 51, 1.0)", "secondaryAlbedo": "rgba(116, 90, 71, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.72, "notes": "Original warm charcoal-brown palette with a modest brightness lift; exact values are in the linked material."}};
  node_head_shell_1.add(mesh_head_shell_1);
  meshes["head-shell"] = mesh_head_shell_1;
  colliders["head-shell"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["head"] ??= [];
  destructionGroups["head"].push(node_head_shell_1);

  const endpoint_body_shell_2 = makeAttachmentEndpoint(null);
  const node_body_shell_2 = new THREE.Group();
  node_body_shell_2.name = "Body Shell__pivot";
  node_body_shell_2.scale.set(1, 1, 1);
  if (endpoint_body_shell_2) {
    node_body_shell_2.position.copy(endpoint_body_shell_2.start);
    node_body_shell_2.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_body_shell_2.position.set(0.0, -0.26, 0.0);
    node_body_shell_2.rotation.set(0.0, 0.0, 0.0);
  }
  node_body_shell_2.userData.sculptComponent = {"id": "body-shell", "name": "Body Shell", "level": "macro", "role": "body", "importance": 1.0, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Body Shell uses continuous-sculpt topology based on its observed rounded or cloth silhouette.", "geometryDescriptor": {"topologyIntent": "organic deformed mesh", "edgeTreatment": {"type": "soft", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": {"parentId": "root", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.02], "contactType": "overlap", "overlap": 0.025, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.64, "height": 0.66, "depth": 0.51, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, -0.26, 0], "rotation": [0, 0, 0], "scale": [0.64, 0.66, 0.51]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "head", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "body-charcoal", "materialLayers": ["body-charcoal"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["warm-charcoal-mottle", "round-body-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(73, 59, 51, 1.0)", "secondaryAlbedo": "rgba(116, 90, 71, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.72, "notes": "Original warm charcoal-brown palette with a modest brightness lift; exact values are in the linked material."}};
  node_body_shell_2.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "head", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}};
  (nodes["root"] ?? root).add(node_body_shell_2);
  nodes["body-shell"] = node_body_shell_2;
  const mesh_body_shell_2Geometry = endpoint_body_shell_2
    ? new THREE.CylinderGeometry(endpoint_body_shell_2.endRadius, endpoint_body_shell_2.baseRadius, endpoint_body_shell_2.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_body_shell_2) {
    mesh_body_shell_2Geometry.scale(0.64, 0.66, 0.51);
  }
  const mesh_body_shell_2 = new THREE.Mesh(
    mesh_body_shell_2Geometry,
    materialMap["body-charcoal"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_body_shell_2.name = "Body Shell";
  if (endpoint_body_shell_2) {
    mesh_body_shell_2.position.copy(endpoint_body_shell_2.midpoint);
    mesh_body_shell_2.quaternion.copy(endpoint_body_shell_2.quaternion);
  }
  mesh_body_shell_2.castShadow = options.castShadow ?? true;
  mesh_body_shell_2.receiveShadow = options.receiveShadow ?? true;
  mesh_body_shell_2.userData.sculptComponent = {"id": "body-shell", "name": "Body Shell", "level": "macro", "role": "body", "importance": 1.0, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Body Shell uses continuous-sculpt topology based on its observed rounded or cloth silhouette.", "geometryDescriptor": {"topologyIntent": "organic deformed mesh", "edgeTreatment": {"type": "soft", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": {"parentId": "root", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.02], "contactType": "overlap", "overlap": 0.025, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.64, "height": 0.66, "depth": 0.51, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, -0.26, 0], "rotation": [0, 0, 0], "scale": [0.64, 0.66, 0.51]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "head", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "body-charcoal", "materialLayers": ["body-charcoal"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["warm-charcoal-mottle", "round-body-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(73, 59, 51, 1.0)", "secondaryAlbedo": "rgba(116, 90, 71, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.72, "notes": "Original warm charcoal-brown palette with a modest brightness lift; exact values are in the linked material."}};
  node_body_shell_2.add(mesh_body_shell_2);
  meshes["body-shell"] = mesh_body_shell_2;
  colliders["body-shell"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["head"] ??= [];
  destructionGroups["head"].push(node_body_shell_2);

  const endpoint_arm_raised_3 = makeAttachmentEndpoint(null);
  const node_arm_raised_3 = new THREE.Group();
  node_arm_raised_3.name = "Cheek-touch Arm__pivot";
  node_arm_raised_3.scale.set(1, 1, 1);
  if (endpoint_arm_raised_3) {
    node_arm_raised_3.position.copy(endpoint_arm_raised_3.start);
    node_arm_raised_3.rotation.set(0.0, 0.0, -0.45);
  } else {
    node_arm_raised_3.position.set(-0.3, -0.03, 0.2);
    node_arm_raised_3.rotation.set(0.0, 0.0, -0.45);
  }
  node_arm_raised_3.userData.sculptComponent = {"id": "arm-raised", "name": "Cheek-touch Arm", "level": "meso", "role": "detail", "importance": 0.85, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "assembled-solid", "topologyRationale": "Cheek-touch Arm uses assembled-solid topology based on its observed rounded or cloth silhouette.", "geometryDescriptor": {"topologyIntent": "stylized rounded part", "edgeTreatment": {"type": "soft", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": {"parentId": "root", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.02], "contactType": "overlap", "overlap": 0.025, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.22, "height": 0.32, "depth": 0.19, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.3, -0.03, 0.2], "rotation": [0, 0, -0.45], "scale": [0.22, 0.32, 0.19]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "upper-arm-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "shirt"}}, "material": "body-charcoal", "materialLayers": ["body-charcoal"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["cheek-touch-arm", "soft-rounded-limb"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(73, 59, 51, 1.0)", "secondaryAlbedo": "rgba(116, 90, 71, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.72, "notes": "Original warm charcoal-brown palette with a modest brightness lift; exact values are in the linked material."}};
  node_arm_raised_3.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "upper-arm-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "shirt"}};
  (nodes["root"] ?? root).add(node_arm_raised_3);
  nodes["arm-raised"] = node_arm_raised_3;
  const mesh_arm_raised_3Geometry = endpoint_arm_raised_3
    ? new THREE.CylinderGeometry(endpoint_arm_raised_3.endRadius, endpoint_arm_raised_3.baseRadius, endpoint_arm_raised_3.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_arm_raised_3) {
    mesh_arm_raised_3Geometry.scale(0.22, 0.32, 0.19);
  }
  const mesh_arm_raised_3 = new THREE.Mesh(
    mesh_arm_raised_3Geometry,
    materialMap["body-charcoal"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_arm_raised_3.name = "Cheek-touch Arm";
  if (endpoint_arm_raised_3) {
    mesh_arm_raised_3.position.copy(endpoint_arm_raised_3.midpoint);
    mesh_arm_raised_3.quaternion.copy(endpoint_arm_raised_3.quaternion);
  }
  mesh_arm_raised_3.castShadow = options.castShadow ?? true;
  mesh_arm_raised_3.receiveShadow = options.receiveShadow ?? true;
  mesh_arm_raised_3.userData.sculptComponent = {"id": "arm-raised", "name": "Cheek-touch Arm", "level": "meso", "role": "detail", "importance": 0.85, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "assembled-solid", "topologyRationale": "Cheek-touch Arm uses assembled-solid topology based on its observed rounded or cloth silhouette.", "geometryDescriptor": {"topologyIntent": "stylized rounded part", "edgeTreatment": {"type": "soft", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": {"parentId": "root", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.02], "contactType": "overlap", "overlap": 0.025, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.22, "height": 0.32, "depth": 0.19, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.3, -0.03, 0.2], "rotation": [0, 0, -0.45], "scale": [0.22, 0.32, 0.19]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "upper-arm-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "shirt"}}, "material": "body-charcoal", "materialLayers": ["body-charcoal"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["cheek-touch-arm", "soft-rounded-limb"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(73, 59, 51, 1.0)", "secondaryAlbedo": "rgba(116, 90, 71, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.72, "notes": "Original warm charcoal-brown palette with a modest brightness lift; exact values are in the linked material."}};
  node_arm_raised_3.add(mesh_arm_raised_3);
  meshes["arm-raised"] = mesh_arm_raised_3;
  colliders["arm-raised"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["upper-arm-l"] ??= [];
  destructionGroups["upper-arm-l"].push(node_arm_raised_3);

  const endpoint_arm_relaxed_4 = makeAttachmentEndpoint(null);
  const node_arm_relaxed_4 = new THREE.Group();
  node_arm_relaxed_4.name = "Relaxed Arm__pivot";
  node_arm_relaxed_4.scale.set(1, 1, 1);
  if (endpoint_arm_relaxed_4) {
    node_arm_relaxed_4.position.copy(endpoint_arm_relaxed_4.start);
    node_arm_relaxed_4.rotation.set(0.0, 0.0, 0.28);
  } else {
    node_arm_relaxed_4.position.set(0.29, -0.2, 0.18);
    node_arm_relaxed_4.rotation.set(0.0, 0.0, 0.28);
  }
  node_arm_relaxed_4.userData.sculptComponent = {"id": "arm-relaxed", "name": "Relaxed Arm", "level": "meso", "role": "detail", "importance": 0.85, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "assembled-solid", "topologyRationale": "Relaxed Arm uses assembled-solid topology based on its observed rounded or cloth silhouette.", "geometryDescriptor": {"topologyIntent": "stylized rounded part", "edgeTreatment": {"type": "soft", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": {"parentId": "root", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.02], "contactType": "overlap", "overlap": 0.025, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.19, "height": 0.28, "depth": 0.17, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.29, -0.2, 0.18], "rotation": [0, 0, 0.28], "scale": [0.19, 0.28, 0.17]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "upper-arm-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "shirt"}}, "material": "body-charcoal", "materialLayers": ["body-charcoal"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["relaxed-rounded-limb"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(73, 59, 51, 1.0)", "secondaryAlbedo": "rgba(116, 90, 71, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.72, "notes": "Original warm charcoal-brown palette with a modest brightness lift; exact values are in the linked material."}};
  node_arm_relaxed_4.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "upper-arm-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "shirt"}};
  (nodes["root"] ?? root).add(node_arm_relaxed_4);
  nodes["arm-relaxed"] = node_arm_relaxed_4;
  const mesh_arm_relaxed_4Geometry = endpoint_arm_relaxed_4
    ? new THREE.CylinderGeometry(endpoint_arm_relaxed_4.endRadius, endpoint_arm_relaxed_4.baseRadius, endpoint_arm_relaxed_4.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_arm_relaxed_4) {
    mesh_arm_relaxed_4Geometry.scale(0.19, 0.28, 0.17);
  }
  const mesh_arm_relaxed_4 = new THREE.Mesh(
    mesh_arm_relaxed_4Geometry,
    materialMap["body-charcoal"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_arm_relaxed_4.name = "Relaxed Arm";
  if (endpoint_arm_relaxed_4) {
    mesh_arm_relaxed_4.position.copy(endpoint_arm_relaxed_4.midpoint);
    mesh_arm_relaxed_4.quaternion.copy(endpoint_arm_relaxed_4.quaternion);
  }
  mesh_arm_relaxed_4.castShadow = options.castShadow ?? true;
  mesh_arm_relaxed_4.receiveShadow = options.receiveShadow ?? true;
  mesh_arm_relaxed_4.userData.sculptComponent = {"id": "arm-relaxed", "name": "Relaxed Arm", "level": "meso", "role": "detail", "importance": 0.85, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "assembled-solid", "topologyRationale": "Relaxed Arm uses assembled-solid topology based on its observed rounded or cloth silhouette.", "geometryDescriptor": {"topologyIntent": "stylized rounded part", "edgeTreatment": {"type": "soft", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": {"parentId": "root", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.02], "contactType": "overlap", "overlap": 0.025, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.19, "height": 0.28, "depth": 0.17, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.29, -0.2, 0.18], "rotation": [0, 0, 0.28], "scale": [0.19, 0.28, 0.17]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "upper-arm-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "shirt"}}, "material": "body-charcoal", "materialLayers": ["body-charcoal"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["relaxed-rounded-limb"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(73, 59, 51, 1.0)", "secondaryAlbedo": "rgba(116, 90, 71, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.72, "notes": "Original warm charcoal-brown palette with a modest brightness lift; exact values are in the linked material."}};
  node_arm_relaxed_4.add(mesh_arm_relaxed_4);
  meshes["arm-relaxed"] = mesh_arm_relaxed_4;
  colliders["arm-relaxed"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["upper-arm-l"] ??= [];
  destructionGroups["upper-arm-l"].push(node_arm_relaxed_4);

  const endpoint_foot_left_5 = makeAttachmentEndpoint(null);
  const node_foot_left_5 = new THREE.Group();
  node_foot_left_5.name = "Left Rounded Foot__pivot";
  node_foot_left_5.scale.set(1, 1, 1);
  if (endpoint_foot_left_5) {
    node_foot_left_5.position.copy(endpoint_foot_left_5.start);
    node_foot_left_5.rotation.set(0.0, 0.0, -0.08);
  } else {
    node_foot_left_5.position.set(-0.16, -0.53, 0.06);
    node_foot_left_5.rotation.set(0.0, 0.0, -0.08);
  }
  node_foot_left_5.userData.sculptComponent = {"id": "foot-left", "name": "Left Rounded Foot", "level": "meso", "role": "detail", "importance": 0.85, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "assembled-solid", "topologyRationale": "Left Rounded Foot uses assembled-solid topology based on its observed rounded or cloth silhouette.", "geometryDescriptor": {"topologyIntent": "stylized rounded part", "edgeTreatment": {"type": "soft", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": {"parentId": "root", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.02], "contactType": "overlap", "overlap": 0.025, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.25, "height": 0.14, "depth": 0.27, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.16, -0.53, 0.06], "rotation": [0, 0, -0.08], "scale": [0.25, 0.14, 0.27]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "foot-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "shoes"}}, "material": "body-charcoal", "materialLayers": ["body-charcoal"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["rounded-foot"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(73, 59, 51, 1.0)", "secondaryAlbedo": "rgba(116, 90, 71, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.72, "notes": "Original warm charcoal-brown palette with a modest brightness lift; exact values are in the linked material."}};
  node_foot_left_5.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "foot-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "shoes"}};
  (nodes["root"] ?? root).add(node_foot_left_5);
  nodes["foot-left"] = node_foot_left_5;
  const mesh_foot_left_5Geometry = endpoint_foot_left_5
    ? new THREE.CylinderGeometry(endpoint_foot_left_5.endRadius, endpoint_foot_left_5.baseRadius, endpoint_foot_left_5.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_foot_left_5) {
    mesh_foot_left_5Geometry.scale(0.25, 0.14, 0.27);
  }
  const mesh_foot_left_5 = new THREE.Mesh(
    mesh_foot_left_5Geometry,
    materialMap["body-charcoal"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_foot_left_5.name = "Left Rounded Foot";
  if (endpoint_foot_left_5) {
    mesh_foot_left_5.position.copy(endpoint_foot_left_5.midpoint);
    mesh_foot_left_5.quaternion.copy(endpoint_foot_left_5.quaternion);
  }
  mesh_foot_left_5.castShadow = options.castShadow ?? true;
  mesh_foot_left_5.receiveShadow = options.receiveShadow ?? true;
  mesh_foot_left_5.userData.sculptComponent = {"id": "foot-left", "name": "Left Rounded Foot", "level": "meso", "role": "detail", "importance": 0.85, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "assembled-solid", "topologyRationale": "Left Rounded Foot uses assembled-solid topology based on its observed rounded or cloth silhouette.", "geometryDescriptor": {"topologyIntent": "stylized rounded part", "edgeTreatment": {"type": "soft", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": {"parentId": "root", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.02], "contactType": "overlap", "overlap": 0.025, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.25, "height": 0.14, "depth": 0.27, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.16, -0.53, 0.06], "rotation": [0, 0, -0.08], "scale": [0.25, 0.14, 0.27]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "foot-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "shoes"}}, "material": "body-charcoal", "materialLayers": ["body-charcoal"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["rounded-foot"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(73, 59, 51, 1.0)", "secondaryAlbedo": "rgba(116, 90, 71, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.72, "notes": "Original warm charcoal-brown palette with a modest brightness lift; exact values are in the linked material."}};
  node_foot_left_5.add(mesh_foot_left_5);
  meshes["foot-left"] = mesh_foot_left_5;
  colliders["foot-left"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["foot-l"] ??= [];
  destructionGroups["foot-l"].push(node_foot_left_5);

  const endpoint_foot_right_6 = makeAttachmentEndpoint(null);
  const node_foot_right_6 = new THREE.Group();
  node_foot_right_6.name = "Right Rounded Foot__pivot";
  node_foot_right_6.scale.set(1, 1, 1);
  if (endpoint_foot_right_6) {
    node_foot_right_6.position.copy(endpoint_foot_right_6.start);
    node_foot_right_6.rotation.set(0.0, 0.0, 0.08);
  } else {
    node_foot_right_6.position.set(0.16, -0.53, 0.06);
    node_foot_right_6.rotation.set(0.0, 0.0, 0.08);
  }
  node_foot_right_6.userData.sculptComponent = {"id": "foot-right", "name": "Right Rounded Foot", "level": "meso", "role": "detail", "importance": 0.85, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "assembled-solid", "topologyRationale": "Right Rounded Foot uses assembled-solid topology based on its observed rounded or cloth silhouette.", "geometryDescriptor": {"topologyIntent": "stylized rounded part", "edgeTreatment": {"type": "soft", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": {"parentId": "root", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.02], "contactType": "overlap", "overlap": 0.025, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.25, "height": 0.14, "depth": 0.27, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.16, -0.53, 0.06], "rotation": [0, 0, 0.08], "scale": [0.25, 0.14, 0.27]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "foot-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "shoes"}}, "material": "body-charcoal", "materialLayers": ["body-charcoal"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["rounded-foot"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(73, 59, 51, 1.0)", "secondaryAlbedo": "rgba(116, 90, 71, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.72, "notes": "Original warm charcoal-brown palette with a modest brightness lift; exact values are in the linked material."}};
  node_foot_right_6.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "foot-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "shoes"}};
  (nodes["root"] ?? root).add(node_foot_right_6);
  nodes["foot-right"] = node_foot_right_6;
  const mesh_foot_right_6Geometry = endpoint_foot_right_6
    ? new THREE.CylinderGeometry(endpoint_foot_right_6.endRadius, endpoint_foot_right_6.baseRadius, endpoint_foot_right_6.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_foot_right_6) {
    mesh_foot_right_6Geometry.scale(0.25, 0.14, 0.27);
  }
  const mesh_foot_right_6 = new THREE.Mesh(
    mesh_foot_right_6Geometry,
    materialMap["body-charcoal"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_foot_right_6.name = "Right Rounded Foot";
  if (endpoint_foot_right_6) {
    mesh_foot_right_6.position.copy(endpoint_foot_right_6.midpoint);
    mesh_foot_right_6.quaternion.copy(endpoint_foot_right_6.quaternion);
  }
  mesh_foot_right_6.castShadow = options.castShadow ?? true;
  mesh_foot_right_6.receiveShadow = options.receiveShadow ?? true;
  mesh_foot_right_6.userData.sculptComponent = {"id": "foot-right", "name": "Right Rounded Foot", "level": "meso", "role": "detail", "importance": 0.85, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "assembled-solid", "topologyRationale": "Right Rounded Foot uses assembled-solid topology based on its observed rounded or cloth silhouette.", "geometryDescriptor": {"topologyIntent": "stylized rounded part", "edgeTreatment": {"type": "soft", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": {"parentId": "root", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.02], "contactType": "overlap", "overlap": 0.025, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.25, "height": 0.14, "depth": 0.27, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.16, -0.53, 0.06], "rotation": [0, 0, 0.08], "scale": [0.25, 0.14, 0.27]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "foot-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "shoes"}}, "material": "body-charcoal", "materialLayers": ["body-charcoal"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["rounded-foot"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(73, 59, 51, 1.0)", "secondaryAlbedo": "rgba(116, 90, 71, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.72, "notes": "Original warm charcoal-brown palette with a modest brightness lift; exact values are in the linked material."}};
  node_foot_right_6.add(mesh_foot_right_6);
  meshes["foot-right"] = mesh_foot_right_6;
  colliders["foot-right"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["foot-l"] ??= [];
  destructionGroups["foot-l"].push(node_foot_right_6);

  const endpoint_tuft_primary_7 = makeAttachmentEndpoint(null);
  const node_tuft_primary_7 = new THREE.Group();
  node_tuft_primary_7.name = "Primary Crown Flame__pivot";
  node_tuft_primary_7.scale.set(1, 1, 1);
  if (endpoint_tuft_primary_7) {
    node_tuft_primary_7.position.copy(endpoint_tuft_primary_7.start);
    node_tuft_primary_7.rotation.set(0.0, 0.0, -0.08);
  } else {
    node_tuft_primary_7.position.set(-0.02, 0.57, -0.01);
    node_tuft_primary_7.rotation.set(0.0, 0.0, -0.08);
  }
  node_tuft_primary_7.userData.sculptComponent = {"id": "tuft-primary", "name": "Primary Crown Flame", "level": "meso", "role": "detail", "importance": 0.85, "confidence": 0.8, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Primary Crown Flame uses continuous-sculpt topology based on its observed rounded or cloth silhouette.", "geometryDescriptor": {"topologyIntent": "organic deformed mesh", "edgeTreatment": {"type": "soft", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [[0, -0.38, 0, 0.42, 0.34], [0.02, -0.08, 0, 0.46, 0.3], [0.08, 0.2, 0, 0.25, 0.18], [0.02, 0.46, 0, 0, 0]], "radialSegments": 10, "capEnds": true}}, "parent": "root", "attachment": {"parentId": "root", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.02], "contactType": "overlap", "overlap": 0.025, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.3, "height": 0.48, "depth": 0.2, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.02, 0.57, -0.01], "rotation": [0, 0, -0.08], "scale": [0.3, 0.48, 0.2]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}}, "material": "tuft-cream", "materialLayers": ["tuft-cream"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["primary-tuft-socket", "primary-flame-silhouette"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(242, 210, 142, 1.0)", "secondaryAlbedo": "rgba(255, 232, 179, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.72, "notes": "Exact albedo hex values live in the linked material; the RGBA placeholders are validator evidence only."}};
  node_tuft_primary_7.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}};
  (nodes["root"] ?? root).add(node_tuft_primary_7);
  nodes["tuft-primary"] = node_tuft_primary_7;
  const mesh_tuft_primary_7Geometry = endpoint_tuft_primary_7
    ? new THREE.CylinderGeometry(endpoint_tuft_primary_7.endRadius, endpoint_tuft_primary_7.baseRadius, endpoint_tuft_primary_7.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [[0, -0.38, 0, 0.42, 0.34], [0.02, -0.08, 0, 0.46, 0.3], [0.08, 0.2, 0, 0.25, 0.18], [0.02, 0.46, 0, 0, 0]], "radialSegments": 10, "capEnds": true});
  if (!endpoint_tuft_primary_7) {
    mesh_tuft_primary_7Geometry.scale(0.3, 0.48, 0.2);
  }
  const mesh_tuft_primary_7 = new THREE.Mesh(
    mesh_tuft_primary_7Geometry,
    materialMap["tuft-cream"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_tuft_primary_7.name = "Primary Crown Flame";
  if (endpoint_tuft_primary_7) {
    mesh_tuft_primary_7.position.copy(endpoint_tuft_primary_7.midpoint);
    mesh_tuft_primary_7.quaternion.copy(endpoint_tuft_primary_7.quaternion);
  }
  mesh_tuft_primary_7.castShadow = options.castShadow ?? true;
  mesh_tuft_primary_7.receiveShadow = options.receiveShadow ?? true;
  mesh_tuft_primary_7.userData.sculptComponent = {"id": "tuft-primary", "name": "Primary Crown Flame", "level": "meso", "role": "detail", "importance": 0.85, "confidence": 0.8, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Primary Crown Flame uses continuous-sculpt topology based on its observed rounded or cloth silhouette.", "geometryDescriptor": {"topologyIntent": "organic deformed mesh", "edgeTreatment": {"type": "soft", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [[0, -0.38, 0, 0.42, 0.34], [0.02, -0.08, 0, 0.46, 0.3], [0.08, 0.2, 0, 0.25, 0.18], [0.02, 0.46, 0, 0, 0]], "radialSegments": 10, "capEnds": true}}, "parent": "root", "attachment": {"parentId": "root", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.02], "contactType": "overlap", "overlap": 0.025, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.3, "height": 0.48, "depth": 0.2, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.02, 0.57, -0.01], "rotation": [0, 0, -0.08], "scale": [0.3, 0.48, 0.2]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}}, "material": "tuft-cream", "materialLayers": ["tuft-cream"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["primary-tuft-socket", "primary-flame-silhouette"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(242, 210, 142, 1.0)", "secondaryAlbedo": "rgba(255, 232, 179, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.72, "notes": "Exact albedo hex values live in the linked material; the RGBA placeholders are validator evidence only."}};
  node_tuft_primary_7.add(mesh_tuft_primary_7);
  meshes["tuft-primary"] = mesh_tuft_primary_7;
  colliders["tuft-primary"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["hair"] ??= [];
  destructionGroups["hair"].push(node_tuft_primary_7);

  const endpoint_tuft_secondary_8 = makeAttachmentEndpoint(null);
  const node_tuft_secondary_8 = new THREE.Group();
  node_tuft_secondary_8.name = "Secondary Crown Flame__pivot";
  node_tuft_secondary_8.scale.set(1, 1, 1);
  if (endpoint_tuft_secondary_8) {
    node_tuft_secondary_8.position.copy(endpoint_tuft_secondary_8.start);
    node_tuft_secondary_8.rotation.set(0.0, 0.0, 0.4);
  } else {
    node_tuft_secondary_8.position.set(0.12, 0.54, -0.05);
    node_tuft_secondary_8.rotation.set(0.0, 0.0, 0.4);
  }
  node_tuft_secondary_8.userData.sculptComponent = {"id": "tuft-secondary", "name": "Secondary Crown Flame", "level": "meso", "role": "detail", "importance": 0.85, "confidence": 0.8, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Secondary Crown Flame uses continuous-sculpt topology based on its observed rounded or cloth silhouette.", "geometryDescriptor": {"topologyIntent": "organic deformed mesh", "edgeTreatment": {"type": "soft", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [[0, -0.34, 0, 0.48, 0.32], [0.25, -0.08, 0, 0.4, 0.25], [0.48, 0.14, 0, 0.2, 0.14], [0.52, 0.28, 0, 0, 0]], "radialSegments": 10, "capEnds": true}}, "parent": "root", "attachment": {"parentId": "root", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.02], "contactType": "overlap", "overlap": 0.025, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.27, "height": 0.4, "depth": 0.18, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.12, 0.54, -0.05], "rotation": [0, 0, 0.4], "scale": [0.27, 0.4, 0.18]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}}, "material": "tuft-cream", "materialLayers": ["tuft-cream"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["secondary-tip", "uneven-tuft-pair"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(242, 210, 142, 1.0)", "secondaryAlbedo": "rgba(255, 232, 179, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.72, "notes": "Exact albedo hex values live in the linked material; the RGBA placeholders are validator evidence only."}};
  node_tuft_secondary_8.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}};
  (nodes["root"] ?? root).add(node_tuft_secondary_8);
  nodes["tuft-secondary"] = node_tuft_secondary_8;
  const mesh_tuft_secondary_8Geometry = endpoint_tuft_secondary_8
    ? new THREE.CylinderGeometry(endpoint_tuft_secondary_8.endRadius, endpoint_tuft_secondary_8.baseRadius, endpoint_tuft_secondary_8.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [[0, -0.34, 0, 0.48, 0.32], [0.25, -0.08, 0, 0.4, 0.25], [0.48, 0.14, 0, 0.2, 0.14], [0.52, 0.28, 0, 0, 0]], "radialSegments": 10, "capEnds": true});
  if (!endpoint_tuft_secondary_8) {
    mesh_tuft_secondary_8Geometry.scale(0.27, 0.4, 0.18);
  }
  const mesh_tuft_secondary_8 = new THREE.Mesh(
    mesh_tuft_secondary_8Geometry,
    materialMap["tuft-cream"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_tuft_secondary_8.name = "Secondary Crown Flame";
  if (endpoint_tuft_secondary_8) {
    mesh_tuft_secondary_8.position.copy(endpoint_tuft_secondary_8.midpoint);
    mesh_tuft_secondary_8.quaternion.copy(endpoint_tuft_secondary_8.quaternion);
  }
  mesh_tuft_secondary_8.castShadow = options.castShadow ?? true;
  mesh_tuft_secondary_8.receiveShadow = options.receiveShadow ?? true;
  mesh_tuft_secondary_8.userData.sculptComponent = {"id": "tuft-secondary", "name": "Secondary Crown Flame", "level": "meso", "role": "detail", "importance": 0.85, "confidence": 0.8, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Secondary Crown Flame uses continuous-sculpt topology based on its observed rounded or cloth silhouette.", "geometryDescriptor": {"topologyIntent": "organic deformed mesh", "edgeTreatment": {"type": "soft", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [[0, -0.34, 0, 0.48, 0.32], [0.25, -0.08, 0, 0.4, 0.25], [0.48, 0.14, 0, 0.2, 0.14], [0.52, 0.28, 0, 0, 0]], "radialSegments": 10, "capEnds": true}}, "parent": "root", "attachment": {"parentId": "root", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.02], "contactType": "overlap", "overlap": 0.025, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.27, "height": 0.4, "depth": 0.18, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.12, 0.54, -0.05], "rotation": [0, 0, 0.4], "scale": [0.27, 0.4, 0.18]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}}, "material": "tuft-cream", "materialLayers": ["tuft-cream"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["secondary-tip", "uneven-tuft-pair"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(242, 210, 142, 1.0)", "secondaryAlbedo": "rgba(255, 232, 179, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.72, "notes": "Exact albedo hex values live in the linked material; the RGBA placeholders are validator evidence only."}};
  node_tuft_secondary_8.add(mesh_tuft_secondary_8);
  meshes["tuft-secondary"] = mesh_tuft_secondary_8;
  colliders["tuft-secondary"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["hair"] ??= [];
  destructionGroups["hair"].push(node_tuft_secondary_8);

  const endpoint_eye_sclera_left_9 = makeAttachmentEndpoint(null);
  const node_eye_sclera_left_9 = new THREE.Group();
  node_eye_sclera_left_9.name = "Left Cream Eye__pivot";
  node_eye_sclera_left_9.scale.set(1, 1, 1);
  if (endpoint_eye_sclera_left_9) {
    node_eye_sclera_left_9.position.copy(endpoint_eye_sclera_left_9.start);
    node_eye_sclera_left_9.rotation.set(0.0, 0.0, -0.04);
  } else {
    node_eye_sclera_left_9.position.set(-0.16, 0.15, 0.48);
    node_eye_sclera_left_9.rotation.set(0.0, 0.0, -0.04);
  }
  node_eye_sclera_left_9.userData.sculptComponent = {"id": "eye-sclera-left", "name": "Left Cream Eye", "level": "meso", "role": "detail", "importance": 0.85, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "assembled-solid", "topologyRationale": "Left Cream Eye uses assembled-solid topology based on its observed rounded or cloth silhouette.", "geometryDescriptor": {"topologyIntent": "stylized rounded part", "edgeTreatment": {"type": "soft", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": {"parentId": "root", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.02], "contactType": "overlap", "overlap": 0.025, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.23, "height": 0.26, "depth": 0.085, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.16, 0.15, 0.48], "rotation": [0, 0, -0.04], "scale": [0.23, 0.26, 0.085]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "eye-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "eye"}}, "material": "eye-sclera", "materialLayers": ["eye-sclera"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["oversized-eye-sclera"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 240, 215, 1.0)", "secondaryAlbedo": "rgba(245, 221, 182, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.72, "notes": "Exact albedo hex values live in the linked material; the RGBA placeholders are validator evidence only."}};
  node_eye_sclera_left_9.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "eye-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "eye"}};
  (nodes["root"] ?? root).add(node_eye_sclera_left_9);
  nodes["eye-sclera-left"] = node_eye_sclera_left_9;
  const mesh_eye_sclera_left_9Geometry = endpoint_eye_sclera_left_9
    ? new THREE.CylinderGeometry(endpoint_eye_sclera_left_9.endRadius, endpoint_eye_sclera_left_9.baseRadius, endpoint_eye_sclera_left_9.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_eye_sclera_left_9) {
    mesh_eye_sclera_left_9Geometry.scale(0.23, 0.26, 0.085);
  }
  const mesh_eye_sclera_left_9 = new THREE.Mesh(
    mesh_eye_sclera_left_9Geometry,
    materialMap["eye-sclera"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_eye_sclera_left_9.name = "Left Cream Eye";
  if (endpoint_eye_sclera_left_9) {
    mesh_eye_sclera_left_9.position.copy(endpoint_eye_sclera_left_9.midpoint);
    mesh_eye_sclera_left_9.quaternion.copy(endpoint_eye_sclera_left_9.quaternion);
  }
  mesh_eye_sclera_left_9.castShadow = options.castShadow ?? true;
  mesh_eye_sclera_left_9.receiveShadow = options.receiveShadow ?? true;
  mesh_eye_sclera_left_9.userData.sculptComponent = {"id": "eye-sclera-left", "name": "Left Cream Eye", "level": "meso", "role": "detail", "importance": 0.85, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "assembled-solid", "topologyRationale": "Left Cream Eye uses assembled-solid topology based on its observed rounded or cloth silhouette.", "geometryDescriptor": {"topologyIntent": "stylized rounded part", "edgeTreatment": {"type": "soft", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": {"parentId": "root", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.02], "contactType": "overlap", "overlap": 0.025, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.23, "height": 0.26, "depth": 0.085, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.16, 0.15, 0.48], "rotation": [0, 0, -0.04], "scale": [0.23, 0.26, 0.085]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "eye-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "eye"}}, "material": "eye-sclera", "materialLayers": ["eye-sclera"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["oversized-eye-sclera"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 240, 215, 1.0)", "secondaryAlbedo": "rgba(245, 221, 182, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.72, "notes": "Exact albedo hex values live in the linked material; the RGBA placeholders are validator evidence only."}};
  node_eye_sclera_left_9.add(mesh_eye_sclera_left_9);
  meshes["eye-sclera-left"] = mesh_eye_sclera_left_9;
  colliders["eye-sclera-left"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["eye-l"] ??= [];
  destructionGroups["eye-l"].push(node_eye_sclera_left_9);

  const endpoint_eye_sclera_right_10 = makeAttachmentEndpoint(null);
  const node_eye_sclera_right_10 = new THREE.Group();
  node_eye_sclera_right_10.name = "Right Cream Eye__pivot";
  node_eye_sclera_right_10.scale.set(1, 1, 1);
  if (endpoint_eye_sclera_right_10) {
    node_eye_sclera_right_10.position.copy(endpoint_eye_sclera_right_10.start);
    node_eye_sclera_right_10.rotation.set(0.0, 0.0, 0.06);
  } else {
    node_eye_sclera_right_10.position.set(0.15, 0.12, 0.49);
    node_eye_sclera_right_10.rotation.set(0.0, 0.0, 0.06);
  }
  node_eye_sclera_right_10.userData.sculptComponent = {"id": "eye-sclera-right", "name": "Right Cream Eye", "level": "meso", "role": "detail", "importance": 0.85, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "assembled-solid", "topologyRationale": "Right Cream Eye uses assembled-solid topology based on its observed rounded or cloth silhouette.", "geometryDescriptor": {"topologyIntent": "stylized rounded part", "edgeTreatment": {"type": "soft", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": {"parentId": "root", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.02], "contactType": "overlap", "overlap": 0.025, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.25, "height": 0.28, "depth": 0.09, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.15, 0.12, 0.49], "rotation": [0, 0, 0.06], "scale": [0.25, 0.28, 0.09]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "eye-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "eye"}}, "material": "eye-sclera", "materialLayers": ["eye-sclera"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["oversized-amber-eye"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 240, 215, 1.0)", "secondaryAlbedo": "rgba(245, 221, 182, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.72, "notes": "Exact albedo hex values live in the linked material; the RGBA placeholders are validator evidence only."}};
  node_eye_sclera_right_10.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "eye-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "eye"}};
  (nodes["root"] ?? root).add(node_eye_sclera_right_10);
  nodes["eye-sclera-right"] = node_eye_sclera_right_10;
  const mesh_eye_sclera_right_10Geometry = endpoint_eye_sclera_right_10
    ? new THREE.CylinderGeometry(endpoint_eye_sclera_right_10.endRadius, endpoint_eye_sclera_right_10.baseRadius, endpoint_eye_sclera_right_10.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_eye_sclera_right_10) {
    mesh_eye_sclera_right_10Geometry.scale(0.25, 0.28, 0.09);
  }
  const mesh_eye_sclera_right_10 = new THREE.Mesh(
    mesh_eye_sclera_right_10Geometry,
    materialMap["eye-sclera"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_eye_sclera_right_10.name = "Right Cream Eye";
  if (endpoint_eye_sclera_right_10) {
    mesh_eye_sclera_right_10.position.copy(endpoint_eye_sclera_right_10.midpoint);
    mesh_eye_sclera_right_10.quaternion.copy(endpoint_eye_sclera_right_10.quaternion);
  }
  mesh_eye_sclera_right_10.castShadow = options.castShadow ?? true;
  mesh_eye_sclera_right_10.receiveShadow = options.receiveShadow ?? true;
  mesh_eye_sclera_right_10.userData.sculptComponent = {"id": "eye-sclera-right", "name": "Right Cream Eye", "level": "meso", "role": "detail", "importance": 0.85, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "assembled-solid", "topologyRationale": "Right Cream Eye uses assembled-solid topology based on its observed rounded or cloth silhouette.", "geometryDescriptor": {"topologyIntent": "stylized rounded part", "edgeTreatment": {"type": "soft", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": {"parentId": "root", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.02], "contactType": "overlap", "overlap": 0.025, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.25, "height": 0.28, "depth": 0.09, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.15, 0.12, 0.49], "rotation": [0, 0, 0.06], "scale": [0.25, 0.28, 0.09]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "eye-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "eye"}}, "material": "eye-sclera", "materialLayers": ["eye-sclera"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["oversized-amber-eye"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 240, 215, 1.0)", "secondaryAlbedo": "rgba(245, 221, 182, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.72, "notes": "Exact albedo hex values live in the linked material; the RGBA placeholders are validator evidence only."}};
  node_eye_sclera_right_10.add(mesh_eye_sclera_right_10);
  meshes["eye-sclera-right"] = mesh_eye_sclera_right_10;
  colliders["eye-sclera-right"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["eye-l"] ??= [];
  destructionGroups["eye-l"].push(node_eye_sclera_right_10);

  const endpoint_eye_iris_left_11 = makeAttachmentEndpoint(null);
  const node_eye_iris_left_11 = new THREE.Group();
  node_eye_iris_left_11.name = "Left Amber Iris__pivot";
  node_eye_iris_left_11.scale.set(1, 1, 1);
  if (endpoint_eye_iris_left_11) {
    node_eye_iris_left_11.position.copy(endpoint_eye_iris_left_11.start);
    node_eye_iris_left_11.rotation.set(0.0, 0.0, -0.04);
  } else {
    node_eye_iris_left_11.position.set(-0.15, 0.13, 0.545);
    node_eye_iris_left_11.rotation.set(0.0, 0.0, -0.04);
  }
  node_eye_iris_left_11.userData.sculptComponent = {"id": "eye-iris-left", "name": "Left Amber Iris", "level": "micro", "role": "detail", "importance": 0.7, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "assembled-solid", "topologyRationale": "Left Amber Iris uses assembled-solid topology based on its observed rounded or cloth silhouette.", "geometryDescriptor": {"topologyIntent": "stylized rounded part", "edgeTreatment": {"type": "soft", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": {"parentId": "root", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.02], "contactType": "overlap", "overlap": 0.025, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.13, "height": 0.16, "depth": 0.045, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.15, 0.13, 0.545], "rotation": [0, 0, -0.04], "scale": [0.13, 0.16, 0.045]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "eye-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "eye"}}, "material": "eye-amber", "materialLayers": ["eye-amber"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["amber-iris-layer"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(233, 135, 35, 1.0)", "secondaryAlbedo": "rgba(255, 194, 78, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.72, "notes": "Exact albedo hex values live in the linked material; the RGBA placeholders are validator evidence only."}};
  node_eye_iris_left_11.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "eye-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "eye"}};
  (nodes["root"] ?? root).add(node_eye_iris_left_11);
  nodes["eye-iris-left"] = node_eye_iris_left_11;
  const mesh_eye_iris_left_11Geometry = endpoint_eye_iris_left_11
    ? new THREE.CylinderGeometry(endpoint_eye_iris_left_11.endRadius, endpoint_eye_iris_left_11.baseRadius, endpoint_eye_iris_left_11.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_eye_iris_left_11) {
    mesh_eye_iris_left_11Geometry.scale(0.13, 0.16, 0.045);
  }
  const mesh_eye_iris_left_11 = new THREE.Mesh(
    mesh_eye_iris_left_11Geometry,
    materialMap["eye-amber"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_eye_iris_left_11.name = "Left Amber Iris";
  if (endpoint_eye_iris_left_11) {
    mesh_eye_iris_left_11.position.copy(endpoint_eye_iris_left_11.midpoint);
    mesh_eye_iris_left_11.quaternion.copy(endpoint_eye_iris_left_11.quaternion);
  }
  mesh_eye_iris_left_11.castShadow = options.castShadow ?? true;
  mesh_eye_iris_left_11.receiveShadow = options.receiveShadow ?? true;
  mesh_eye_iris_left_11.userData.sculptComponent = {"id": "eye-iris-left", "name": "Left Amber Iris", "level": "micro", "role": "detail", "importance": 0.7, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "assembled-solid", "topologyRationale": "Left Amber Iris uses assembled-solid topology based on its observed rounded or cloth silhouette.", "geometryDescriptor": {"topologyIntent": "stylized rounded part", "edgeTreatment": {"type": "soft", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": {"parentId": "root", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.02], "contactType": "overlap", "overlap": 0.025, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.13, "height": 0.16, "depth": 0.045, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.15, 0.13, 0.545], "rotation": [0, 0, -0.04], "scale": [0.13, 0.16, 0.045]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "eye-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "eye"}}, "material": "eye-amber", "materialLayers": ["eye-amber"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["amber-iris-layer"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(233, 135, 35, 1.0)", "secondaryAlbedo": "rgba(255, 194, 78, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.72, "notes": "Exact albedo hex values live in the linked material; the RGBA placeholders are validator evidence only."}};
  node_eye_iris_left_11.add(mesh_eye_iris_left_11);
  meshes["eye-iris-left"] = mesh_eye_iris_left_11;
  colliders["eye-iris-left"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["eye-l"] ??= [];
  destructionGroups["eye-l"].push(node_eye_iris_left_11);

  const endpoint_eye_iris_right_12 = makeAttachmentEndpoint(null);
  const node_eye_iris_right_12 = new THREE.Group();
  node_eye_iris_right_12.name = "Right Amber Iris__pivot";
  node_eye_iris_right_12.scale.set(1, 1, 1);
  if (endpoint_eye_iris_right_12) {
    node_eye_iris_right_12.position.copy(endpoint_eye_iris_right_12.start);
    node_eye_iris_right_12.rotation.set(0.0, 0.0, 0.05);
  } else {
    node_eye_iris_right_12.position.set(0.16, 0.1, 0.56);
    node_eye_iris_right_12.rotation.set(0.0, 0.0, 0.05);
  }
  node_eye_iris_right_12.userData.sculptComponent = {"id": "eye-iris-right", "name": "Right Amber Iris", "level": "micro", "role": "detail", "importance": 0.7, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "assembled-solid", "topologyRationale": "Right Amber Iris uses assembled-solid topology based on its observed rounded or cloth silhouette.", "geometryDescriptor": {"topologyIntent": "stylized rounded part", "edgeTreatment": {"type": "soft", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": {"parentId": "root", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.02], "contactType": "overlap", "overlap": 0.025, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.14, "height": 0.17, "depth": 0.05, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.16, 0.1, 0.56], "rotation": [0, 0, 0.05], "scale": [0.14, 0.17, 0.05]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "eye-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "eye"}}, "material": "eye-amber", "materialLayers": ["eye-amber"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["amber-iris-layer"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(233, 135, 35, 1.0)", "secondaryAlbedo": "rgba(255, 194, 78, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.72, "notes": "Exact albedo hex values live in the linked material; the RGBA placeholders are validator evidence only."}};
  node_eye_iris_right_12.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "eye-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "eye"}};
  (nodes["root"] ?? root).add(node_eye_iris_right_12);
  nodes["eye-iris-right"] = node_eye_iris_right_12;
  const mesh_eye_iris_right_12Geometry = endpoint_eye_iris_right_12
    ? new THREE.CylinderGeometry(endpoint_eye_iris_right_12.endRadius, endpoint_eye_iris_right_12.baseRadius, endpoint_eye_iris_right_12.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_eye_iris_right_12) {
    mesh_eye_iris_right_12Geometry.scale(0.14, 0.17, 0.05);
  }
  const mesh_eye_iris_right_12 = new THREE.Mesh(
    mesh_eye_iris_right_12Geometry,
    materialMap["eye-amber"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_eye_iris_right_12.name = "Right Amber Iris";
  if (endpoint_eye_iris_right_12) {
    mesh_eye_iris_right_12.position.copy(endpoint_eye_iris_right_12.midpoint);
    mesh_eye_iris_right_12.quaternion.copy(endpoint_eye_iris_right_12.quaternion);
  }
  mesh_eye_iris_right_12.castShadow = options.castShadow ?? true;
  mesh_eye_iris_right_12.receiveShadow = options.receiveShadow ?? true;
  mesh_eye_iris_right_12.userData.sculptComponent = {"id": "eye-iris-right", "name": "Right Amber Iris", "level": "micro", "role": "detail", "importance": 0.7, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "assembled-solid", "topologyRationale": "Right Amber Iris uses assembled-solid topology based on its observed rounded or cloth silhouette.", "geometryDescriptor": {"topologyIntent": "stylized rounded part", "edgeTreatment": {"type": "soft", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": {"parentId": "root", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.02], "contactType": "overlap", "overlap": 0.025, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.14, "height": 0.17, "depth": 0.05, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.16, 0.1, 0.56], "rotation": [0, 0, 0.05], "scale": [0.14, 0.17, 0.05]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "eye-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "eye"}}, "material": "eye-amber", "materialLayers": ["eye-amber"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["amber-iris-layer"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(233, 135, 35, 1.0)", "secondaryAlbedo": "rgba(255, 194, 78, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.72, "notes": "Exact albedo hex values live in the linked material; the RGBA placeholders are validator evidence only."}};
  node_eye_iris_right_12.add(mesh_eye_iris_right_12);
  meshes["eye-iris-right"] = mesh_eye_iris_right_12;
  colliders["eye-iris-right"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["eye-l"] ??= [];
  destructionGroups["eye-l"].push(node_eye_iris_right_12);

  const endpoint_eye_pupil_left_13 = makeAttachmentEndpoint(null);
  const node_eye_pupil_left_13 = new THREE.Group();
  node_eye_pupil_left_13.name = "Left Pupil__pivot";
  node_eye_pupil_left_13.scale.set(1, 1, 1);
  if (endpoint_eye_pupil_left_13) {
    node_eye_pupil_left_13.position.copy(endpoint_eye_pupil_left_13.start);
    node_eye_pupil_left_13.rotation.set(0.0, 0.0, -0.03);
  } else {
    node_eye_pupil_left_13.position.set(-0.14, 0.12, 0.58);
    node_eye_pupil_left_13.rotation.set(0.0, 0.0, -0.03);
  }
  node_eye_pupil_left_13.userData.sculptComponent = {"id": "eye-pupil-left", "name": "Left Pupil", "level": "micro", "role": "detail", "importance": 0.7, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "assembled-solid", "topologyRationale": "Left Pupil uses assembled-solid topology based on its observed rounded or cloth silhouette.", "geometryDescriptor": {"topologyIntent": "stylized rounded part", "edgeTreatment": {"type": "soft", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": {"parentId": "root", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.02], "contactType": "overlap", "overlap": 0.025, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.072, "height": 0.105, "depth": 0.03, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.14, 0.12, 0.58], "rotation": [0, 0, -0.03], "scale": [0.072, 0.105, 0.03]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "eye-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "eye"}}, "material": "eye-pupil", "materialLayers": ["eye-pupil"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["dark-pupil"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(40, 21, 15, 1.0)", "secondaryAlbedo": "rgba(74, 42, 28, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.72, "notes": "Exact albedo hex values live in the linked material; the RGBA placeholders are validator evidence only."}};
  node_eye_pupil_left_13.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "eye-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "eye"}};
  (nodes["root"] ?? root).add(node_eye_pupil_left_13);
  nodes["eye-pupil-left"] = node_eye_pupil_left_13;
  const mesh_eye_pupil_left_13Geometry = endpoint_eye_pupil_left_13
    ? new THREE.CylinderGeometry(endpoint_eye_pupil_left_13.endRadius, endpoint_eye_pupil_left_13.baseRadius, endpoint_eye_pupil_left_13.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_eye_pupil_left_13) {
    mesh_eye_pupil_left_13Geometry.scale(0.072, 0.105, 0.03);
  }
  const mesh_eye_pupil_left_13 = new THREE.Mesh(
    mesh_eye_pupil_left_13Geometry,
    materialMap["eye-pupil"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_eye_pupil_left_13.name = "Left Pupil";
  if (endpoint_eye_pupil_left_13) {
    mesh_eye_pupil_left_13.position.copy(endpoint_eye_pupil_left_13.midpoint);
    mesh_eye_pupil_left_13.quaternion.copy(endpoint_eye_pupil_left_13.quaternion);
  }
  mesh_eye_pupil_left_13.castShadow = options.castShadow ?? true;
  mesh_eye_pupil_left_13.receiveShadow = options.receiveShadow ?? true;
  mesh_eye_pupil_left_13.userData.sculptComponent = {"id": "eye-pupil-left", "name": "Left Pupil", "level": "micro", "role": "detail", "importance": 0.7, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "assembled-solid", "topologyRationale": "Left Pupil uses assembled-solid topology based on its observed rounded or cloth silhouette.", "geometryDescriptor": {"topologyIntent": "stylized rounded part", "edgeTreatment": {"type": "soft", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": {"parentId": "root", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.02], "contactType": "overlap", "overlap": 0.025, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.072, "height": 0.105, "depth": 0.03, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.14, 0.12, 0.58], "rotation": [0, 0, -0.03], "scale": [0.072, 0.105, 0.03]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "eye-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "eye"}}, "material": "eye-pupil", "materialLayers": ["eye-pupil"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["dark-pupil"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(40, 21, 15, 1.0)", "secondaryAlbedo": "rgba(74, 42, 28, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.72, "notes": "Exact albedo hex values live in the linked material; the RGBA placeholders are validator evidence only."}};
  node_eye_pupil_left_13.add(mesh_eye_pupil_left_13);
  meshes["eye-pupil-left"] = mesh_eye_pupil_left_13;
  colliders["eye-pupil-left"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["eye-l"] ??= [];
  destructionGroups["eye-l"].push(node_eye_pupil_left_13);

  const endpoint_eye_pupil_right_14 = makeAttachmentEndpoint(null);
  const node_eye_pupil_right_14 = new THREE.Group();
  node_eye_pupil_right_14.name = "Right Pupil__pivot";
  node_eye_pupil_right_14.scale.set(1, 1, 1);
  if (endpoint_eye_pupil_right_14) {
    node_eye_pupil_right_14.position.copy(endpoint_eye_pupil_right_14.start);
    node_eye_pupil_right_14.rotation.set(0.0, 0.0, 0.05);
  } else {
    node_eye_pupil_right_14.position.set(0.17, 0.09, 0.6);
    node_eye_pupil_right_14.rotation.set(0.0, 0.0, 0.05);
  }
  node_eye_pupil_right_14.userData.sculptComponent = {"id": "eye-pupil-right", "name": "Right Pupil", "level": "micro", "role": "detail", "importance": 0.7, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "assembled-solid", "topologyRationale": "Right Pupil uses assembled-solid topology based on its observed rounded or cloth silhouette.", "geometryDescriptor": {"topologyIntent": "stylized rounded part", "edgeTreatment": {"type": "soft", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": {"parentId": "root", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.02], "contactType": "overlap", "overlap": 0.025, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.078, "height": 0.115, "depth": 0.032, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.17, 0.09, 0.6], "rotation": [0, 0, 0.05], "scale": [0.078, 0.115, 0.032]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "eye-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "eye"}}, "material": "eye-pupil", "materialLayers": ["eye-pupil"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["dark-pupil"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(40, 21, 15, 1.0)", "secondaryAlbedo": "rgba(74, 42, 28, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.72, "notes": "Exact albedo hex values live in the linked material; the RGBA placeholders are validator evidence only."}};
  node_eye_pupil_right_14.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "eye-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "eye"}};
  (nodes["root"] ?? root).add(node_eye_pupil_right_14);
  nodes["eye-pupil-right"] = node_eye_pupil_right_14;
  const mesh_eye_pupil_right_14Geometry = endpoint_eye_pupil_right_14
    ? new THREE.CylinderGeometry(endpoint_eye_pupil_right_14.endRadius, endpoint_eye_pupil_right_14.baseRadius, endpoint_eye_pupil_right_14.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_eye_pupil_right_14) {
    mesh_eye_pupil_right_14Geometry.scale(0.078, 0.115, 0.032);
  }
  const mesh_eye_pupil_right_14 = new THREE.Mesh(
    mesh_eye_pupil_right_14Geometry,
    materialMap["eye-pupil"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_eye_pupil_right_14.name = "Right Pupil";
  if (endpoint_eye_pupil_right_14) {
    mesh_eye_pupil_right_14.position.copy(endpoint_eye_pupil_right_14.midpoint);
    mesh_eye_pupil_right_14.quaternion.copy(endpoint_eye_pupil_right_14.quaternion);
  }
  mesh_eye_pupil_right_14.castShadow = options.castShadow ?? true;
  mesh_eye_pupil_right_14.receiveShadow = options.receiveShadow ?? true;
  mesh_eye_pupil_right_14.userData.sculptComponent = {"id": "eye-pupil-right", "name": "Right Pupil", "level": "micro", "role": "detail", "importance": 0.7, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "assembled-solid", "topologyRationale": "Right Pupil uses assembled-solid topology based on its observed rounded or cloth silhouette.", "geometryDescriptor": {"topologyIntent": "stylized rounded part", "edgeTreatment": {"type": "soft", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": {"parentId": "root", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.02], "contactType": "overlap", "overlap": 0.025, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.078, "height": 0.115, "depth": 0.032, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.17, 0.09, 0.6], "rotation": [0, 0, 0.05], "scale": [0.078, 0.115, 0.032]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "eye-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "eye"}}, "material": "eye-pupil", "materialLayers": ["eye-pupil"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["dark-pupil"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(40, 21, 15, 1.0)", "secondaryAlbedo": "rgba(74, 42, 28, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.72, "notes": "Exact albedo hex values live in the linked material; the RGBA placeholders are validator evidence only."}};
  node_eye_pupil_right_14.add(mesh_eye_pupil_right_14);
  meshes["eye-pupil-right"] = mesh_eye_pupil_right_14;
  colliders["eye-pupil-right"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["eye-l"] ??= [];
  destructionGroups["eye-l"].push(node_eye_pupil_right_14);

  const endpoint_eye_highlight_left_15 = makeAttachmentEndpoint(null);
  const node_eye_highlight_left_15 = new THREE.Group();
  node_eye_highlight_left_15.name = "Left Eye Catchlight__pivot";
  node_eye_highlight_left_15.scale.set(1, 1, 1);
  if (endpoint_eye_highlight_left_15) {
    node_eye_highlight_left_15.position.copy(endpoint_eye_highlight_left_15.start);
    node_eye_highlight_left_15.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_eye_highlight_left_15.position.set(-0.18, 0.18, 0.606);
    node_eye_highlight_left_15.rotation.set(0.0, 0.0, 0.0);
  }
  node_eye_highlight_left_15.userData.sculptComponent = {"id": "eye-highlight-left", "name": "Left Eye Catchlight", "level": "micro", "role": "detail", "importance": 0.7, "confidence": 0.8, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Left Eye Catchlight uses assembled-solid topology based on its observed rounded or cloth silhouette.", "geometryDescriptor": {"topologyIntent": "stylized rounded part", "edgeTreatment": {"type": "soft", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": {"parentId": "root", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.02], "contactType": "overlap", "overlap": 0.025, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.035, "height": 0.045, "depth": 0.025, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.18, 0.18, 0.606], "rotation": [0, 0, 0], "scale": [0.035, 0.045, 0.025]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "eye-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "eye"}}, "material": "eye-sclera", "materialLayers": ["eye-sclera"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["bright-catchlight"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 240, 215, 1.0)", "secondaryAlbedo": "rgba(245, 221, 182, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.72, "notes": "Exact albedo hex values live in the linked material; the RGBA placeholders are validator evidence only."}};
  node_eye_highlight_left_15.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "eye-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "eye"}};
  (nodes["root"] ?? root).add(node_eye_highlight_left_15);
  nodes["eye-highlight-left"] = node_eye_highlight_left_15;
  const mesh_eye_highlight_left_15Geometry = endpoint_eye_highlight_left_15
    ? new THREE.CylinderGeometry(endpoint_eye_highlight_left_15.endRadius, endpoint_eye_highlight_left_15.baseRadius, endpoint_eye_highlight_left_15.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_eye_highlight_left_15) {
    mesh_eye_highlight_left_15Geometry.scale(0.035, 0.045, 0.025);
  }
  const mesh_eye_highlight_left_15 = new THREE.Mesh(
    mesh_eye_highlight_left_15Geometry,
    materialMap["eye-sclera"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_eye_highlight_left_15.name = "Left Eye Catchlight";
  if (endpoint_eye_highlight_left_15) {
    mesh_eye_highlight_left_15.position.copy(endpoint_eye_highlight_left_15.midpoint);
    mesh_eye_highlight_left_15.quaternion.copy(endpoint_eye_highlight_left_15.quaternion);
  }
  mesh_eye_highlight_left_15.castShadow = options.castShadow ?? true;
  mesh_eye_highlight_left_15.receiveShadow = options.receiveShadow ?? true;
  mesh_eye_highlight_left_15.userData.sculptComponent = {"id": "eye-highlight-left", "name": "Left Eye Catchlight", "level": "micro", "role": "detail", "importance": 0.7, "confidence": 0.8, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Left Eye Catchlight uses assembled-solid topology based on its observed rounded or cloth silhouette.", "geometryDescriptor": {"topologyIntent": "stylized rounded part", "edgeTreatment": {"type": "soft", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": {"parentId": "root", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.02], "contactType": "overlap", "overlap": 0.025, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.035, "height": 0.045, "depth": 0.025, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.18, 0.18, 0.606], "rotation": [0, 0, 0], "scale": [0.035, 0.045, 0.025]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "eye-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "eye"}}, "material": "eye-sclera", "materialLayers": ["eye-sclera"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["bright-catchlight"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 240, 215, 1.0)", "secondaryAlbedo": "rgba(245, 221, 182, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.72, "notes": "Exact albedo hex values live in the linked material; the RGBA placeholders are validator evidence only."}};
  node_eye_highlight_left_15.add(mesh_eye_highlight_left_15);
  meshes["eye-highlight-left"] = mesh_eye_highlight_left_15;
  colliders["eye-highlight-left"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["eye-l"] ??= [];
  destructionGroups["eye-l"].push(node_eye_highlight_left_15);

  const endpoint_eye_highlight_right_16 = makeAttachmentEndpoint(null);
  const node_eye_highlight_right_16 = new THREE.Group();
  node_eye_highlight_right_16.name = "Right Eye Catchlight__pivot";
  node_eye_highlight_right_16.scale.set(1, 1, 1);
  if (endpoint_eye_highlight_right_16) {
    node_eye_highlight_right_16.position.copy(endpoint_eye_highlight_right_16.start);
    node_eye_highlight_right_16.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_eye_highlight_right_16.position.set(0.14, 0.15, 0.63);
    node_eye_highlight_right_16.rotation.set(0.0, 0.0, 0.0);
  }
  node_eye_highlight_right_16.userData.sculptComponent = {"id": "eye-highlight-right", "name": "Right Eye Catchlight", "level": "micro", "role": "detail", "importance": 0.7, "confidence": 0.8, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Right Eye Catchlight uses assembled-solid topology based on its observed rounded or cloth silhouette.", "geometryDescriptor": {"topologyIntent": "stylized rounded part", "edgeTreatment": {"type": "soft", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": {"parentId": "root", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.02], "contactType": "overlap", "overlap": 0.025, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.038, "height": 0.048, "depth": 0.026, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.14, 0.15, 0.63], "rotation": [0, 0, 0], "scale": [0.038, 0.048, 0.026]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "eye-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "eye"}}, "material": "eye-sclera", "materialLayers": ["eye-sclera"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["bright-catchlight"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 240, 215, 1.0)", "secondaryAlbedo": "rgba(245, 221, 182, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.72, "notes": "Exact albedo hex values live in the linked material; the RGBA placeholders are validator evidence only."}};
  node_eye_highlight_right_16.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "eye-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "eye"}};
  (nodes["root"] ?? root).add(node_eye_highlight_right_16);
  nodes["eye-highlight-right"] = node_eye_highlight_right_16;
  const mesh_eye_highlight_right_16Geometry = endpoint_eye_highlight_right_16
    ? new THREE.CylinderGeometry(endpoint_eye_highlight_right_16.endRadius, endpoint_eye_highlight_right_16.baseRadius, endpoint_eye_highlight_right_16.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_eye_highlight_right_16) {
    mesh_eye_highlight_right_16Geometry.scale(0.038, 0.048, 0.026);
  }
  const mesh_eye_highlight_right_16 = new THREE.Mesh(
    mesh_eye_highlight_right_16Geometry,
    materialMap["eye-sclera"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_eye_highlight_right_16.name = "Right Eye Catchlight";
  if (endpoint_eye_highlight_right_16) {
    mesh_eye_highlight_right_16.position.copy(endpoint_eye_highlight_right_16.midpoint);
    mesh_eye_highlight_right_16.quaternion.copy(endpoint_eye_highlight_right_16.quaternion);
  }
  mesh_eye_highlight_right_16.castShadow = options.castShadow ?? true;
  mesh_eye_highlight_right_16.receiveShadow = options.receiveShadow ?? true;
  mesh_eye_highlight_right_16.userData.sculptComponent = {"id": "eye-highlight-right", "name": "Right Eye Catchlight", "level": "micro", "role": "detail", "importance": 0.7, "confidence": 0.8, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Right Eye Catchlight uses assembled-solid topology based on its observed rounded or cloth silhouette.", "geometryDescriptor": {"topologyIntent": "stylized rounded part", "edgeTreatment": {"type": "soft", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": {"parentId": "root", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.02], "contactType": "overlap", "overlap": 0.025, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.038, "height": 0.048, "depth": 0.026, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.14, 0.15, 0.63], "rotation": [0, 0, 0], "scale": [0.038, 0.048, 0.026]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "eye-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "eye"}}, "material": "eye-sclera", "materialLayers": ["eye-sclera"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["bright-catchlight"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 240, 215, 1.0)", "secondaryAlbedo": "rgba(245, 221, 182, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.72, "notes": "Exact albedo hex values live in the linked material; the RGBA placeholders are validator evidence only."}};
  node_eye_highlight_right_16.add(mesh_eye_highlight_right_16);
  meshes["eye-highlight-right"] = mesh_eye_highlight_right_16;
  colliders["eye-highlight-right"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["eye-l"] ??= [];
  destructionGroups["eye-l"].push(node_eye_highlight_right_16);

  const endpoint_brow_left_17 = makeAttachmentEndpoint(null);
  const node_brow_left_17 = new THREE.Group();
  node_brow_left_17.name = "Left Soft Brow__pivot";
  node_brow_left_17.scale.set(1, 1, 1);
  if (endpoint_brow_left_17) {
    node_brow_left_17.position.copy(endpoint_brow_left_17.start);
    node_brow_left_17.rotation.set(0.0, 0.0, -0.22);
  } else {
    node_brow_left_17.position.set(-0.16, 0.34, 0.47);
    node_brow_left_17.rotation.set(0.0, 0.0, -0.22);
  }
  node_brow_left_17.userData.sculptComponent = {"id": "brow-left", "name": "Left Soft Brow", "level": "micro", "role": "detail", "importance": 0.7, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "assembled-solid", "topologyRationale": "Left Soft Brow uses assembled-solid topology based on its observed rounded or cloth silhouette.", "geometryDescriptor": {"topologyIntent": "stylized rounded part", "edgeTreatment": {"type": "soft", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": {"parentId": "root", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.02], "contactType": "overlap", "overlap": 0.025, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.13, "height": 0.025, "depth": 0.025, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.16, 0.34, 0.47], "rotation": [0, 0, -0.22], "scale": [0.13, 0.025, 0.025]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "brow-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}}, "material": "face-line", "materialLayers": ["face-line"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["soft-curved-brow"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(44, 27, 21, 1.0)", "secondaryAlbedo": "rgba(75, 48, 37, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.72, "notes": "Exact albedo hex values live in the linked material; the RGBA placeholders are validator evidence only."}};
  node_brow_left_17.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "brow-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}};
  (nodes["root"] ?? root).add(node_brow_left_17);
  nodes["brow-left"] = node_brow_left_17;
  const mesh_brow_left_17Geometry = endpoint_brow_left_17
    ? new THREE.CylinderGeometry(endpoint_brow_left_17.endRadius, endpoint_brow_left_17.baseRadius, endpoint_brow_left_17.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_brow_left_17) {
    mesh_brow_left_17Geometry.scale(0.13, 0.025, 0.025);
  }
  const mesh_brow_left_17 = new THREE.Mesh(
    mesh_brow_left_17Geometry,
    materialMap["face-line"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_brow_left_17.name = "Left Soft Brow";
  if (endpoint_brow_left_17) {
    mesh_brow_left_17.position.copy(endpoint_brow_left_17.midpoint);
    mesh_brow_left_17.quaternion.copy(endpoint_brow_left_17.quaternion);
  }
  mesh_brow_left_17.castShadow = options.castShadow ?? true;
  mesh_brow_left_17.receiveShadow = options.receiveShadow ?? true;
  mesh_brow_left_17.userData.sculptComponent = {"id": "brow-left", "name": "Left Soft Brow", "level": "micro", "role": "detail", "importance": 0.7, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "assembled-solid", "topologyRationale": "Left Soft Brow uses assembled-solid topology based on its observed rounded or cloth silhouette.", "geometryDescriptor": {"topologyIntent": "stylized rounded part", "edgeTreatment": {"type": "soft", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": {"parentId": "root", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.02], "contactType": "overlap", "overlap": 0.025, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.13, "height": 0.025, "depth": 0.025, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.16, 0.34, 0.47], "rotation": [0, 0, -0.22], "scale": [0.13, 0.025, 0.025]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "brow-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}}, "material": "face-line", "materialLayers": ["face-line"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["soft-curved-brow"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(44, 27, 21, 1.0)", "secondaryAlbedo": "rgba(75, 48, 37, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.72, "notes": "Exact albedo hex values live in the linked material; the RGBA placeholders are validator evidence only."}};
  node_brow_left_17.add(mesh_brow_left_17);
  meshes["brow-left"] = mesh_brow_left_17;
  colliders["brow-left"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["brow-l"] ??= [];
  destructionGroups["brow-l"].push(node_brow_left_17);

  const endpoint_brow_right_18 = makeAttachmentEndpoint(null);
  const node_brow_right_18 = new THREE.Group();
  node_brow_right_18.name = "Right Soft Brow__pivot";
  node_brow_right_18.scale.set(1, 1, 1);
  if (endpoint_brow_right_18) {
    node_brow_right_18.position.copy(endpoint_brow_right_18.start);
    node_brow_right_18.rotation.set(0.0, 0.0, 0.15);
  } else {
    node_brow_right_18.position.set(0.15, 0.32, 0.48);
    node_brow_right_18.rotation.set(0.0, 0.0, 0.15);
  }
  node_brow_right_18.userData.sculptComponent = {"id": "brow-right", "name": "Right Soft Brow", "level": "micro", "role": "detail", "importance": 0.7, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "assembled-solid", "topologyRationale": "Right Soft Brow uses assembled-solid topology based on its observed rounded or cloth silhouette.", "geometryDescriptor": {"topologyIntent": "stylized rounded part", "edgeTreatment": {"type": "soft", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": {"parentId": "root", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.02], "contactType": "overlap", "overlap": 0.025, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.13, "height": 0.025, "depth": 0.025, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.15, 0.32, 0.48], "rotation": [0, 0, 0.15], "scale": [0.13, 0.025, 0.025]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "brow-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}}, "material": "face-line", "materialLayers": ["face-line"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["soft-curved-brow"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(44, 27, 21, 1.0)", "secondaryAlbedo": "rgba(75, 48, 37, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.72, "notes": "Exact albedo hex values live in the linked material; the RGBA placeholders are validator evidence only."}};
  node_brow_right_18.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "brow-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}};
  (nodes["root"] ?? root).add(node_brow_right_18);
  nodes["brow-right"] = node_brow_right_18;
  const mesh_brow_right_18Geometry = endpoint_brow_right_18
    ? new THREE.CylinderGeometry(endpoint_brow_right_18.endRadius, endpoint_brow_right_18.baseRadius, endpoint_brow_right_18.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_brow_right_18) {
    mesh_brow_right_18Geometry.scale(0.13, 0.025, 0.025);
  }
  const mesh_brow_right_18 = new THREE.Mesh(
    mesh_brow_right_18Geometry,
    materialMap["face-line"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_brow_right_18.name = "Right Soft Brow";
  if (endpoint_brow_right_18) {
    mesh_brow_right_18.position.copy(endpoint_brow_right_18.midpoint);
    mesh_brow_right_18.quaternion.copy(endpoint_brow_right_18.quaternion);
  }
  mesh_brow_right_18.castShadow = options.castShadow ?? true;
  mesh_brow_right_18.receiveShadow = options.receiveShadow ?? true;
  mesh_brow_right_18.userData.sculptComponent = {"id": "brow-right", "name": "Right Soft Brow", "level": "micro", "role": "detail", "importance": 0.7, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "assembled-solid", "topologyRationale": "Right Soft Brow uses assembled-solid topology based on its observed rounded or cloth silhouette.", "geometryDescriptor": {"topologyIntent": "stylized rounded part", "edgeTreatment": {"type": "soft", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": {"parentId": "root", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.02], "contactType": "overlap", "overlap": 0.025, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.13, "height": 0.025, "depth": 0.025, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.15, 0.32, 0.48], "rotation": [0, 0, 0.15], "scale": [0.13, 0.025, 0.025]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "brow-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}}, "material": "face-line", "materialLayers": ["face-line"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["soft-curved-brow"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(44, 27, 21, 1.0)", "secondaryAlbedo": "rgba(75, 48, 37, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.72, "notes": "Exact albedo hex values live in the linked material; the RGBA placeholders are validator evidence only."}};
  node_brow_right_18.add(mesh_brow_right_18);
  meshes["brow-right"] = mesh_brow_right_18;
  colliders["brow-right"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["brow-l"] ??= [];
  destructionGroups["brow-l"].push(node_brow_right_18);

  const endpoint_mouth_smile_19 = makeAttachmentEndpoint(null);
  const node_mouth_smile_19 = new THREE.Group();
  node_mouth_smile_19.name = "Small Smile__pivot";
  node_mouth_smile_19.scale.set(1, 1, 1);
  if (endpoint_mouth_smile_19) {
    node_mouth_smile_19.position.copy(endpoint_mouth_smile_19.start);
    node_mouth_smile_19.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_mouth_smile_19.position.set(0.0, -0.06, 0.54);
    node_mouth_smile_19.rotation.set(0.0, 0.0, 0.0);
  }
  node_mouth_smile_19.userData.sculptComponent = {"id": "mouth-smile", "name": "Small Smile", "level": "micro", "role": "detail", "importance": 0.7, "confidence": 0.8, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Extruded curved profile with nonzero depth; not a zero-thickness membrane.", "geometryDescriptor": {"topologyIntent": "cloth panel with shallow depth", "edgeTreatment": {"type": "soft", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "profile2D": {"points": [[-0.5, 0.12], [-0.25, -0.12], [0, -0.22], [0.25, -0.12], [0.5, 0.12], [0.28, 0.02], [0, -0.04], [-0.28, 0.02]], "depth": 0.05}}, "parent": "root", "attachment": {"parentId": "root", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.02], "contactType": "overlap", "overlap": 0.025, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.12, "height": 0.085, "depth": 0.3, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, -0.06, 0.54], "rotation": [0, 0, 0], "scale": [0.12, 0.085, 0.3]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "mouth", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "lips"}}, "material": "face-line", "materialLayers": ["face-line"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["small-friendly-smile"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(44, 27, 21, 1.0)", "secondaryAlbedo": "rgba(75, 48, 37, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.72, "notes": "Exact albedo hex values live in the linked material; the RGBA placeholders are validator evidence only."}};
  node_mouth_smile_19.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "mouth", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "lips"}};
  (nodes["root"] ?? root).add(node_mouth_smile_19);
  nodes["mouth-smile"] = node_mouth_smile_19;
  const mesh_mouth_smile_19Geometry = endpoint_mouth_smile_19
    ? new THREE.CylinderGeometry(endpoint_mouth_smile_19.endRadius, endpoint_mouth_smile_19.baseRadius, endpoint_mouth_smile_19.length, 16, 6)
    : buildExtrudeGeometry({"points": [[-0.5, 0.12], [-0.25, -0.12], [0, -0.22], [0.25, -0.12], [0.5, 0.12], [0.28, 0.02], [0, -0.04], [-0.28, 0.02]], "depth": 0.05});
  if (!endpoint_mouth_smile_19) {
    mesh_mouth_smile_19Geometry.scale(0.12, 0.085, 0.3);
  }
  const mesh_mouth_smile_19 = new THREE.Mesh(
    mesh_mouth_smile_19Geometry,
    materialMap["face-line"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_mouth_smile_19.name = "Small Smile";
  if (endpoint_mouth_smile_19) {
    mesh_mouth_smile_19.position.copy(endpoint_mouth_smile_19.midpoint);
    mesh_mouth_smile_19.quaternion.copy(endpoint_mouth_smile_19.quaternion);
  }
  mesh_mouth_smile_19.castShadow = options.castShadow ?? true;
  mesh_mouth_smile_19.receiveShadow = options.receiveShadow ?? true;
  mesh_mouth_smile_19.userData.sculptComponent = {"id": "mouth-smile", "name": "Small Smile", "level": "micro", "role": "detail", "importance": 0.7, "confidence": 0.8, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Extruded curved profile with nonzero depth; not a zero-thickness membrane.", "geometryDescriptor": {"topologyIntent": "cloth panel with shallow depth", "edgeTreatment": {"type": "soft", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "profile2D": {"points": [[-0.5, 0.12], [-0.25, -0.12], [0, -0.22], [0.25, -0.12], [0.5, 0.12], [0.28, 0.02], [0, -0.04], [-0.28, 0.02]], "depth": 0.05}}, "parent": "root", "attachment": {"parentId": "root", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.02], "contactType": "overlap", "overlap": 0.025, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.12, "height": 0.085, "depth": 0.3, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, -0.06, 0.54], "rotation": [0, 0, 0], "scale": [0.12, 0.085, 0.3]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "mouth", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "lips"}}, "material": "face-line", "materialLayers": ["face-line"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["small-friendly-smile"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(44, 27, 21, 1.0)", "secondaryAlbedo": "rgba(75, 48, 37, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.72, "notes": "Exact albedo hex values live in the linked material; the RGBA placeholders are validator evidence only."}};
  node_mouth_smile_19.add(mesh_mouth_smile_19);
  meshes["mouth-smile"] = mesh_mouth_smile_19;
  colliders["mouth-smile"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["mouth"] ??= [];
  destructionGroups["mouth"].push(node_mouth_smile_19);

  const endpoint_scarf_wrap_20 = makeAttachmentEndpoint(null);
  const node_scarf_wrap_20 = new THREE.Group();
  node_scarf_wrap_20.name = "Scarf Wrap__pivot";
  node_scarf_wrap_20.scale.set(1, 1, 1);
  if (endpoint_scarf_wrap_20) {
    node_scarf_wrap_20.position.copy(endpoint_scarf_wrap_20.start);
    node_scarf_wrap_20.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_scarf_wrap_20.position.set(0.0, -0.17, 0.02);
    node_scarf_wrap_20.rotation.set(0.0, 0.0, 0.0);
  }
  node_scarf_wrap_20.userData.sculptComponent = {"id": "scarf-wrap", "name": "Scarf Wrap", "level": "macro", "role": "detail", "importance": 1.0, "confidence": 0.8, "primitive": "torus", "topologyClass": "conforming-shell", "topologyRationale": "Scarf Wrap uses conforming-shell topology based on its observed rounded or cloth silhouette.", "geometryDescriptor": {"topologyIntent": "stylized rounded part", "edgeTreatment": {"type": "soft", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "torusTubeRatio": 0.34}, "parent": "root", "attachment": {"parentId": "root", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.02], "contactType": "overlap", "overlap": 0.025, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.78, "height": 0.3, "depth": 0.59, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, -0.17, 0.02], "rotation": [0, 0, 0], "scale": [0.78, 0.3, 0.59]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "shirt"}}, "material": "scarf-teal", "materialLayers": ["scarf-teal"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["scarf-wrap-band", "high-contrast-teal"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(37, 191, 167, 1.0)", "secondaryAlbedo": "rgba(117, 225, 206, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.72, "notes": "Exact albedo hex values live in the linked material; the RGBA placeholders are validator evidence only."}};
  node_scarf_wrap_20.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "shirt"}};
  (nodes["root"] ?? root).add(node_scarf_wrap_20);
  nodes["scarf-wrap"] = node_scarf_wrap_20;
  const mesh_scarf_wrap_20Geometry = endpoint_scarf_wrap_20
    ? new THREE.CylinderGeometry(endpoint_scarf_wrap_20.endRadius, endpoint_scarf_wrap_20.baseRadius, endpoint_scarf_wrap_20.length, 16, 6)
    : new THREE.TorusGeometry(0.45, 0.153, 12, 48);
  if (!endpoint_scarf_wrap_20) {
    mesh_scarf_wrap_20Geometry.scale(0.78, 0.3, 0.59);
  }
  const mesh_scarf_wrap_20 = new THREE.Mesh(
    mesh_scarf_wrap_20Geometry,
    materialMap["scarf-teal"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_scarf_wrap_20.name = "Scarf Wrap";
  if (endpoint_scarf_wrap_20) {
    mesh_scarf_wrap_20.position.copy(endpoint_scarf_wrap_20.midpoint);
    mesh_scarf_wrap_20.quaternion.copy(endpoint_scarf_wrap_20.quaternion);
  }
  mesh_scarf_wrap_20.castShadow = options.castShadow ?? true;
  mesh_scarf_wrap_20.receiveShadow = options.receiveShadow ?? true;
  mesh_scarf_wrap_20.userData.sculptComponent = {"id": "scarf-wrap", "name": "Scarf Wrap", "level": "macro", "role": "detail", "importance": 1.0, "confidence": 0.8, "primitive": "torus", "topologyClass": "conforming-shell", "topologyRationale": "Scarf Wrap uses conforming-shell topology based on its observed rounded or cloth silhouette.", "geometryDescriptor": {"topologyIntent": "stylized rounded part", "edgeTreatment": {"type": "soft", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "torusTubeRatio": 0.34}, "parent": "root", "attachment": {"parentId": "root", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.02], "contactType": "overlap", "overlap": 0.025, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.78, "height": 0.3, "depth": 0.59, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, -0.17, 0.02], "rotation": [0, 0, 0], "scale": [0.78, 0.3, 0.59]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "shirt"}}, "material": "scarf-teal", "materialLayers": ["scarf-teal"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["scarf-wrap-band", "high-contrast-teal"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(37, 191, 167, 1.0)", "secondaryAlbedo": "rgba(117, 225, 206, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.72, "notes": "Exact albedo hex values live in the linked material; the RGBA placeholders are validator evidence only."}};
  node_scarf_wrap_20.add(mesh_scarf_wrap_20);
  meshes["scarf-wrap"] = mesh_scarf_wrap_20;
  colliders["scarf-wrap"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["chest"] ??= [];
  destructionGroups["chest"].push(node_scarf_wrap_20);

  const endpoint_scarf_front_21 = makeAttachmentEndpoint(null);
  const node_scarf_front_21 = new THREE.Group();
  node_scarf_front_21.name = "Scarf Front Fold__pivot";
  node_scarf_front_21.scale.set(1, 1, 1);
  if (endpoint_scarf_front_21) {
    node_scarf_front_21.position.copy(endpoint_scarf_front_21.start);
    node_scarf_front_21.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_scarf_front_21.position.set(0.0, -0.18, 0.48);
    node_scarf_front_21.rotation.set(0.0, 0.0, 0.0);
  }
  node_scarf_front_21.userData.sculptComponent = {"id": "scarf-front", "name": "Scarf Front Fold", "level": "meso", "role": "detail", "importance": 0.85, "confidence": 0.8, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Extruded curved profile with nonzero depth; not a zero-thickness membrane.", "geometryDescriptor": {"topologyIntent": "cloth panel with shallow depth", "edgeTreatment": {"type": "soft", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "profile2D": {"points": [[-0.48, 0.36], [-0.38, -0.25], [0, -0.5], [0.38, -0.25], [0.48, 0.36], [0.08, 0.15], [-0.1, 0.15]], "depth": 0.05}}, "parent": "root", "attachment": {"parentId": "root", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.02], "contactType": "overlap", "overlap": 0.025, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.66, "height": 0.29, "depth": 0.18, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, -0.18, 0.48], "rotation": [0, 0, 0], "scale": [0.66, 0.29, 0.18]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "shirt"}}, "material": "scarf-teal", "materialLayers": ["scarf-teal"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["scarf-contrast-folds", "front-wrap-overlap"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(37, 191, 167, 1.0)", "secondaryAlbedo": "rgba(117, 225, 206, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.72, "notes": "Exact albedo hex values live in the linked material; the RGBA placeholders are validator evidence only."}};
  node_scarf_front_21.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "shirt"}};
  (nodes["root"] ?? root).add(node_scarf_front_21);
  nodes["scarf-front"] = node_scarf_front_21;
  const mesh_scarf_front_21Geometry = endpoint_scarf_front_21
    ? new THREE.CylinderGeometry(endpoint_scarf_front_21.endRadius, endpoint_scarf_front_21.baseRadius, endpoint_scarf_front_21.length, 16, 6)
    : buildExtrudeGeometry({"points": [[-0.48, 0.36], [-0.38, -0.25], [0, -0.5], [0.38, -0.25], [0.48, 0.36], [0.08, 0.15], [-0.1, 0.15]], "depth": 0.05});
  if (!endpoint_scarf_front_21) {
    mesh_scarf_front_21Geometry.scale(0.66, 0.29, 0.18);
  }
  const mesh_scarf_front_21 = new THREE.Mesh(
    mesh_scarf_front_21Geometry,
    materialMap["scarf-teal"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_scarf_front_21.name = "Scarf Front Fold";
  if (endpoint_scarf_front_21) {
    mesh_scarf_front_21.position.copy(endpoint_scarf_front_21.midpoint);
    mesh_scarf_front_21.quaternion.copy(endpoint_scarf_front_21.quaternion);
  }
  mesh_scarf_front_21.castShadow = options.castShadow ?? true;
  mesh_scarf_front_21.receiveShadow = options.receiveShadow ?? true;
  mesh_scarf_front_21.userData.sculptComponent = {"id": "scarf-front", "name": "Scarf Front Fold", "level": "meso", "role": "detail", "importance": 0.85, "confidence": 0.8, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Extruded curved profile with nonzero depth; not a zero-thickness membrane.", "geometryDescriptor": {"topologyIntent": "cloth panel with shallow depth", "edgeTreatment": {"type": "soft", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "profile2D": {"points": [[-0.48, 0.36], [-0.38, -0.25], [0, -0.5], [0.38, -0.25], [0.48, 0.36], [0.08, 0.15], [-0.1, 0.15]], "depth": 0.05}}, "parent": "root", "attachment": {"parentId": "root", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.02], "contactType": "overlap", "overlap": 0.025, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.66, "height": 0.29, "depth": 0.18, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, -0.18, 0.48], "rotation": [0, 0, 0], "scale": [0.66, 0.29, 0.18]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "shirt"}}, "material": "scarf-teal", "materialLayers": ["scarf-teal"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["scarf-contrast-folds", "front-wrap-overlap"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(37, 191, 167, 1.0)", "secondaryAlbedo": "rgba(117, 225, 206, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.72, "notes": "Exact albedo hex values live in the linked material; the RGBA placeholders are validator evidence only."}};
  node_scarf_front_21.add(mesh_scarf_front_21);
  meshes["scarf-front"] = mesh_scarf_front_21;
  colliders["scarf-front"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["chest"] ??= [];
  destructionGroups["chest"].push(node_scarf_front_21);

  const endpoint_scarf_tail_long_22 = makeAttachmentEndpoint(null);
  const node_scarf_tail_long_22 = new THREE.Group();
  node_scarf_tail_long_22.name = "Long Scarf Tail__pivot";
  node_scarf_tail_long_22.scale.set(1, 1, 1);
  if (endpoint_scarf_tail_long_22) {
    node_scarf_tail_long_22.position.copy(endpoint_scarf_tail_long_22.start);
    node_scarf_tail_long_22.rotation.set(0.0, 0.0, -0.12);
  } else {
    node_scarf_tail_long_22.position.set(0.23, -0.13, -0.13);
    node_scarf_tail_long_22.rotation.set(0.0, 0.0, -0.12);
  }
  node_scarf_tail_long_22.userData.sculptComponent = {"id": "scarf-tail-long", "name": "Long Scarf Tail", "level": "meso", "role": "detail", "importance": 0.85, "confidence": 0.8, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Extruded curved profile with nonzero depth; not a zero-thickness membrane.", "geometryDescriptor": {"topologyIntent": "cloth panel with shallow depth", "edgeTreatment": {"type": "soft", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "profile2D": {"points": [[-0.62, 0.25], [-0.1, 0.4], [0.58, 0.76], [0.94, 0.62], [0.78, -0.42], [0.34, -0.18], [-0.18, -0.28]], "depth": 0.08}}, "parent": "root", "attachment": {"parentId": "root", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.02], "contactType": "overlap", "overlap": 0.025, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.52, "height": 0.3, "depth": 0.16, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.23, -0.13, -0.13], "rotation": [0, 0, -0.12], "scale": [0.52, 0.3, 0.16]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "shirt"}}, "material": "scarf-teal", "materialLayers": ["scarf-teal"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["trailing-scarf-edge", "long-tapered-cloth-end"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(37, 191, 167, 1.0)", "secondaryAlbedo": "rgba(117, 225, 206, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.72, "notes": "Exact albedo hex values live in the linked material; the RGBA placeholders are validator evidence only."}};
  node_scarf_tail_long_22.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "shirt"}};
  (nodes["root"] ?? root).add(node_scarf_tail_long_22);
  nodes["scarf-tail-long"] = node_scarf_tail_long_22;
  const mesh_scarf_tail_long_22Geometry = endpoint_scarf_tail_long_22
    ? new THREE.CylinderGeometry(endpoint_scarf_tail_long_22.endRadius, endpoint_scarf_tail_long_22.baseRadius, endpoint_scarf_tail_long_22.length, 16, 6)
    : buildExtrudeGeometry({"points": [[-0.62, 0.25], [-0.1, 0.4], [0.58, 0.76], [0.94, 0.62], [0.78, -0.42], [0.34, -0.18], [-0.18, -0.28]], "depth": 0.08});
  if (!endpoint_scarf_tail_long_22) {
    mesh_scarf_tail_long_22Geometry.scale(0.52, 0.3, 0.16);
  }
  const mesh_scarf_tail_long_22 = new THREE.Mesh(
    mesh_scarf_tail_long_22Geometry,
    materialMap["scarf-teal"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_scarf_tail_long_22.name = "Long Scarf Tail";
  if (endpoint_scarf_tail_long_22) {
    mesh_scarf_tail_long_22.position.copy(endpoint_scarf_tail_long_22.midpoint);
    mesh_scarf_tail_long_22.quaternion.copy(endpoint_scarf_tail_long_22.quaternion);
  }
  mesh_scarf_tail_long_22.castShadow = options.castShadow ?? true;
  mesh_scarf_tail_long_22.receiveShadow = options.receiveShadow ?? true;
  mesh_scarf_tail_long_22.userData.sculptComponent = {"id": "scarf-tail-long", "name": "Long Scarf Tail", "level": "meso", "role": "detail", "importance": 0.85, "confidence": 0.8, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Extruded curved profile with nonzero depth; not a zero-thickness membrane.", "geometryDescriptor": {"topologyIntent": "cloth panel with shallow depth", "edgeTreatment": {"type": "soft", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "profile2D": {"points": [[-0.62, 0.25], [-0.1, 0.4], [0.58, 0.76], [0.94, 0.62], [0.78, -0.42], [0.34, -0.18], [-0.18, -0.28]], "depth": 0.08}}, "parent": "root", "attachment": {"parentId": "root", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.02], "contactType": "overlap", "overlap": 0.025, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.52, "height": 0.3, "depth": 0.16, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.23, -0.13, -0.13], "rotation": [0, 0, -0.12], "scale": [0.52, 0.3, 0.16]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "shirt"}}, "material": "scarf-teal", "materialLayers": ["scarf-teal"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["trailing-scarf-edge", "long-tapered-cloth-end"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(37, 191, 167, 1.0)", "secondaryAlbedo": "rgba(117, 225, 206, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.72, "notes": "Exact albedo hex values live in the linked material; the RGBA placeholders are validator evidence only."}};
  node_scarf_tail_long_22.add(mesh_scarf_tail_long_22);
  meshes["scarf-tail-long"] = mesh_scarf_tail_long_22;
  colliders["scarf-tail-long"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["chest"] ??= [];
  destructionGroups["chest"].push(node_scarf_tail_long_22);

  const endpoint_scarf_tail_short_23 = makeAttachmentEndpoint(null);
  const node_scarf_tail_short_23 = new THREE.Group();
  node_scarf_tail_short_23.name = "Short Scarf Tail__pivot";
  node_scarf_tail_short_23.scale.set(1, 1, 1);
  if (endpoint_scarf_tail_short_23) {
    node_scarf_tail_short_23.position.copy(endpoint_scarf_tail_short_23.start);
    node_scarf_tail_short_23.rotation.set(0.0, 0.0, 0.05);
  } else {
    node_scarf_tail_short_23.position.set(0.25, -0.26, -0.15);
    node_scarf_tail_short_23.rotation.set(0.0, 0.0, 0.05);
  }
  node_scarf_tail_short_23.userData.sculptComponent = {"id": "scarf-tail-short", "name": "Short Scarf Tail", "level": "meso", "role": "detail", "importance": 0.85, "confidence": 0.8, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Extruded curved profile with nonzero depth; not a zero-thickness membrane.", "geometryDescriptor": {"topologyIntent": "cloth panel with shallow depth", "edgeTreatment": {"type": "soft", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "profile2D": {"points": [[-0.56, 0.24], [-0.02, 0.36], [0.56, 0.58], [0.72, 0.25], [0.5, -0.4], [0.12, -0.2], [-0.34, -0.32]], "depth": 0.07}}, "parent": "root", "attachment": {"parentId": "root", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.02], "contactType": "overlap", "overlap": 0.025, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.4, "height": 0.23, "depth": 0.12, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.25, -0.26, -0.15], "rotation": [0, 0, 0.05], "scale": [0.4, 0.23, 0.12]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "shirt"}}, "material": "scarf-shadow", "materialLayers": ["scarf-shadow"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["second-scarf-end", "scarf-underfold"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(17, 125, 112, 1.0)", "secondaryAlbedo": "rgba(46, 169, 149, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.72, "notes": "Exact albedo hex values live in the linked material; the RGBA placeholders are validator evidence only."}};
  node_scarf_tail_short_23.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "shirt"}};
  (nodes["root"] ?? root).add(node_scarf_tail_short_23);
  nodes["scarf-tail-short"] = node_scarf_tail_short_23;
  const mesh_scarf_tail_short_23Geometry = endpoint_scarf_tail_short_23
    ? new THREE.CylinderGeometry(endpoint_scarf_tail_short_23.endRadius, endpoint_scarf_tail_short_23.baseRadius, endpoint_scarf_tail_short_23.length, 16, 6)
    : buildExtrudeGeometry({"points": [[-0.56, 0.24], [-0.02, 0.36], [0.56, 0.58], [0.72, 0.25], [0.5, -0.4], [0.12, -0.2], [-0.34, -0.32]], "depth": 0.07});
  if (!endpoint_scarf_tail_short_23) {
    mesh_scarf_tail_short_23Geometry.scale(0.4, 0.23, 0.12);
  }
  const mesh_scarf_tail_short_23 = new THREE.Mesh(
    mesh_scarf_tail_short_23Geometry,
    materialMap["scarf-shadow"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_scarf_tail_short_23.name = "Short Scarf Tail";
  if (endpoint_scarf_tail_short_23) {
    mesh_scarf_tail_short_23.position.copy(endpoint_scarf_tail_short_23.midpoint);
    mesh_scarf_tail_short_23.quaternion.copy(endpoint_scarf_tail_short_23.quaternion);
  }
  mesh_scarf_tail_short_23.castShadow = options.castShadow ?? true;
  mesh_scarf_tail_short_23.receiveShadow = options.receiveShadow ?? true;
  mesh_scarf_tail_short_23.userData.sculptComponent = {"id": "scarf-tail-short", "name": "Short Scarf Tail", "level": "meso", "role": "detail", "importance": 0.85, "confidence": 0.8, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Extruded curved profile with nonzero depth; not a zero-thickness membrane.", "geometryDescriptor": {"topologyIntent": "cloth panel with shallow depth", "edgeTreatment": {"type": "soft", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "profile2D": {"points": [[-0.56, 0.24], [-0.02, 0.36], [0.56, 0.58], [0.72, 0.25], [0.5, -0.4], [0.12, -0.2], [-0.34, -0.32]], "depth": 0.07}}, "parent": "root", "attachment": {"parentId": "root", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.02], "contactType": "overlap", "overlap": 0.025, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.4, "height": 0.23, "depth": 0.12, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.25, -0.26, -0.15], "rotation": [0, 0, 0.05], "scale": [0.4, 0.23, 0.12]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "shirt"}}, "material": "scarf-shadow", "materialLayers": ["scarf-shadow"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["second-scarf-end", "scarf-underfold"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(17, 125, 112, 1.0)", "secondaryAlbedo": "rgba(46, 169, 149, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.72, "notes": "Exact albedo hex values live in the linked material; the RGBA placeholders are validator evidence only."}};
  node_scarf_tail_short_23.add(mesh_scarf_tail_short_23);
  meshes["scarf-tail-short"] = mesh_scarf_tail_short_23;
  colliders["scarf-tail-short"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["chest"] ??= [];
  destructionGroups["chest"].push(node_scarf_tail_short_23);

  root.userData.sculptRuntime = { nodes, meshes, sockets, colliders, destructionGroups } satisfies ProceduralModelRuntime;
  root.userData.lookDevTargets = {"qualityPriority": "reference-fidelity", "materialPass": {"albedoPaletteRequired": true, "roughnessVariationRequired": true, "normalOrBumpRequired": false, "localOverridesRequired": true, "minimumTextureResolution": 256, "preferredTextureResolution": 512, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "requiredSurfaceFrequencyBands": ["macro", "meso", "micro"], "geometryReliefRequiredWhenSilhouetteAffected": true, "referencePbrExtraction": {"requiredWhenSourceImagePresent": false, "targetThreshold": 0.7, "stopOnLowConfidence": false, "script": "skipped", "acceptedLimitation": "Painterly generated illustration bakes highlights/shadows and is not a reliable PBR sample. Authored stylized materials with brighter scarf albedo are intentional."}, "mustAvoid": ["single flat albedo per material", "uniform roughness", "albedo texture reused as roughness/height/normal/AO", "single-frequency random noise", "plastic-looking smooth bark, stone, cloth, foliage, or aged material", "local color/detail described only in prose without material masks", "claiming exact PBR recovery when confidence is below the target threshold", "photoreal pores or dirty/noisy charcoal surface", "muted scarf that blends into the body"]}, "lightingPass": {"requiredTerms": ["key light", "fill light", "rim or environment light", "exposure", "tone mapping", "background", "contact shadow"], "mustAvoid": ["ambient-only lighting", "flat value range", "missing contact shadow", "reference lighting copied without separating material readability"]}, "screenshotReview": ["Compare albedo palette and local color zones.", "Compare roughness/normal/bump response under light.", "Compare cavity dirt, edge wear, stains, moss, scratches, or other local masks.", "Compare key/fill/rim structure, exposure, tone mapping, background, and contact shadows.", "Capture a neutral-light render to verify material readability without reference lighting.", "Capture a grazing-light close-up to expose flat normals, uniform roughness, tiling, and plastic highlights.", "Capture a reference-matched render from the same camera framing as the source."]};
  root.userData.actionReadiness = {
    note: 'Use root.userData.sculptRuntime.nodes for transforms, sockets for attachments, colliders for physics proxies, and destructionGroups for breakable sets.',
  };
  return root;
}

export function createXiaomotuanIPLookDevLights(
  mode: 'neutral' | 'grazing' | 'reference' = 'neutral',
): THREE.Group {
  const lights = new THREE.Group();
  lights.name = "Xiaomotuan IP look-dev lights";
  const hemi = new THREE.HemisphereLight(
    mode === 'reference' ? 0xfff0d6 : 0xf2f4ff,
    0x363b42,
    mode === 'grazing' ? 0.28 : mode === 'reference' ? 0.72 : 0.85,
  );
  lights.add(hemi);
  const key = new THREE.DirectionalLight(
    mode === 'reference' ? 0xffcf8a : 0xfff4e8,
    mode === 'grazing' ? 4.2 : mode === 'reference' ? 2.6 : 2.15,
  );
  if (mode === 'grazing') key.position.set(7.5, 1.1, 4.0);
  else if (mode === 'reference') key.position.set(-4.5, 7.5, 5.0);
  else key.position.set(-4.0, 6.0, 5.5);
  key.castShadow = true;
  key.shadow.mapSize.set(4096, 4096);
  key.shadow.bias = -0.00025;
  key.shadow.normalBias = 0.018;
  key.shadow.radius = 7;
  key.shadow.blurSamples = 24;
  key.shadow.camera.near = 0.5;
  key.shadow.camera.far = 30;
  key.shadow.camera.left = -2.6;
  key.shadow.camera.right = 2.6;
  key.shadow.camera.top = 2.6;
  key.shadow.camera.bottom = -2.6;
  key.shadow.camera.updateProjectionMatrix();
  lights.add(key);
  const fill = new THREE.DirectionalLight(0xa8c4ff, mode === 'grazing' ? 0.12 : 0.42);
  fill.position.set(4.0, 3.0, 3.5);
  lights.add(fill);
  const rim = new THREE.DirectionalLight(0xfff1c4, mode === 'grazing' ? 0.28 : 0.85);
  rim.position.set(0.5, 4.5, -6.0);
  lights.add(rim);
  lights.userData.reviewMode = mode;
  lights.userData.lightingFromPhoto = [{"id": "soft-key", "type": "key light", "positionHint": "upper-front-left", "intensity": 1.0, "notes": "Warm soft key; retain eye catchlights. Render with exposure 1.0 and ACES filmic tone mapping; retain a soft contact shadow under both feet with no transparent-edge halo."}, {"id": "warm-fill", "type": "fill light", "positionHint": "front-right", "intensity": 0.48, "notes": "Open shadows without flattening charcoal volume. Render with exposure 1.0 and ACES filmic tone mapping; retain a soft contact shadow under both feet with no transparent-edge halo."}, {"id": "teal-rim", "type": "rim light", "positionHint": "rear-side", "intensity": 0.35, "notes": "Soft narrow edge separation, no neon glow. Render with exposure 1.0 and ACES filmic tone mapping; retain a soft contact shadow under both feet with no transparent-edge halo."}];
  lights.userData.lookDevTargets = {"qualityPriority": "reference-fidelity", "materialPass": {"albedoPaletteRequired": true, "roughnessVariationRequired": true, "normalOrBumpRequired": false, "localOverridesRequired": true, "minimumTextureResolution": 256, "preferredTextureResolution": 512, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "requiredSurfaceFrequencyBands": ["macro", "meso", "micro"], "geometryReliefRequiredWhenSilhouetteAffected": true, "referencePbrExtraction": {"requiredWhenSourceImagePresent": false, "targetThreshold": 0.7, "stopOnLowConfidence": false, "script": "skipped", "acceptedLimitation": "Painterly generated illustration bakes highlights/shadows and is not a reliable PBR sample. Authored stylized materials with brighter scarf albedo are intentional."}, "mustAvoid": ["single flat albedo per material", "uniform roughness", "albedo texture reused as roughness/height/normal/AO", "single-frequency random noise", "plastic-looking smooth bark, stone, cloth, foliage, or aged material", "local color/detail described only in prose without material masks", "claiming exact PBR recovery when confidence is below the target threshold", "photoreal pores or dirty/noisy charcoal surface", "muted scarf that blends into the body"]}, "lightingPass": {"requiredTerms": ["key light", "fill light", "rim or environment light", "exposure", "tone mapping", "background", "contact shadow"], "mustAvoid": ["ambient-only lighting", "flat value range", "missing contact shadow", "reference lighting copied without separating material readability"]}, "screenshotReview": ["Compare albedo palette and local color zones.", "Compare roughness/normal/bump response under light.", "Compare cavity dirt, edge wear, stains, moss, scratches, or other local masks.", "Compare key/fill/rim structure, exposure, tone mapping, background, and contact shadows.", "Capture a neutral-light render to verify material readability without reference lighting.", "Capture a grazing-light close-up to expose flat normals, uniform roughness, tiling, and plastic highlights.", "Capture a reference-matched render from the same camera framing as the source."]};
  return lights;
}

// PBR materials (clearcoat/iridescence/transmission/anisotropy) need an environment
// map to visually behave as intended — call this once per renderer and assign the
// result to scene.environment before rendering. No external HDR asset required.
export function createXiaomotuanIPEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const texture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  return texture;
}

// Plan 1.3 §3.2 — auto-framing by bounding box. The Divine Eye can only compare a
// render to the reference if the object is FRAMED consistently (an object framed
// differently scores as wrong even when its shape is right). This positions the camera
// deterministically from the object's bounding box so it fills the frame at a stable
// margin, and sets near/far to the object scale. Call after adding the model to the
// scene, and again on resize (after updating camera.aspect).
export function frameXiaomotuanIPCamera(
  camera: THREE.PerspectiveCamera,
  object: THREE.Object3D,
  options: { margin?: number; azimuthDeg?: number; elevationDeg?: number } = {},
): void {
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const margin = options.margin ?? 1.15;
  const maxDim = Math.max(size.x, size.y, size.z) * margin;
  const fov = (camera.fov * Math.PI) / 180;
  // distance so the largest object dimension fits vertically in the frame
  const distance = (maxDim / 2) / Math.tan(fov / 2);
  const az = ((options.azimuthDeg ?? 0) * Math.PI) / 180;
  const el = ((options.elevationDeg ?? 0) * Math.PI) / 180;
  const dir = new THREE.Vector3(
    Math.sin(az) * Math.cos(el),
    Math.sin(el),
    Math.cos(az) * Math.cos(el),
  );
  camera.position.copy(center).addScaledVector(dir, distance);
  camera.near = Math.max(0.01, distance - maxDim);
  camera.far = distance + maxDim * 2;
  camera.lookAt(center);
  camera.updateProjectionMatrix();
}

// Plan 1.3 §3.2c — PRESENTATION composer (DOF + bloom). CRITICAL (R-POSTFX): this is
// for the showcase/hero render ONLY. The Divine Eye's EVALUATION render MUST use a
// plain renderer with NO composer — bloom blows highlights and DOF blurs edges, which
// would corrupt the deterministic IoU/DCD/edge/blowout signals. Enable dof/bloom ONLY
// when the reference photo actually exhibits them (detect_reference_effects.py authorizes).
export function createXiaomotuanIPPresentationComposer(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  options: { dof?: boolean; bloom?: boolean; bloomStrength?: number; dofFocus?: number; dofAperture?: number } = {},
): EffectComposer {
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  if (options.dof) {
    composer.addPass(new BokehPass(scene, camera, {
      focus: options.dofFocus ?? 10.0,
      aperture: options.dofAperture ?? 0.0002,
      maxblur: 0.01,
    }));
  }
  if (options.bloom) {
    const size = new THREE.Vector2();
    renderer.getSize(size);
    composer.addPass(new UnrealBloomPass(size, options.bloomStrength ?? 0.4, 0.4, 0.85));
  }
  return composer;
}

export function configureXiaomotuanIPRenderer(renderer: THREE.WebGLRenderer): void {
  // Load-bearing for view-dependent finishes (anodized / Doppler): without ACES + sRGB
  // the environment reflection reads flat/washed instead of a believable metal response.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
}

export function createXiaomotuanIPInspectControls(
  camera: THREE.Camera,
  domElement: HTMLElement,
): OrbitControls {
  // View-dependent finishes only read correctly once the user orbits — their color
  // comes from the environment reflection, not albedo, so free rotation matters here.
  const controls = new OrbitControls(camera, domElement);
  controls.enableDamping = true;
  controls.minDistance = 1.0;
  controls.maxDistance = 8.0;
  controls.autoRotate = false;
  return controls;
}
