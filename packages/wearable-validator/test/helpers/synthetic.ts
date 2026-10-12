import { Document, WebIO, type Material, type Node } from "@gltf-transform/core";
import { encode as encodePng } from "fast-png";
import JSZip from "jszip";
import { AVATAR_BONE_NAMES } from "../../src/manifest/index.js";

const io = new WebIO();

export type SyntheticTextureSlot = "baseColor" | "normal" | "emissive" | "metallicRoughness" | "occlusion";

export interface SyntheticTextureImage {
  /** Material slot to attach to (default baseColor). */
  slot?: SyntheticTextureSlot;
  /** Raw image bytes (default: a PNG of `size`). */
  bytes?: Uint8Array;
  size?: number;
  name?: string;
  mimeType?: string;
}

export interface SyntheticMaterialDef {
  name: string;
  textures?: SyntheticTextureImage[];
}

export interface SyntheticAnimationOptions {
  name: string;
  seconds: number;
  /** Avatar bone to target (default Avatar_Hips, falling back to the mesh node). */
  targetBone?: string;
  /** Target any node by exact name (wins over targetBone) — mesh nodes, prop bones, etc. */
  targetNode?: string;
  path?: "translation" | "rotation" | "scale";
  /** Explicit key times (wins over the default 3-key spread over `seconds`). */
  times?: number[];
  /** Flat output values — 3 per key (4 for rotation). Defaults to a small curve honoring `loopSeam`. */
  values?: number[];
  loopSeam?: boolean;
}

export interface SyntheticPropOptions {
  /** Triangles per prop primitive (default 12). */
  triangles?: number;
  /** Number of prop materials, one primitive each (default 1). */
  materials?: number;
  /** How many of those materials get a distinct baseColor texture (default 0). */
  texturedMaterials?: number;
  /** Joint nodes under the prop armature, named Prop_Bone_<i> (default 0). */
  bones?: number;
  /** Armature node name (default "Armature_Prop"). */
  armatureName?: string;
}

export interface SyntheticOptions {
  /** Triangles for the cube mesh (default 12 — a plain cube). */
  triangles?: number;
  /** Skin the mesh to the canonical skeleton (default true). */
  skinned?: boolean;
  /** Bone names to create (default: the canonical 62). */
  bones?: string[];
  /** Add an animation clip with this name + duration (seconds). */
  animation?: { name: string; seconds: number; loopSeam?: boolean; targetBone?: string };
  /** Additional/finer-grained animation clips (appended after `animation`). */
  animations?: SyntheticAnimationOptions[];
  /** Add a prop armature (Armature_Prop) with a mesh and optional bones. */
  prop?: SyntheticPropOptions;
  /** Add N extra materials/textures beyond the first. */
  extraMaterials?: number;
  texture?: { size: number; nonSquare?: boolean; bytes?: Uint8Array };
  /** Scale applied to the cube (bounding-box tests). */
  scale?: number;
  /** Name of the primary material (default "Wearable_MAT"). */
  materialName?: string;
  /** Name of the cube mesh (default "cube"). */
  meshName?: string;
  /** Extra texture images attached to the primary material's slots. */
  textureImages?: SyntheticTextureImage[];
  /** Additional named materials, each on its own primitive, with optional textures. */
  extraMaterialDefs?: SyntheticMaterialDef[];
  /** Per-vertex skinning overrides (applied to every vertex). */
  skinData?: {
    /** 4 joint indices into the bones list (default [0,0,0,0]). */
    joints?: [number, number, number, number];
    /** 4 weights (default [1,0,0,0]). */
    weights?: [number, number, number, number];
    /** Store WEIGHTS_0 as normalized uint8 instead of float32. */
    normalizedWeights?: boolean;
    /** Zero the weights of the first N vertices. */
    zeroWeightVertices?: number;
    /** Add JOINTS_1/WEIGHTS_1 with these values on every vertex. */
    secondSet?: { joints: [number, number, number, number]; weights: [number, number, number, number] };
  };
  /** Add an extra TRIANGLE_STRIP primitive with this many vertices (counts as n−2 triangles). */
  stripVertices?: number;
  /** Add a morph target (shape key) to the main primitive. */
  morphTarget?: boolean;
  /** Add an extra mesh under a node named "cube_collider" with this many triangles. */
  colliderTriangles?: number;
  /** Quaternion [x, y, z, w] applied to the mesh's root node (Z-up-export heuristic tests). */
  rootRotation?: [number, number, number, number];
}

