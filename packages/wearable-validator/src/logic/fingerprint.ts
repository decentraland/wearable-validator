/**
 * What a model's geometry looks like to the similar-items check: textures, materials, UVs and names are left out, so a
 * recolour of a mesh has the fingerprint of the mesh.
 *
 *   cells   where the vertices are: every distinct grid cell (manifest similarItems.gridMillimeters) a drawn vertex falls
 *           in, in the avatar's frame at bind pose, whatever pose the file was saved in. Survives a retexture, a trim, parts
 *           added. Lost when the mesh is moved.
 *   parts   how the mesh is built: each connected piece (vertices at the same place welded, then joined through
 *           triangles) with a signature of how its triangles connect and the proportions of its vertex cloud. Survives
 *           being moved, turned or scaled. Lost when the mesh is rebuilt with other triangles.
 *
 * Colliders are left out, and so are primitives drawn with the skin material: the avatar's own arms, hands and head ship
 * inside many files and belong to nobody.
 */
import type { Document, Node, Skin } from "@gltf-transform/core";
import type { Manifest } from "../manifest/index.js";
import { colliderNodes, invert, multiply, transformPoint, worldMatrices } from "./gltf.js";
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

/**
 * What an index must have been built with to be comparable. The format number covers the cell packing, the signature
 * and its hash: bump it when any of them changes. The rest are the manifest numbers a fingerprint, or the common
 * geometry stored next to the entries, depends on.
 */
const FINGERPRINT_FORMAT = 1;
export const fingerprintVersion = (rules: Rules): string =>
  `${FINGERPRINT_FORMAT}:grid${rules.gridMillimeters}:weld${rules.weldMillimeters}:part${rules.minPartTriangles}/${rules.minPartKinds}:common${rules.commonCreators}`;

// A cell coordinate takes 17 bits (±65 m at 1 mm), so three fit a double's 53 exact bits; anything further is clamped.
const AXIS = 1 << 17;
const HALF = AXIS / 2;
const SIGNAL_EVERY = 1 << 16; // loop turns between two looks at the abort signal

/** One number for the grid cell a point (metres) falls in. */
function cellKey(x: number, y: number, z: number, gridMillimeters: number): number {
  const axis = (value: number) => Math.min(AXIS - 1, Math.max(0, Math.round((value * 1000) / gridMillimeters) + HALF));
  return (axis(x) * AXIS + axis(y)) * AXIS + axis(z);
}

/**
 * Null when the model asks for more work than rules.maxElements: every index read (every vertex, for a mesh without
 * indices), every node and every joint of the file's skins counts, and a mesh reused by several nodes counts each time. The work
 * grows with that number, and a file built to be slow is not worth comparing.
 */
export function fingerprintModel(doc: Document, rules: Rules, skinNameToken: string, signal?: AbortSignal): ModelFingerprint | null {
  let budget = rules.maxElements;
  const weld = 1000 / rules.weldMillimeters;
  const cells = new Set<number>();
  const parts: PartFingerprint[] = [];
  const colliders = colliderNodes(doc);
  const worlds = worldMatrices(doc);
  let bind: BindFrames | undefined;
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh || colliders.has(node)) continue;
    let place: number[] | undefined;
    const welded = new Map<string, number>();
    const points: number[] = [];
    const corners: number[] = [];
    for (const prim of mesh.listPrimitives()) {
      const material = prim.getMaterial();
      const mode = prim.getMode();
      const position = prim.getAttribute("POSITION");
      if (!position || mode < 4 || mode > 6 || (material && isSkinMaterial(material, skinNameToken))) continue; // points and lines draw no surface
      signal?.throwIfAborted();
      const indices = prim.getIndices();
      const count = indices ? indices.getCount() : position.getCount();
      budget -= count;
      if (budget < 0) return null;
      if (!place) {
        // only now: a file whose meshes draw nothing must not cost a pass over its skins
        if (!bind) {
          budget -= worlds.size; // one pass over the nodes, to hang rigid meshes from their bones
          for (const skin of doc.getRoot().listSkins()) budget -= skin.listJoints().length;
          if (budget < 0) return null;
          bind = bindFrames(doc, worlds);
        }
        place = placement(node, worlds, bind);
      }
      // a vertex is read the first time an index reaches it: an accessor shared with the skin primitive gives only its own
      // (kept in a map, so a small primitive on a huge shared accessor costs what it reads, not the accessor's size)
      const vertexCount = position.getCount();
      const seen = new Map<number, number>(); // vertex → welded id, or -1 for nowhere
      const p: number[] = [];
      const m = place;
      const at = (i: number): number => {
        const v = indices ? indices.getScalar(i) : i;
        if (!(v >= 0 && v < vertexCount)) return -1;
        const known = seen.get(v);
        if (known !== undefined) return known;
        position.getElement(v, p);
        const [x, y, z] = transformPoint(m, [p[0], p[1], p[2]]);
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) { seen.set(v, -1); return -1; } // a NaN position is nowhere: no cell, no triangle
        cells.add(cellKey(x, y, z, rules.gridMillimeters));
        // vertices closer than the weld distance are one vertex: exporters split a vertex per UV seam and per normal
        const key = `${Math.round(x * weld)},${Math.round(y * weld)},${Math.round(z * weld)}`;
        let id = welded.get(key);
        if (id === undefined) {
          id = points.length / 3;
          welded.set(key, id);
          points.push(x, y, z);
        }
        seen.set(v, id);
        return id;
      };
      // strips and fans are the same surface as a triangle list: a copy re-exported as one must not come out empty
      const step = mode === 4 ? 3 : 1;
      for (let i = 0; i + 2 < count; i += step) {
        if (i % SIGNAL_EVERY < step) signal?.throwIfAborted();
        const a = mode === 6 ? at(0) : at(i), b = at(i + 1), c = at(i + 2);
        if (a < 0 || b < 0 || c < 0 || a === b || b === c || a === c) continue; // out of range, nowhere or collapsed
        corners.push(a, b, c);
      }
    }
    parts.push(...connectedParts(points, corners));
  }
  return { cells: [...cells].sort((a, b) => a - b), parts };
}

