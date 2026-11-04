/**
 * M-15 Representations match — the male and female versions of a body garment have to sit on their bodies the same
 * way, and one model rarely fits both bodies past the hips. Curators send back female-only fit problems (waist height,
 * hip seam, see-through) that the male version doesn't show.
 */
import type { Document, Skin } from "@gltf-transform/core";
import { colliderNodes, worldMatrices } from "../../../logic/gltf.js";
import { wearableGeometryOnly } from "../../../logic/wearable-only.js";
import { finding, type CheckContext, type CheckDefinition, type CheckMeta, type Finding, type ParsedModel } from "../../../types.js";
import { WEARABLES } from "../../docs.js";

const meta: CheckMeta = { name: "representations-match", group: "model", rule: "M-15", docs: `${WEARABLES}#building-3d-models-for-wearables` };

const MALE = "urn:decentraland:off-chain:base-avatars:BaseMale";
const FEMALE = "urn:decentraland:off-chain:base-avatars:BaseFemale";

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** Where a garment sits on its own body: its lowest and highest point as a share of the body (feet 0, head 1). */
interface Extent {
  bottom: number;
  top: number;
}

/** The skeleton a mesh is measured against: the height of the feet and the distance from the feet to the head. */
interface Frame {
  feet: number;
  body: number;
}

function frameOf(head: number | undefined, left: number | undefined, right: number | undefined): Frame | null {
  if (head === undefined || left === undefined || right === undefined) return null;
  const feet = (left + right) / 2;
  const body = head - feet;
  return body > 0 ? { feet, body } : null;
}

/** Column-major 4×4 inverse by Gauss–Jordan elimination with partial pivoting, or null when the matrix is singular. */
export function invert(m: number[]): number[] | null {
  // rows of [M | I]; column-major storage, so M[row][col] = m[col * 4 + row]
  const rows = [0, 1, 2, 3].map((r) => [0, 1, 2, 3].map((c) => m[c * 4 + r]).concat([0, 1, 2, 3].map((c) => (c === r ? 1 : 0))));
  for (let col = 0; col < 4; col++) {
    let pivot = col;
    for (let r = col + 1; r < 4; r++) if (Math.abs(rows[r][col]) > Math.abs(rows[pivot][col])) pivot = r;
    if (!(Math.abs(rows[pivot][col]) > 1e-12)) return null;
    [rows[col], rows[pivot]] = [rows[pivot], rows[col]];
    const scale = rows[col][col];
    for (let c = 0; c < 8; c++) rows[col][c] /= scale;
    for (let r = 0; r < 4; r++) {
      const factor = rows[r][col];
      if (r !== col && factor !== 0) for (let c = 0; c < 8; c++) rows[r][c] -= factor * rows[col][c];
    }
  }
  const out = new Array<number>(16);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) out[c * 4 + r] = rows[r][4 + c];
  return out;
}

/**
 * The skin's feet and head heights at bind time: each joint sits at the inverse of its inverse bind matrix, in the
 * space the skinned mesh's positions are stored in — whatever pose the file was saved in.
 */
function bindFrame(skin: Skin): Frame | null {
  const joints = skin.listJoints();
  const inverseBind = skin.getInverseBindMatrices();
  const height = (name: string): number | undefined => {
    const index = joints.findIndex((joint) => joint.getName() === name);
    if (index < 0) return undefined;
    // without inverse bind matrices glTF means identity: every joint bound at the origin
    const bind = inverseBind ? invert(inverseBind.getElement(index, new Array<number>(16).fill(0))) : IDENTITY;
    return bind ? bind[13] : undefined;
  };
  return frameOf(height("Avatar_Head"), height("Avatar_LeftFoot"), height("Avatar_RightFoot"));
}

const heightOf = (m: number[], p: [number, number, number]): number => m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];

/**
 * The garment's extent against the model's own skeleton, or null without feet and head bones. A skinned mesh ignores
 * its node: at bind time its vertices are their stored positions, measured against the bones its inverse bind
 * matrices place. A mesh without a skin is measured where its node puts it, against the bones' node pose.
 */
