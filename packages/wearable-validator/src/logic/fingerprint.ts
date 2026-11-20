/**
 * What a model's geometry looks like to the similar-items check: textures, materials, UVs and names are left out, so a
 * recolour of a mesh has the fingerprint of the mesh.
 *
 *   cells   where the vertices are: every distinct grid cell (manifest similarItems.gridMillimeters) a vertex falls in,
 *           at the file's rest pose in the avatar's frame. Survives a retexture, a trim, parts added. Lost when the mesh
 *           is moved.
 *   parts   how the mesh is built: each connected piece (vertices at the same place welded, then joined through
 *           triangles) with a signature of how its triangles connect and the proportions of its vertex cloud. Survives
 *           being moved, turned or scaled. Lost when the mesh is rebuilt with other triangles.
 *
 * Colliders are left out, and so are primitives drawn with the skin material: the avatar's own arms, hands and head ship
 * inside many files and belong to nobody.
 */
import type { Document, Node, Primitive } from "@gltf-transform/core";
import type { Manifest } from "../manifest/index.js";
import { colliderNodes, multiply, worldMatrices } from "./gltf.js";
import { isSkinMaterial } from "./materials.js";

export interface PartFingerprint {
  /** Same for two parts whose welded triangles connect the same way, wherever the vertices sit. */
  signature: string;
  triangles: number;
  /** How many different corner-valence triples the triangles have: a sphere, a plane or a tube has a handful. */
  kinds: number;
  /** Spread of the vertices along their second and third main axes, relative to the first. */
  ratios: [number, number];
}

export interface ModelFingerprint {
  /** Sorted, distinct cell keys (see cellKey). */
  cells: number[];
  parts: PartFingerprint[];
}

type Rules = Manifest["similarItems"];

// A cell coordinate takes 17 bits (±65 m at 1 mm), so three fit a double's 53 exact bits; anything further is clamped.
const AXIS = 1 << 17;
const HALF = AXIS / 2;
const WELD = 10000; // vertices closer than 0.1 mm are the same vertex: exporters split one vertex per UV seam and normal

/** One number for the grid cell a point (metres) falls in. */
export function cellKey(x: number, y: number, z: number, gridMillimeters: number): number {
  const axis = (value: number) => Math.min(AXIS - 1, Math.max(0, Math.round((value * 1000) / gridMillimeters) + HALF));
  return (axis(x) * AXIS + axis(y)) * AXIS + axis(z);
}

export function fingerprintModel(doc: Document, rules: Rules, skinNameToken: string): ModelFingerprint {
  const cells = new Set<number>();
  const parts: PartFingerprint[] = [];
  const colliders = colliderNodes(doc);
  const worlds = worldMatrices(doc);
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh || colliders.has(node)) continue;
    const place = placement(node, worlds);
    const welded = new Map<string, number>();
    const points: number[] = [];
    const corners: number[] = [];
    for (const prim of mesh.listPrimitives()) {
      const material = prim.getMaterial();
      if (prim.getMode() !== 4 || (material && isSkinMaterial(material, skinNameToken))) continue;
      const local = restPositions(prim, place);
      const vertex = new Array<number>(local.length / 3);
      for (let i = 0; i < vertex.length; i++) {
        const x = local[i * 3], y = local[i * 3 + 1], z = local[i * 3 + 2];
        cells.add(cellKey(x, y, z, rules.gridMillimeters));
        const key = `${Math.round(x * WELD)},${Math.round(y * WELD)},${Math.round(z * WELD)}`;
        let id = welded.get(key);
        if (id === undefined) {
          id = points.length / 3;
          welded.set(key, id);
          points.push(x, y, z);
        }
        vertex[i] = id;
      }
      const indices = prim.getIndices();
      const count = indices ? indices.getCount() : vertex.length;
      for (let i = 0; i + 2 < count; i += 3) {
        const a = vertex[indices ? indices.getScalar(i) : i], b = vertex[indices ? indices.getScalar(i + 1) : i + 1], c = vertex[indices ? indices.getScalar(i + 2) : i + 2];
        if (a === undefined || b === undefined || c === undefined || a === b || b === c || a === c) continue; // out of range or collapsed
        corners.push(a, b, c);
      }
    }
    parts.push(...connectedParts(points, corners));
  }
  return { cells: [...cells].sort((a, b) => a - b), parts };
}

/** Where a mesh node's vertices end up: through its skin's joints when it has one, else through its own world matrix. */
function placement(node: Node, worlds: Map<Node, number[]>): { world: number[]; joints: number[][] | null } {
  const skin = node.getSkin();
  if (!skin) return { world: worlds.get(node)!, joints: null };
  const inverseBind = skin.getInverseBindMatrices();
  const element: number[] = [];
  const joints = skin.listJoints().map((joint, j) => {
    const world = worlds.get(joint)!;
    return inverseBind ? multiply(world, [...inverseBind.getElement(j, element)]) : world;
  });
  return { world: worlds.get(node)!, joints };
}

function restPositions(prim: Primitive, place: { world: number[]; joints: number[][] | null }): Float64Array {
  const position = prim.getAttribute("POSITION");
  if (!position) return new Float64Array(0);
  const joints = place.joints ? prim.getAttribute("JOINTS_0") : null;
  const weights = place.joints ? prim.getAttribute("WEIGHTS_0") : null;
  const out = new Float64Array(position.getCount() * 3);
  const p: number[] = [], jj: number[] = [], ww: number[] = [];
  for (let i = 0; i < position.getCount(); i++) {
    position.getElement(i, p);
    let x = 0, y = 0, z = 0, total = 0;
    if (place.joints && joints && weights) {
      joints.getElement(i, jj);
      weights.getElement(i, ww);
      for (let k = 0; k < 4; k++) {
        const m = place.joints[jj[k]];
        if (!ww[k] || !m) continue;
        total += ww[k];
        x += ww[k] * (m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12]);
        y += ww[k] * (m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13]);
        z += ww[k] * (m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]);
      }
    }
    if (total > 0) {
      x /= total; y /= total; z /= total;
    } else {
      const m = place.world;
      x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12];
      y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
      z = m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14];
    }
    out[i * 3] = x; out[i * 3 + 1] = y; out[i * 3 + 2] = z;
  }
  return out;
}