/**
 * Builds a minimal valid wearable/emote GLB in memory: a cube skinned to the
 * canonical skeleton, one material, optional animation. Mutate via options —
 * every check's failing case is one option away.
 */
export async function syntheticGlb(options: SyntheticOptions = {}): Promise<Uint8Array> {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene("Scene");

  const scale = options.scale ?? 1;
  const positions = cubePositions(scale, options.triangles ?? 12);
  const position = doc.createAccessor("POSITION").setType("VEC3").setArray(positions).setBuffer(buffer);

  const material = doc.createMaterial(options.materialName ?? "Wearable_MAT");
  if (options.texture) {
    const size = options.texture.size;
    const tex = doc.createTexture("tex0").setMimeType("image/png").setImage(options.texture.bytes ?? pngBytes(size, options.texture.nonSquare ? size / 2 : size));
    material.setBaseColorTexture(tex);
  }
  let textureIndex = 1;
  const attachTexture = (mat: Material, img: SyntheticTextureImage): void => {
    const size = img.size ?? 64;
    const tex = doc
      .createTexture(img.name ?? `tex${textureIndex++}`)
      .setMimeType(img.mimeType ?? "image/png")
      .setImage(img.bytes ?? pngBytes(size, size));
    switch (img.slot ?? "baseColor") {
      case "baseColor": mat.setBaseColorTexture(tex); break;
      case "normal": mat.setNormalTexture(tex); break;
      case "emissive": mat.setEmissiveTexture(tex); break;
      case "metallicRoughness": mat.setMetallicRoughnessTexture(tex); break;
      case "occlusion": mat.setOcclusionTexture(tex); break;
    }
  };
  for (const img of options.textureImages ?? []) attachTexture(material, img);

  const prim = doc.createPrimitive().setMode(4).setAttribute("POSITION", position).setMaterial(material);
  const mesh = doc.createMesh(options.meshName ?? "cube").addPrimitive(prim);
  const meshNode = doc.createNode("cube_node").setMesh(mesh);
  if (options.rootRotation) meshNode.setRotation(options.rootRotation);
  scene.addChild(meshNode);

  for (let i = 0; i < (options.extraMaterials ?? 0); i++) {
    const extra = doc.createMaterial(`Extra_MAT_${i}`);
    const extraPrim = doc.createPrimitive().setMode(4).setAttribute("POSITION", position).setMaterial(extra);
    mesh.addPrimitive(extraPrim);
  }

  for (const def of options.extraMaterialDefs ?? []) {
    const extra = doc.createMaterial(def.name);
    for (const img of def.textures ?? []) attachTexture(extra, img);
    const extraPrim = doc.createPrimitive().setMode(4).setAttribute("POSITION", position).setMaterial(extra);
    mesh.addPrimitive(extraPrim);
  }

  if (options.stripVertices) {
    const stripPos = doc.createAccessor("strip_pos").setType("VEC3").setArray(new Float32Array(options.stripVertices * 3)).setBuffer(buffer);
    mesh.addPrimitive(doc.createPrimitive().setMode(5).setAttribute("POSITION", stripPos).setMaterial(material));
  }

  if (options.morphTarget) {
    const delta = doc.createAccessor("morph_delta").setType("VEC3").setArray(new Float32Array(positions.length)).setBuffer(buffer);
    prim.addTarget(doc.createPrimitiveTarget("shape_key").setAttribute("POSITION", delta));
  }

  if (options.colliderTriangles) {
    const colPos = doc.createAccessor("collider_pos").setType("VEC3").setArray(cubePositions(1, options.colliderTriangles)).setBuffer(buffer);
    const colMesh = doc.createMesh("collider").addPrimitive(doc.createPrimitive().setMode(4).setAttribute("POSITION", colPos));
    scene.addChild(doc.createNode("cube_collider").setMesh(colMesh));
  }

  const boneNames = options.bones ?? AVATAR_BONE_NAMES;
  let boneNodes: Node[] = [];
  if (options.skinned !== false) {
    const armature = doc.createNode("Armature");
    scene.addChild(armature);
    boneNodes = boneNames.map((name) => doc.createNode(name));
    // flat hierarchy under Armature — enough for joint-name checks
    for (const b of boneNodes) armature.addChild(b);
    const skin = doc.createSkin("skin");
    for (const b of boneNodes) skin.addJoint(b);
    meshNode.setSkin(skin);
    const vertexCount = positions.length / 3;
    const sd = options.skinData;
    const jointVals = sd?.joints ?? [0, 0, 0, 0];
    const weightVals = sd?.weights ?? [1, 0, 0, 0];
    const zeroCount = sd?.zeroWeightVertices ?? 0;
    const joints = new Uint16Array(vertexCount * 4);
    for (let v = 0; v < vertexCount; v++) for (let c = 0; c < 4; c++) joints[v * 4 + c] = jointVals[c];
    const weightsAccessor = doc.createAccessor("WEIGHTS_0").setType("VEC4").setBuffer(buffer);
    if (sd?.normalizedWeights) {
      const weights = new Uint8Array(vertexCount * 4);
      for (let v = 0; v < vertexCount; v++) for (let c = 0; c < 4; c++) weights[v * 4 + c] = v < zeroCount ? 0 : Math.round(weightVals[c] * 255);
      weightsAccessor.setArray(weights).setNormalized(true);
    } else {
      const weights = new Float32Array(vertexCount * 4);
      for (let v = 0; v < vertexCount; v++) for (let c = 0; c < 4; c++) weights[v * 4 + c] = v < zeroCount ? 0 : weightVals[c];
      weightsAccessor.setArray(weights);
    }
    prim.setAttribute("JOINTS_0", doc.createAccessor("JOINTS_0").setType("VEC4").setArray(joints).setBuffer(buffer));
    prim.setAttribute("WEIGHTS_0", weightsAccessor);
    if (sd?.secondSet) {
      const joints1 = new Uint16Array(vertexCount * 4);
      const weights1 = new Float32Array(vertexCount * 4);
      for (let v = 0; v < vertexCount; v++) {
        for (let c = 0; c < 4; c++) {
          joints1[v * 4 + c] = sd.secondSet.joints[c];
          weights1[v * 4 + c] = sd.secondSet.weights[c];
        }
      }
      prim.setAttribute("JOINTS_1", doc.createAccessor("JOINTS_1").setType("VEC4").setArray(joints1).setBuffer(buffer));
      prim.setAttribute("WEIGHTS_1", doc.createAccessor("WEIGHTS_1").setType("VEC4").setArray(weights1).setBuffer(buffer));
    }
  }

  if (options.prop) {
    const p = options.prop;
    const propArmature = doc.createNode(p.armatureName ?? "Armature_Prop");
    scene.addChild(propArmature);
    const propPositions = cubePositions(0.5, p.triangles ?? 12);
    const propPosition = doc.createAccessor("PROP_POSITION").setType("VEC3").setArray(propPositions).setBuffer(buffer);
    const propMesh = doc.createMesh("prop");
    const materialCount = Math.max(1, p.materials ?? 1);
    for (let i = 0; i < materialCount; i++) {
      const mat = doc.createMaterial(`Prop_MAT_${i}`);
      if (i < (p.texturedMaterials ?? 0)) {
        mat.setBaseColorTexture(doc.createTexture(`prop_tex_${i}`).setMimeType("image/png").setImage(pngBytes(4, 4)));
      }
      propMesh.addPrimitive(doc.createPrimitive().setMode(4).setAttribute("POSITION", propPosition).setMaterial(mat));
    }
    const propMeshNode = doc.createNode("prop_node").setMesh(propMesh);
    propArmature.addChild(propMeshNode);
    if ((p.bones ?? 0) > 0) {
      const propSkin = doc.createSkin("prop_skin");
      for (let i = 0; i < p.bones!; i++) {
        const bone = doc.createNode(`Prop_Bone_${i}`);
        propArmature.addChild(bone);
        propSkin.addJoint(bone);
      }
      propMeshNode.setSkin(propSkin);
      const vc = propPositions.length / 3;
      const joints = new Uint16Array(vc * 4);
      const weights = new Float32Array(vc * 4);
      for (let v = 0; v < vc; v++) weights[v * 4] = 1;
      const jointsAcc = doc.createAccessor("PROP_JOINTS_0").setType("VEC4").setArray(joints).setBuffer(buffer);
      const weightsAcc = doc.createAccessor("PROP_WEIGHTS_0").setType("VEC4").setArray(weights).setBuffer(buffer);
      for (const propPrim of propMesh.listPrimitives()) propPrim.setAttribute("JOINTS_0", jointsAcc).setAttribute("WEIGHTS_0", weightsAcc);
    }
  }

  const animationSpecs: SyntheticAnimationOptions[] = [...(options.animation ? [options.animation] : []), ...(options.animations ?? [])];
  for (const spec of animationSpecs) {
    const path = spec.path ?? "translation";
    const components = path === "rotation" ? 4 : 3;
    let target: Node | undefined;
    if (spec.targetNode) target = doc.getRoot().listNodes().find((n) => n.getName() === spec.targetNode);
    if (!target) target = boneNodes.find((b) => b.getName() === (spec.targetBone ?? "Avatar_Hips")) ?? meshNode;
    const timeValues = spec.times ?? [0, spec.seconds / 2, spec.seconds];
    let outputValues: number[];
    if (spec.values) {
      outputValues = spec.values;
    } else if (spec.times) {
      // rest-pose values for every explicit key (fps-spacing tests)
      const rest = path === "rotation" ? [0, 0, 0, 1] : path === "scale" ? [1, 1, 1] : [0, 0, 0];
      outputValues = timeValues.flatMap(() => rest);
    } else if (path === "rotation") {
      const last = spec.loopSeam ? [0, 0, 0, 1] : [0.7071, 0, 0, 0.7071];
      outputValues = [0, 0, 0, 1, 0.7071, 0, 0, 0.7071, ...last];
    } else if (path === "scale") {
      const last = spec.loopSeam ? [1, 1, 1] : [1.5, 1.5, 1.5];
      outputValues = [1, 1, 1, 1.25, 1.25, 1.25, ...last];
    } else {
      const lastY = spec.loopSeam ? 0 : 0.5; // loopSeam=true → clean loop (first == last)
      outputValues = [0, 0, 0, 0, 0.25, 0, 0, lastY, 0];
    }
    const input = doc.createAccessor("times").setType("SCALAR").setArray(new Float32Array(timeValues)).setBuffer(buffer);
    const output = doc
      .createAccessor("values")
      .setType(components === 4 ? "VEC4" : "VEC3")
      .setArray(new Float32Array(outputValues))
      .setBuffer(buffer);
    const sampler = doc.createAnimationSampler().setInput(input).setOutput(output).setInterpolation("LINEAR");
    const channel = doc.createAnimationChannel().setTargetNode(target).setTargetPath(path).setSampler(sampler);
    doc.createAnimation(spec.name).addSampler(sampler).addChannel(channel);
  }

  return io.writeBinary(doc);
}

