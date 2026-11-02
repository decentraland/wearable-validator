/**
 * M-15 Representations match — the male and female versions of a body garment have to sit on their bodies the same
 * way, and one model rarely fits both bodies past the hips. Curators send back female-only fit problems (waist height,
 * hip seam, see-through) that the male version doesn't show.
 */
import type { Document } from "@gltf-transform/core";
import { colliderNodes, worldMatrices } from "../../../logic/gltf.js";
import { wearableGeometryOnly } from "../../../logic/wearable-only.js";
import { finding, type CheckContext, type CheckDefinition, type CheckMeta, type Finding, type ParsedModel } from "../../../types.js";
import { WEARABLES } from "../../docs.js";

const meta: CheckMeta = { name: "representations-match", group: "model", rule: "M-15", docs: `${WEARABLES}#building-3d-models-for-wearables` };

const MALE = "urn:decentraland:off-chain:base-avatars:BaseMale";
const FEMALE = "urn:decentraland:off-chain:base-avatars:BaseFemale";

/** Where a garment sits on its own body: its lowest and highest point as a share of the body (feet 0, head 1). */
interface Extent {
  bottom: number;
  top: number;
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

const heightOf = (m: number[], p: [number, number, number]): number => m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];

/**
 * The garment's rest-pose extent measured against the model's own skeleton, or null without feet and head bones. A
 * skinned mesh ignores its node's transform: at rest every vertex goes through joint world × inverse bind.
 */
export function extentOf(doc: Document): Extent | null {
  const worlds = worldMatrices(doc);
  const nodes = doc.getRoot().listNodes();
  const boneHeight = (name: string): number | undefined => {
    const node = nodes.find((n) => n.getName() === name);
    return node ? worlds.get(node)![13] : undefined;
  };
  const head = boneHeight("Avatar_Head");
  const left = boneHeight("Avatar_LeftFoot");
  const right = boneHeight("Avatar_RightFoot");
  if (head === undefined || left === undefined || right === undefined) return null;
  const feet = (left + right) / 2;
  const body = head - feet;
  if (!(body > 0)) return null;
  let low = Infinity;
  let high = -Infinity;
  const colliders = colliderNodes(doc);
  for (const node of nodes) {
    const mesh = node.getMesh();
    if (!mesh || colliders.has(node)) continue;
    let matrix = worlds.get(node)!;
    const skin = node.getSkin();
    const joint = skin?.listJoints()[0];
    if (skin && joint) {
      const inverseBind = skin.getInverseBindMatrices();
      const bind = inverseBind ? (inverseBind.getElement(0, new Array(16).fill(0)) as number[]) : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
      matrix = multiply(worlds.get(joint)!, bind);
    }
    for (const prim of mesh.listPrimitives()) {
      const position = prim.getAttribute("POSITION");
      if (!position) continue;
      const min = position.getMin([0, 0, 0]);
      const max = position.getMax([0, 0, 0]);
      for (const x of [min[0], max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) {
        const height = heightOf(matrix, [x, y, z]);
        low = Math.min(low, height);
        high = Math.max(high, height);
      }
    }
  }
  if (!Number.isFinite(low)) return null;
  return { bottom: (low - feet) / body, top: (high - feet) / body };
}

/** The model each body shape wears, when the item declares both. */
function versions(ctx: CheckContext): { male: ParsedModel; female: ParsedModel } | null {
  const male = ctx.models.find((model) => model.bodyShapes.includes(MALE));
  const female = ctx.models.find((model) => model.bodyShapes.includes(FEMALE));
  return male && female ? { male, female } : null;
}

const sameModel = (a: ParsedModel, b: ParsedModel): boolean =>
  a === b || a.mainFile === b.mainFile || (a.bytes.length === b.bytes.length && a.bytes.every((byte, i) => byte === b.bytes[i]));

const share = (n: number): string => `${Math.round(n * 100)}%`;

export const representationsMatch: CheckDefinition = {
  ...meta,
  title: "Male and female versions",
  describe: "a body garment's male and female versions sit alike on their bodies, and one model is not stretched over both past the hips",
  explanation: "The male and female avatars differ at the chest, waist and hips. A garment's two versions should sit on their bodies the same way, and a garment that reaches past the hips usually needs its own female version: curators send back waistbands at the wrong height, broken hip seams and skin showing through on the female body.",
  fix: "Wear the item on both base bodies in the Builder preview. If one version is far higher, lower or bigger than the other, fix its scale or position in your 3D tool. If one model is used for both bodies, make a female version fitted to the female base body (waist, hips, chest) and upload it as the female representation.",
  details: "Measures each version's lowest and highest point in rest pose against its own skeleton, from the feet (0) to the head bone (1). With separate versions, a gap at either edge above representations.maxEdgeGap warns. With one model for both bodies, an item in representations.fittedCategories whose bottom edge reaches below representations.hipLine warns. Feet, hands and skins share a model by design and are not compared.",
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
