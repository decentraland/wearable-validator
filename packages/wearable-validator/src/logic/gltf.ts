import { Document, WebIO, type GLTF, type Node, type Primitive } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { manifest } from "../manifest/index.js";

const io = new WebIO().registerExtensions(ALL_EXTENSIONS);

/** Parse a self-contained GLB. Returns the gltf-transform Document plus the raw JSON chunk. */
export async function parseGlb(bytes: Uint8Array, maxUnpackedBytes = manifest.gltf.maxUnpackedBytes): Promise<{ doc: Document; json: Record<string, unknown> }> {
  const json = readGlbJsonChunk(bytes);
  assertAcyclicNodes(json);
  assertBoundedUnpacking(json, maxUnpackedBytes);
  const doc = await io.readBinary(bytes);
  return { doc, json };
}

/** True when the bytes look like glTF JSON text (a .gltf) rather than a GLB container. */
export function isGltfJson(bytes: Uint8Array): boolean {
  for (const byte of bytes) {
    if (byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d || byte === 0xef || byte === 0xbb || byte === 0xbf) continue;
    return byte === 0x7b;
  }
  return false;
}

/**
 * The JSON of a self-contained .gltf: every buffer and image embedded (a data: URI, or an image in a buffer view).
 * Throws an actionable sentence for anything else — a .gltf naming another file or a URL cannot be checked or drawn
 * from the item alone.
 */
export function readSelfContainedGltf(bytes: Uint8Array): Record<string, unknown> {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("it is not valid glTF JSON. Re-export the model as GLB");
  }
  if (!json || typeof json !== "object" || Array.isArray(json) || !("asset" in json)) throw new Error("it is not a glTF document. Re-export the model as GLB");
  const record = json as Record<string, unknown>;
  for (const [list, what] of [[record.buffers, "buffer"], [record.images, "image"]] as const) {
    for (const entry of Array.isArray(list) ? list : []) {
      const uri = entry && typeof entry === "object" && "uri" in entry ? (entry as { uri: unknown }).uri : undefined;
      if (uri === undefined) continue;
      if (typeof uri !== "string" || !uri.startsWith("data:")) {
        throw new Error(`its ${what} points at "${String(uri).slice(0, 80)}" outside the file. Export it as glTF Embedded, or as GLB, so everything is inside one file`);
      }
    }
  }
  return record;
}

/** Parse a self-contained .gltf the same way as a GLB. */
export async function parseGltf(bytes: Uint8Array, maxUnpackedBytes = manifest.gltf.maxUnpackedBytes): Promise<{ doc: Document; json: Record<string, unknown> }> {
  const json = readSelfContainedGltf(bytes);
  assertAcyclicNodes(json);
  assertBoundedUnpacking(json, maxUnpackedBytes);
  // embedded buffers and images are decoded from their data: URIs; there is nothing else to fetch
  // the shape was checked above (an object with asset, every URI embedded); the reader validates the rest
  const doc = await io.readJSON({ json: structuredClone(json) as unknown as GLTF.IGLTF, resources: {} });
  return { doc, json };
}

/** A model file, GLB or self-contained .gltf. */
export function parseModel(bytes: Uint8Array, maxUnpackedBytes = manifest.gltf.maxUnpackedBytes): Promise<{ doc: Document; json: Record<string, unknown> }> {
  return isGlb(bytes) ? parseGlb(bytes, maxUnpackedBytes) : parseGltf(bytes, maxUnpackedBytes);
}

/** The glTF JSON of a model file without a full parse: the JSON chunk of a GLB, or a .gltf's own JSON. */
export function readModelJson(bytes: Uint8Array): Record<string, unknown> {
  return isGlb(bytes) ? readGlbJsonChunk(bytes) : readSelfContainedGltf(bytes);
}

const COMPONENT_BYTES: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const TYPE_COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