/** Splits welded triangles into connected pieces and fingerprints each. */
function connectedParts(points: number[], corners: number[]): PartFingerprint[] {
  const vertexCount = points.length / 3;
  const parent = Int32Array.from({ length: vertexCount }, (_, i) => i);
  const find = (v: number): number => {
    while (parent[v] !== v) v = parent[v] = parent[parent[v]];
    return v;
  };
  const valence = new Int32Array(vertexCount);
  for (let t = 0; t < corners.length; t += 3) {
    valence[corners[t]]++; valence[corners[t + 1]]++; valence[corners[t + 2]]++;
    parent[find(corners[t])] = find(corners[t + 1]);
    parent[find(corners[t + 1])] = find(corners[t + 2]);
  }
  const triples = new Map<number, number[]>();
  for (let t = 0; t < corners.length; t += 3) {
    const [a, b, c] = [valence[corners[t]], valence[corners[t + 1]], valence[corners[t + 2]]].sort((u, v) => u - v);
    const root = find(corners[t]);
    let list = triples.get(root);
    if (!list) triples.set(root, (list = []));
    list.push((a * 4096 + b) * 4096 + c); // a vertex shared by 4,096 triangles does not happen under the triangle caps
  }
  const members = new Map<number, number[]>();
  for (let v = 0; v < vertexCount; v++) {
    if (valence[v] === 0) continue;
    const root = find(v);
    let list = members.get(root);
    if (!list) members.set(root, (list = []));
    list.push(v);
  }
  const parts: PartFingerprint[] = [];
  for (const [root, list] of triples) {
    list.sort((a, b) => a - b);
    let kinds = 0;
    for (let i = 0; i < list.length; i++) if (i === 0 || list[i] !== list[i - 1]) kinds++;
    parts.push({ signature: hashNumbers(list), triangles: list.length, kinds, ratios: proportions(points, members.get(root)!) });
  }
  return parts;
}

/** Eigenvalues of the vertex cloud's covariance, as ratios to the largest: unchanged by moving, turning or uniformly scaling it. */
function proportions(points: number[], vertices: number[]): [number, number] {
  if (vertices.length < 4) return [0, 0];
  let mx = 0, my = 0, mz = 0;
  for (const v of vertices) { mx += points[v * 3]; my += points[v * 3 + 1]; mz += points[v * 3 + 2]; }
  mx /= vertices.length; my /= vertices.length; mz /= vertices.length;
  let xx = 0, yy = 0, zz = 0, xy = 0, xz = 0, yz = 0;
  for (const v of vertices) {
    const x = points[v * 3] - mx, y = points[v * 3 + 1] - my, z = points[v * 3 + 2] - mz;
    xx += x * x; yy += y * y; zz += z * z; xy += x * y; xz += x * z; yz += y * z;
  }
  const [first, second, third] = symmetricEigenvalues(xx, yy, zz, xy, xz, yz);
  return first > 0 ? [Math.max(0, second) / first, Math.max(0, third) / first] : [0, 0];
}

/** Eigenvalues of a symmetric 3×3 matrix, largest first (closed form, Smith 1961). */
function symmetricEigenvalues(xx: number, yy: number, zz: number, xy: number, xz: number, yz: number): [number, number, number] {
  const off = xy * xy + xz * xz + yz * yz;
  const mean = (xx + yy + zz) / 3;
  const spread = (xx - mean) ** 2 + (yy - mean) ** 2 + (zz - mean) ** 2 + 2 * off;
  if (spread === 0) return [mean, mean, mean];
  const p = Math.sqrt(spread / 6);
  const a = (xx - mean) / p, b = (yy - mean) / p, c = (zz - mean) / p, d = xy / p, e = xz / p, f = yz / p;
  const halfDet = (a * (b * c - f * f) - d * (d * c - f * e) + e * (d * f - b * e)) / 2;
  const phi = Math.acos(Math.min(1, Math.max(-1, halfDet))) / 3;
  const largest = mean + 2 * p * Math.cos(phi);
  const smallest = mean + 2 * p * Math.cos(phi + (2 * Math.PI) / 3);
  return [largest, 3 * mean - largest - smallest, smallest];
}

/** 64 bits of two FNV-1a passes over the numbers, as hex: a name for a list, not a secret. */
function hashNumbers(values: number[]): string {
  let low = 0x811c9dc5, high = 0x01000193 ^ values.length;
  for (const value of values) {
    const lo = value >>> 0, hi = Math.floor(value / 4294967296) >>> 0;
    for (let shift = 0; shift < 32; shift += 8) {
      low = Math.imul(low ^ ((lo >>> shift) & 255), 0x01000193);
      high = Math.imul(high ^ ((hi >>> shift) & 255) ^ (low >>> 13), 0x85ebca6b);
    }
    low = Math.imul(low ^ (hi & 255), 0x01000193);
    high = Math.imul(high ^ (lo & 255), 0xc2b2ae35);
  }
  return (high >>> 0).toString(16).padStart(8, "0") + (low >>> 0).toString(16).padStart(8, "0");
}