export function extentOf(doc: Document): Extent | null {
  const worlds = worldMatrices(doc);
  const nodes = doc.getRoot().listNodes();
  const poseHeight = (name: string): number | undefined => {
    const node = nodes.find((n) => n.getName() === name);
    return node ? worlds.get(node)![13] : undefined;
  };
  const pose = frameOf(poseHeight("Avatar_Head"), poseHeight("Avatar_LeftFoot"), poseHeight("Avatar_RightFoot"));
  const binds = new Map<Skin, Frame | null>();
  const colliders = colliderNodes(doc);
  let bottom = Infinity;
  let top = -Infinity;
  for (const node of nodes) {
    const mesh = node.getMesh();
    if (!mesh || colliders.has(node)) continue;
    const skin = node.getSkin();
    if (skin && !binds.has(skin)) binds.set(skin, bindFrame(skin));
    const frame = skin ? binds.get(skin)! : pose;
    if (!frame) continue;
    const matrix = skin ? IDENTITY : worlds.get(node)!;
    for (const prim of mesh.listPrimitives()) {
      const position = prim.getAttribute("POSITION");
      if (!position || position.getCount() === 0) continue;
      // KHR_mesh_quantization stores normalized integers: decode them to the values the vertices stand for
      const min = position.getMinNormalized([0, 0, 0]);
      const max = position.getMaxNormalized([0, 0, 0]);
      for (const x of [min[0], max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) {
        const share = (heightOf(matrix, [x, y, z]) - frame.feet) / frame.body;
        bottom = Math.min(bottom, share);
        top = Math.max(top, share);
      }
    }
  }
  return Number.isFinite(bottom) && Number.isFinite(top) ? { bottom, top } : null;
}

/** The model each body shape wears, when the item declares both. */
function versions(ctx: CheckContext): { male: ParsedModel; female: ParsedModel } | null {
  const male = ctx.models.find((model) => model.bodyShapes.includes(MALE));
  const female = ctx.models.find((model) => model.bodyShapes.includes(FEMALE));
  return male && female ? { male, female } : null;
}

const geometries = new WeakMap<Document, Float32Array[]>();

/** Every drawn primitive's vertex positions, decoded, in file order (colliders excluded). */
function geometryOf(doc: Document): Float32Array[] {
  const cached = geometries.get(doc);
  if (cached) return cached;
  const colliders = colliderNodes(doc);
  const primitives: Float32Array[] = [];
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh || colliders.has(node)) continue;
    for (const prim of mesh.listPrimitives()) {
      const position = prim.getAttribute("POSITION");
      if (!position) continue;
      const values = new Float32Array(position.getCount() * 3);
      const element = [0, 0, 0];
      for (let i = 0; i < position.getCount(); i++) values.set(position.getElement(i, element), i * 3);
      primitives.push(values);
    }
  }
  geometries.set(doc, primitives);
  return primitives;
}

/** One model for both bodies: the same file, or the same vertices exported again (another material name, another file name). */
function sameModel(a: ParsedModel, b: ParsedModel): boolean {
  if (a === b || a.mainFile === b.mainFile) return true;
  const left = geometryOf(a.doc);
  const right = geometryOf(b.doc);
  return left.length === right.length && left.every((values, i) => values.length === right[i].length && values.every((value, j) => value === right[i][j]));
}

const share = (n: number): string => `${Math.round(n * 100)}%`;

export const representationsMatch: CheckDefinition = {
  ...meta,
  title: "Male and female versions",
  describe: "a body garment's male and female versions sit alike on their bodies",
  explanation: "The male and female avatars differ at the chest, waist and hips. A garment's two versions should sit on their bodies the same way: a version far higher, lower or bigger than the other is usually a broken export, and curators send back waistbands at the wrong height and broken hip seams.",
  fix: "Wear the item on both base bodies in the Builder preview. If one version is far higher, lower or bigger than the other, fix its scale or position in your 3D tool and upload it again.",
  details: "Measures each version's lowest and highest point against its own skeleton, from the feet (0) to the head bone (1). A skinned mesh is measured in bind pose: its stored (decoded, if quantized) positions against the head and feet bones its inverse bind matrices place, so the pose the file was saved in does not matter; a mesh without a skin is measured where its node puts it. With separate versions, a gap at either edge above representations.maxEdgeGap warns. With one model for both bodies (the same file, or the same vertex positions uploaded twice), an item in representations.fittedCategories whose bottom edge reaches below representations.hipLine warns; that list is empty today, so one model shared by both bodies is not flagged. Feet, hands and skins share a model by design and are not compared.",
  categoryDependent: true,
  appliesTo: wearableGeometryOnly,
  measure: (ctx) => {
    const pair = versions(ctx);
    if (!pair) return "one body shape declared";
    if (sameModel(pair.male, pair.female)) return "one model for both bodies";
    const male = extentOf(pair.male.doc);
    const female = extentOf(pair.female.doc);
    return male && female ? `male ${share(male.bottom)}–${share(male.top)} · female ${share(female.bottom)}–${share(female.top)} of body height` : "no skeleton to measure against";
  },
  run: (ctx) => {
    const findings: Finding[] = [];
    const pair = versions(ctx);
    if (!pair || !ctx.category) return findings;
    const { maxEdgeGap, hipLine, fittedCategories } = ctx.manifest.representations;
    if (sameModel(pair.male, pair.female)) {
      if (!fittedCategories.includes(ctx.category)) return findings;
      const extent = extentOf(pair.male.doc);
      if (extent && extent.bottom < hipLine) {
        findings.push(finding(meta, "warning",
          `"${pair.male.mainFile}" is worn by both body shapes and reaches past the hips (down to ${share(extent.bottom)} of body height). The female body differs at the waist and hips; check the fit on BaseFemale, or upload a fitted female version.`,
          { where: pair.male.mainFile, measured: share(extent.bottom), limit: `separate versions below ${share(hipLine)}` }));
      }
      return findings;
    }
    const male = extentOf(pair.male.doc);
    const female = extentOf(pair.female.doc);
    if (!male || !female) return findings;
    const gap = Math.max(Math.abs(male.top - female.top), Math.abs(male.bottom - female.bottom));
    if (gap > maxEdgeGap) {
      findings.push(finding(meta, "warning",
        `The male and female versions sit differently on their bodies: "${pair.male.mainFile}" spans ${share(male.bottom)}–${share(male.top)} of body height, "${pair.female.mainFile}" ${share(female.bottom)}–${share(female.top)}. One may be at the wrong scale or position; compare them on both bodies.`,
        { where: pair.female.mainFile, measured: share(gap), limit: `≤ ${share(maxEdgeGap)}` }));
    }
    return findings;
  }
};