// gltf-transform allocates count × element size per accessor and copies a buffer view per image, straight from the JSON:
// a few hundred bytes could otherwise ask for gigabytes
function assertBoundedUnpacking(json: Record<string, unknown>, maxUnpackedBytes: number): void {
  const views: unknown[] = Array.isArray(json.bufferViews) ? json.bufferViews : [];
  const damaged = (index: number) => new Error(`Accessor #${index} reads past the data the file holds. Re-export the model as GLB.`);
  const fits = (index: number, viewIndex: unknown, offset: unknown, count: number, elementBytes: number, stride?: unknown): void => {
    const view = typeof viewIndex === "number" ? views[viewIndex] : undefined;
    if (!view || typeof view !== "object" || !("byteLength" in view) || typeof view.byteLength !== "number") throw damaged(index);
    const step = stride ?? elementBytes;
    if (typeof step !== "number" || !Number.isInteger(step) || step < elementBytes || step > 252) throw damaged(index);
    const start = offset ?? 0;
    if (typeof start !== "number" || !Number.isInteger(start) || start < 0) throw damaged(index);
    if (count > 0 && start + step * (count - 1) + elementBytes > view.byteLength) throw damaged(index);
  };
  let total = 0;
  const accessors: unknown[] = Array.isArray(json.accessors) ? json.accessors : [];
  accessors.forEach((accessor: unknown, index) => {
    if (!accessor || typeof accessor !== "object") throw damaged(index);
    const { count, componentType, type, bufferView, byteOffset, sparse } = accessor as Record<string, unknown>;
    const componentBytes = COMPONENT_BYTES[componentType as number];
    const components = TYPE_COMPONENTS[type as string];
    if (typeof count !== "number" || !Number.isInteger(count) || count < 0 || !componentBytes || !components) throw damaged(index);
    const elementBytes = componentBytes * components;
    if (bufferView !== undefined) {
      const view = views[bufferView as number];
      fits(index, bufferView, byteOffset, count, elementBytes, view && typeof view === "object" && "byteStride" in view ? view.byteStride : undefined);
    }
    if (sparse !== undefined) {
      const { count: sparseCount, indices, values } = (sparse ?? {}) as Record<string, unknown>;
      if (typeof sparseCount !== "number" || !Number.isInteger(sparseCount) || sparseCount < 1 || sparseCount > count) throw damaged(index);
      const { bufferView: indexView, byteOffset: indexOffset, componentType: indexType } = (indices ?? {}) as Record<string, unknown>;
      const { bufferView: valueView, byteOffset: valueOffset } = (values ?? {}) as Record<string, unknown>;
      fits(index, indexView, indexOffset, sparseCount, COMPONENT_BYTES[indexType as number] ?? 0);
      fits(index, valueView, valueOffset, sparseCount, elementBytes);
    }
    total += count * elementBytes;
  });
  const images: unknown[] = Array.isArray(json.images) ? json.images : [];
  for (const image of images) {
    const view = image && typeof image === "object" && "bufferView" in image ? views[image.bufferView as number] : undefined;
    if (view && typeof view === "object" && "byteLength" in view && typeof view.byteLength === "number") total += view.byteLength;
  }
  if (total > maxUnpackedBytes) {
    const mb = (bytes: number) => Math.round(bytes / 1048576);
    throw new Error(`The model's geometry, animation and image data unpack to ${mb(total)} MB — the maximum is ${mb(maxUnpackedBytes)} MB. Reduce the mesh, animation or texture detail and re-export it as GLB.`);
  }
}

function assertAcyclicNodes(json: Record<string, unknown>): void {
  if (!Array.isArray(json.nodes)) return;
  const nodes: unknown[] = json.nodes;
  const parents = new Uint32Array(nodes.length);
  const children = nodes.map((node) => {
    if (!node || typeof node !== "object" || !("children" in node)) return [];
    if (!Array.isArray(node.children)) throw new Error("The model has an invalid node hierarchy. Re-export it as GLB.");
    return node.children.map((child: unknown) => {
      if (typeof child !== "number" || !Number.isInteger(child) || child < 0 || child >= nodes.length) {
        throw new Error("The model references a missing child node. Re-export it as GLB.");
      }
      parents[child]++;
      return child;
    });
  });
  const ready: number[] = [];
  for (let i = 0; i < nodes.length; i++) if (parents[i] === 0) ready.push(i);
  for (let next = 0; next < ready.length; next++) {
    for (const child of children[ready[next]]) if (--parents[child] === 0) ready.push(child);
  }
  if (ready.length !== nodes.length) throw new Error("The model contains a cycle in its node hierarchy. Re-export it as GLB.");
}

/** Reads the JSON chunk of a GLB container without a full parse (cameras/extensions live here). */
export function readGlbJsonChunk(bytes: Uint8Array): Record<string, unknown> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 20 || view.getUint32(0, true) !== 0x46546c67) throw new Error("not a GLB container");
  const jsonLength = view.getUint32(12, true);
  const jsonBytes = bytes.subarray(20, 20 + jsonLength);
  return JSON.parse(new TextDecoder().decode(jsonBytes)) as Record<string, unknown>;
}

export function isGlb(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x67 && bytes[1] === 0x6c && bytes[2] === 0x54 && bytes[3] === 0x46;
}

/** Collider rule (pinned): a mesh is a collider when its node — or any ancestor — matches /collider/i. One top-down pass: per-node ancestor walks are quadratic on deep chains. */
export function colliderNodes(doc: Document): Set<Node> {
  const colliders = new Set<Node>();
  walkDown(doc, (node, parent) => {
    if (/collider/i.test(node.getName()) || (parent && colliders.has(parent))) colliders.add(node);
  });
  return colliders;
}