function cubePositions(scale: number, triangles: number): Float32Array {
  // `triangles` non-indexed triangles inside a cube of side `scale`
  const arr = new Float32Array(triangles * 9);
  for (let t = 0; t < triangles; t++) {
    const o = t * 9;
    const jitter = (t % 12) * 0.01;
    arr[o] = 0; arr[o + 1] = 0; arr[o + 2] = jitter;
    arr[o + 3] = scale; arr[o + 4] = 0; arr[o + 5] = jitter;
    arr[o + 6] = 0; arr[o + 7] = scale; arr[o + 8] = jitter;
  }
  return arr;
}

/** A solid PNG (RGBA) — transparent border ring so thumbnail transparency passes by default. */
export function pngBytes(width: number, height: number, opaque = false, channels: 3 | 4 = 4): Uint8Array {
  const data = new Uint8Array(width * height * channels);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      data[i] = 200; data[i + 1] = 60; data[i + 2] = 90;
      if (channels === 4) {
        const border = x === 0 || y === 0 || x === width - 1 || y === height - 1;
        data[i + 3] = !opaque && border ? 0 : 255;
      }
    }
  }
  return encodePng({ width, height, data, channels });
}

/** An 8-bit palette PNG whose transparency lives in a tRNS chunk, as the Builder exports thumbnails: a transparent border ring unless `opaque`. */
export function palettePngBytes(width: number, height: number, opaque = false): Uint8Array {
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const border = x === 0 || y === 0 || x === width - 1 || y === height - 1;
      data[y * width + x] = !opaque && border ? 0 : 1;
    }
  }
  return encodePng({ width, height, data, channels: 1, depth: 8, palette: [[0, 0, 0, 0], [200, 60, 90, 255]] });
}