/**
 * Where the file's skeletons stand at bind time, as far as the file can tell.
 *
 * A skinned mesh ignores its node: the engine moves each vertex by joint × inverse bind. In a file saved at bind pose
 * that product is one matrix for every joint: the placement of the stored positions (identity, a scale when the file
 * was exported in centimetres, or whatever the exporter folded into the inverse bind matrices). In a file saved with
 * bones moved, a moved bone and every bone under it give another product, and following them would make a copy saved
 * in another pose look like another mesh. The skeleton's root joints (those whose parent is not a joint) sit above
 * every chain, so their product is taken as the placement; with several roots, the one most of them agree on.
 *
 * What this cannot undo is a root joint that was itself moved: every product moves with it and nothing in the file
 * says where bind was. Such a copy is seen by its shape, not by its position.
 */
interface BindFrames {
  /** skin → the matrix that places its stored positions. */
  skins: Map<Skin, number[]>;
  /** a joint, or a node anywhere under one → its world matrix with that joint standing at bind. */
  bound: Map<Node, number[]>;
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function bindFrames(doc: Document, worlds: Map<Node, number[]>): BindFrames {
  const frames: BindFrames = { skins: new Map(), bound: new Map() };
  const element: number[] = [];
  for (const skin of doc.getRoot().listSkins()) {
    const joints = skin.listJoints();
    const isJoint = new Set(joints);
    const inverseBind = skin.getInverseBindMatrices();
    const inverseOf = (j: number): number[] => (inverseBind ? [...inverseBind.getElement(j, element)] : IDENTITY);
    const votes = new Map<string, { matrix: number[]; count: number }>();
    let best: { matrix: number[]; count: number } | undefined;
    joints.forEach((joint, j) => {
      const parent = joint.getParentNode();
      if (parent && isJoint.has(parent)) return;
      const matrix = multiply(worlds.get(joint)!, inverseOf(j));
      const key = matrix.map((value) => Math.round(value * 1000)).join(",");
      let vote = votes.get(key);
      if (!vote) votes.set(key, (vote = { matrix, count: 0 }));
      vote.count++;
      if (!best || vote.count > best.count) best = vote;
    });
    if (!best) continue;
    const placed = best.matrix;
    frames.skins.set(skin, placed);
    joints.forEach((joint, j) => {
      if (frames.bound.has(joint)) return;
      const bound = invert(inverseOf(j));
      if (bound) frames.bound.set(joint, multiply(placed, bound));
    });
  }
  // a rigid mesh parented to a bone (a hat under the head, a prop in a hand) follows that bone. `worlds` lists parents
  // before children, so one pass carries each bone's bind placement down to everything that hangs from it.
  for (const node of worlds.keys()) {
    if (frames.bound.has(node)) continue;
    const parent = node.getParentNode();
    const above = parent ? frames.bound.get(parent) : undefined;
    if (above) frames.bound.set(node, multiply(above, [...node.getMatrix()]));
  }
  return frames;
}

/** The matrix that places a mesh node's stored positions: its skin's bind placement, else where it hangs from a bone at bind, else its own world matrix. */
function placement(node: Node, worlds: Map<Node, number[]>, bind: BindFrames): number[] {
  const skin = node.getSkin();
  return (skin ? bind.skins.get(skin) : bind.bound.get(node)) ?? worlds.get(node)!;
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
    // a vertex shared by 4,096 triangles does not happen in a modelled mesh; past that the triples only blur
    const [a, b, c] = [valence[corners[t]], valence[corners[t + 1]], valence[corners[t + 2]]].map((v) => Math.min(v, 4095)).sort((u, v) => u - v);
    const root = find(corners[t]);
    let list = triples.get(root);
    if (!list) triples.set(root, (list = []));
    list.push((a * 4096 + b) * 4096 + c);
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