/** Every node's world matrix, parents before children, instead of gltf-transform's per-node ancestor walk. */
export function worldMatrices(doc: Document): Map<Node, number[]> {
  const worlds = new Map<Node, number[]>();
  walkDown(doc, (node, parent) => {
    const local = node.getMatrix();
    worlds.set(node, parent ? multiply(worlds.get(parent)!, local) : local);
  });
  return worlds;
}

function walkDown(doc: Document, visit: (node: Node, parent: Node | null) => void): void {
  const nodes = doc.getRoot().listNodes();
  const pending: [Node, Node | null][] = nodes.filter((node) => !node.getParentNode()).map((node) => [node, null]);
  const seen = new Set<Node>();
  for (let entry = pending.pop(); entry; entry = pending.pop()) {
    const [node, parent] = entry;
    if (seen.has(node)) continue;
    seen.add(node);
    visit(node, parent);
    for (const child of node.listChildren()) pending.push([child, node]);
  }
  if (seen.size !== nodes.length) throw new Error("The model contains a cycle in its node hierarchy. Re-export it as GLB.");
}

/** Column-major a × b. */
function multiply(a: number[], b: number[]): number[] {
  const out = new Array<number>(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      out[col * 4 + row] = a[row] * b[col * 4] + a[4 + row] * b[col * 4 + 1] + a[8 + row] * b[col * 4 + 2] + a[12 + row] * b[col * 4 + 3];
    }
  }
  return out;
}

export interface TriangleCount {
  total: number;
  /** true when any STRIP/FAN primitive was counted (warn: non-standard export). */
  hasStripOrFan: boolean;
}

/** Pinned counting: mode-4 = indices/3 (non-indexed: positions/3); STRIP/FAN = n−2; colliders excluded. */
export function countTriangles(doc: Document): TriangleCount {
  let total = 0;
  let hasStripOrFan = false;
  const colliders = colliderNodes(doc);
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh || colliders.has(node)) continue;
    for (const prim of mesh.listPrimitives()) {
      total += primitiveTriangles(prim, (m) => (m ? (hasStripOrFan = true) : undefined));
    }
  }
  // meshes not attached to any node still render nowhere; count only node-attached meshes (builder parity)
  return { total: Math.floor(total), hasStripOrFan };
}

function primitiveTriangles(prim: Primitive, markStripFan: (m: boolean) => void): number {
  const mode = prim.getMode();
  const indices = prim.getIndices();
  const position = prim.getAttribute("POSITION");
  const vertexCount = indices ? indices.getCount() : position ? position.getCount() : 0;
  if (mode === 4) return vertexCount / 3;
  if (mode === 5 || mode === 6) {
    markStripFan(true);
    return Math.max(0, vertexCount - 2);
  }
  return 0; // points/lines contribute no triangles
}

/** Rest-pose world AABB of node-transformed POSITION min/max; colliders excluded. */
export function computeAabb(doc: Document): { width: number; height: number; depth: number } | null {
  let min = [Infinity, Infinity, Infinity];
  let max = [-Infinity, -Infinity, -Infinity];
  let any = false;
  const colliders = colliderNodes(doc);
  const worlds = worldMatrices(doc);
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh || colliders.has(node)) continue;
    const world = worlds.get(node)!;
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute("POSITION");
      if (!pos) continue;
      const pMin = pos.getMin([0, 0, 0]);
      const pMax = pos.getMax([0, 0, 0]);
      // transform the 8 AABB corners — exact for affine transforms
      for (const x of [pMin[0], pMax[0]]) for (const y of [pMin[1], pMax[1]]) for (const z of [pMin[2], pMax[2]]) {
        const c = transformPoint(world, [x, y, z]);
        for (let i = 0; i < 3; i++) {
          if (c[i] < min[i]) min[i] = c[i];
          if (c[i] > max[i]) max[i] = c[i];
        }
        any = true;
      }
    }
  }
  if (!any) return null;
  return { width: max[0] - min[0], height: max[1] - min[1], depth: max[2] - min[2] };
}

function transformPoint(m: number[], p: [number, number, number]): [number, number, number] {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]
  ];
}

/** All joint names across all skins. */
export function listJointNames(doc: Document): string[] {
  const names = new Set<string>();
  for (const skin of doc.getRoot().listSkins()) {
    for (const joint of skin.listJoints()) names.add(joint.getName());
  }
  return [...names];
}

export function hasSkinnedMesh(doc: Document): boolean {
  return doc.getRoot().listNodes().some((n) => n.getMesh() && n.getSkin());
}

export function formatDimensions(box: { width: number; height: number; depth: number }): string {
  return `${[box.width, box.height, box.depth].map(value => Number(value.toPrecision(7))).join(" × ")} m`;
}