/** An RGBA PNG transparent only in its middle: the border, where a background shows, is opaque. */
export function pngWithOpaqueBorder(width: number, height: number): Uint8Array {
  const data = new Uint8Array(width * height * 4).fill(255);
  for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) data[(y * width + x) * 4 + 3] = 0;
  return encodePng({ width, height, data, channels: 4 });
}

/** Only a PNG signature and IHDR claiming `width`×`height` RGBA — what a decode bomb's header looks like; there is no pixel data behind it. */
export function pngHeaderBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes.set([8, 6, 0, 0, 0], 24);
  return bytes;
}

/** The same PNG with a tEXt chunk spliced in before IHDR: fast-png still decodes it, a header reader that expects IHDR first does not. */
export function pngWithLeadingChunk(png: Uint8Array): Uint8Array {
  const text = new TextEncoder().encode("Comment\0made for the header test");
  const chunk = new Uint8Array(12 + text.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, text.length);
  chunk.set([0x74, 0x45, 0x58, 0x74], 4);
  chunk.set(text, 8);
  view.setUint32(8 + text.length, pngCrc(chunk.subarray(4, 8 + text.length)));
  const out = new Uint8Array(png.length + chunk.length);
  out.set(png.subarray(0, 8), 0);
  out.set(chunk, 8);
  out.set(png.subarray(8), 8 + chunk.length);
  return out;
}

/** The same JPEG with two 0xFF fill bytes after SOI: jpeg-js skips them, a strict marker walk stops. */
export function jpegWithFillBytes(jpeg: Uint8Array): Uint8Array {
  const out = new Uint8Array(jpeg.length + 2);
  out.set(jpeg.subarray(0, 2), 0);
  out.set([0xff, 0xff], 2);
  out.set(jpeg.subarray(2), 4);
  return out;
}

function pngCrc(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** A 16-bit-per-channel RGBA PNG (texture-format failing case). */
export function png16Bytes(width: number, height: number): Uint8Array {
  const data = new Uint16Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = 51200; data[i * 4 + 1] = 15360; data[i * 4 + 2] = 23040; data[i * 4 + 3] = 65535;
  }
  return encodePng({ width, height, data, channels: 4, depth: 16 });
}

export interface SyntheticZipOptions {
  glb?: Uint8Array;
  kind?: "wearable" | "emote";
  manifest?: Record<string, unknown>;
  thumbnail?: Uint8Array | null;
  extraFiles?: Record<string, Uint8Array>;
  /** Category for the default wearable manifest (default "hat"); ignored when `manifest` is given. */
  category?: string;
  /** Raw wearable.json/emote.json content — wins over `manifest` (unparseable-manifest tests). */
  manifestRaw?: string;
}

/** A builder-style zip: model.glb + wearable.json/emote.json + thumbnail.png. */
export async function syntheticZip(options: SyntheticZipOptions = {}): Promise<Uint8Array> {
  const kind = options.kind ?? "wearable";
  const glb = options.glb ?? (await syntheticGlb(kind === "emote" ? { animation: { name: "Pose_Avatar", seconds: 2 } } : {}));
  const manifest =
    options.manifest ??
    (kind === "wearable"
      ? { name: "Test Wearable", description: "synthetic", rarity: "common", data: { category: options.category ?? "hat", tags: ["test"], hides: [], replaces: [], representations: [{ bodyShapes: ["urn:decentraland:off-chain:base-avatars:BaseMale", "urn:decentraland:off-chain:base-avatars:BaseFemale"], mainFile: "model.glb", contents: ["model.glb"] }] } }
      : { name: "Test Emote", description: "synthetic", rarity: "common", category: "fun", play_mode: "simple" });
  const zip = new JSZip();
  zip.file("model.glb", glb);
  zip.file(kind === "wearable" ? "wearable.json" : "emote.json", options.manifestRaw ?? JSON.stringify(manifest));
  const thumb = options.thumbnail === null ? undefined : options.thumbnail ?? pngBytes(256, 256);
  if (thumb) zip.file("thumbnail.png", thumb);
  for (const [path, bytes] of Object.entries(options.extraFiles ?? {})) zip.file(path, bytes);
  return zip.generateAsync({ type: "uint8array" });
}
