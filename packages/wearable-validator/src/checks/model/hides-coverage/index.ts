/**
 * M-16 Hides match the model — hiding the head or the hands removes them from the avatar, so the model has to stand in
 * for them, and an upper body that reaches the lower legs has to hide the lower body it covers. Curators send items
 * back for a headless or handless avatar, and for pants clipping through a long dress.
 */
import type { Document, Skin } from "@gltf-transform/core";
import { extentOf } from "../../../logic/body-extent.js";
import { colliderNodes, invert } from "../../../logic/gltf.js";
import { hiddenBy } from "../../../logic/hides.js";
import { readVec4 } from "../../../logic/weights.js";
import { wearableGeometryOnly } from "../../../logic/wearable-only.js";
import { finding, type CheckDefinition, type CheckMeta, type Finding } from "../../../types.js";
import { UPLOADING } from "../../docs.js";

const meta: CheckMeta = { name: "hides-coverage", group: "model", rule: "M-16", docs: `${UPLOADING}#overrides` };

// the hand bone and its finger bones share this prefix on the avatar skeleton
const HAND_BONES = { left: "Avatar_LeftHand", right: "Avatar_RightHand" } as const;
type Side = keyof typeof HAND_BONES;
const SIDES: Side[] = ["left", "right"];

/** Where a hand is at bind time, in the space the skinned vertices are stored in: its wrist, its middle knuckle, and the body height to scale by. */
interface HandPlace {
  wrist: number[];
  knuckle: number[];
  body: number;
}

/** A joint's bind position: the translation of its inverted inverse bind matrix. Null without one. */
function bindPositions(skin: Skin): (name: string) => number[] | null {
  const joints = skin.listJoints();
  const inverseBind = skin.getInverseBindMatrices();
  return (name) => {
    const index = joints.findIndex((joint) => joint.getName() === name);
    if (index < 0 || !inverseBind) return null;
    const bind = invert(inverseBind.getElement(index, new Array<number>(16).fill(0)));
    return bind ? [bind[12], bind[13], bind[14]] : null;
  };
}

function handPlace(skin: Skin, side: Side): HandPlace | null {
  const at = bindPositions(skin);
  const wrist = at(HAND_BONES[side]);
  const knuckle = at(`${HAND_BONES[side]}Middle1`);
  const head = at("Avatar_Head");
  const leftFoot = at("Avatar_LeftFoot");
  const rightFoot = at("Avatar_RightFoot");
  if (!wrist || !knuckle || !head || !leftFoot || !rightFoot) return null;
  const body = head[1] - (leftFoot[1] + rightFoot[1]) / 2;
  const palm = Math.hypot(knuckle[0] - wrist[0], knuckle[1] - wrist[1], knuckle[2] - wrist[2]);
  return body > 0 && palm > 0 ? { wrist, knuckle, body } : null;
}

/**
 * How many vertices stand in for each hand, by the stronger of two readings. By place: vertices past the wrist, at
 * least `pastWrist` of the way from the hand bone to the middle knuckle and within `radius` (a share of body height) of
 * that knuckle, whatever bone moves them: a rigid foam hand skinned to the forearm counts. By skinning: vertices with
 * more than half of their weight on the hand's bones (the hand and its fingers), wherever they sit: an oversized glove
 * counts. A sleeve cuff ends at the wrist and blends into the forearm, so it counts for little in both.
 * Null when no mesh is skinned: there is nothing to tell hands from the rest.
 */
function handVertices(doc: Document, pastWrist: number, radius: number): Record<Side, number> | null {
  const placed = { left: 0, right: 0 };
  const skinnedTo = { left: 0, right: 0 };
  let skinned = false;
  const colliders = colliderNodes(doc);
  const vertex = [0, 0, 0];
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    const skin = node.getSkin();
    if (!mesh || !skin || colliders.has(node)) continue;
    const places = SIDES.map((side) => ({ side, place: handPlace(skin, side) }));
    const boneSide = skin.listJoints().map((joint): Side | null => {
      const name = joint.getName();
      return name.startsWith(HAND_BONES.left) ? "left" : name.startsWith(HAND_BONES.right) ? "right" : null;
    });
    for (const prim of mesh.listPrimitives()) {
      const position = prim.getAttribute("POSITION");
      const joints = prim.getAttribute("JOINTS_0")?.getArray();
      const weights = prim.getAttribute("WEIGHTS_0");
      if (!position || !joints || !weights) continue;
      skinned = true;
      for (let v = 0; v < position.getCount(); v++) {
        // getElement decodes KHR_mesh_quantization's normalized integers
        position.getElement(v, vertex);
        for (const { side, place } of places) {
          if (!place) continue;
          const { wrist, knuckle, body } = place;
          const axis = [knuckle[0] - wrist[0], knuckle[1] - wrist[1], knuckle[2] - wrist[2]];
          const along = ((vertex[0] - wrist[0]) * axis[0] + (vertex[1] - wrist[1]) * axis[1] + (vertex[2] - wrist[2]) * axis[2]) / (axis[0] ** 2 + axis[1] ** 2 + axis[2] ** 2);
          const away = Math.hypot(vertex[0] - knuckle[0], vertex[1] - knuckle[1], vertex[2] - knuckle[2]) / body;
          if (along >= pastWrist && away <= radius) placed[side]++;
        }
        const influence = readVec4(weights, v);
        let total = 0;
        const onHand = { left: 0, right: 0 };
        for (let c = 0; c < 4; c++) {
          if (influence[c] <= 0) continue;
          total += influence[c];
          const side = boneSide[joints[v * 4 + c]];
          if (side) onHand[side] += influence[c];
        }
        for (const side of SIDES) if (onHand[side] > total / 2) skinnedTo[side]++;
      }
    }
  }
  return skinned ? { left: Math.max(placed.left, skinnedTo.left), right: Math.max(placed.right, skinnedTo.right) } : null;
}

const share = (n: number): string => `${Math.round(n * 100)}%`;

export const hidesCoverage: CheckDefinition = {
  ...meta,
  title: "Hides match the model",
  describe: "an item that hides the head or the hands covers them, and an upper body that reaches the lower legs hides the lower body.",
  explanation: "Hiding a body part removes it from the avatar. An item that hides the head has to be a head (a helmet that encloses it, a full mask): a hat or a top-head item that hides the head leaves the avatar headless. An item that hides the hands has to model both hands: a top or pants that hide the hands leave the arms ending at the wrist. And a long garment has to hide the slot it covers: a dress in the upper body slot that reaches the lower legs without hiding the lower body lets the pants or skirt the player wears poke through it.",
  fix: "In the Builder, open the item and go to Overrides. Under Base Body, unselect Head or Hands unless the model really replaces them: a head item has to reach from above the head bone down past it towards the neck, and a hands item needs both hands modelled, not one. For a dress, coat or jumpsuit that reaches the lower legs, select Lower body under Wearables (and model the legs it leaves visible), or shorten the garment.",
  details: "For each body shape's model, reads what that version hides (its overrideHides when it has any, otherwise hides, plus replaces). Height is measured against the model's own skeleton in bind pose, from the feet (0%) to the head bone (100%; the neck is near 85%). Hiding the head fails unless the model spans hides.headCoverLine: its lowest point at or below it and its highest point above it. Hiding the hands fails unless each hand has at least hides.hand.minVertices vertices, counted two ways and taking the larger: vertices past the wrist (at least hides.hand.pastWrist of the way from the hand bone to the middle knuckle, and within hides.hand.radius of body height of that knuckle), whatever bone moves them, and vertices with more than half of their skin weight on that hand's bones (Avatar_LeftHand / Avatar_RightHand and their fingers). An upper_body whose lowest point is below hides.longUpperBodyLine and that does not hide lower_body warns. Skins are not checked: a skin replaces the whole avatar. A model whose meshes have no head and feet bones to measure against is not measured for height, and a model with no skinned mesh is not measured for hands.",
  categoryDependent: true,
  appliesTo: (ctx) => {
    const base = wearableGeometryOnly(ctx);
    if (base !== true) return base;
    if (ctx.metadataMode === "none") return "no metadata — hides come from the item manifest";
    if (ctx.category === "skin") return "a skin replaces the whole avatar — the engine hides the body under it";
    return true;
  },
  measure: (ctx) => {
    const model = ctx.models[0];
    if (!model) return undefined;
    const parts = ["head", "hands"].filter((part) => ctx.models.some((m) => hiddenBy(ctx.item, m.mainFile).includes(part)));
    const extent = extentOf(model.doc);
    const span = extent ? `spans ${share(extent.bottom)}–${share(extent.top)} of body height` : "no head and feet bones to measure against";
    return `${parts.length ? `hides ${parts.join(" and ")}` : "hides no body part"} · ${span}`;
  },
  run: (ctx) => {
    const findings: Finding[] = [];
    const { headCoverLine, hand, longUpperBodyLine } = ctx.manifest.hides;
    const measured = new Set<string>();
    for (const model of ctx.models) {
      // body shapes that share a file share its findings
      if (measured.has(model.mainFile)) continue;
      measured.add(model.mainFile);
      const hidden = hiddenBy(ctx.item, model.mainFile);
      const extent = extentOf(model.doc);

      if (hidden.includes("head") && extent && (extent.bottom > headCoverLine || extent.top <= headCoverLine)) {
        const where = extent.bottom > headCoverLine
          ? `its lowest point is at ${share(extent.bottom)} of the height from the feet to the head bone, above the head bone (${share(headCoverLine)})`
          : `its highest point is at ${share(extent.top)} of the height from the feet to the head bone, below the head bone (${share(headCoverLine)})`;
        findings.push(finding(meta, "error",
          `"${model.mainFile}" hides the head but does not cover it: ${where}. Worn, the avatar has no head. In the Builder, under Overrides → Base Body, unselect Head; keep it only if the model is a whole head that reaches down to the neck.`,
          { where: model.mainFile, measured: `${share(extent.bottom)}–${share(extent.top)}`, limit: `spans ${share(headCoverLine)}`, data: { part: "head", bottom: extent.bottom, top: extent.top } }));
      }

      if (hidden.includes("hands")) {
        const hands = handVertices(model.doc, hand.pastWrist, hand.radius);
        const missing = hands ? SIDES.filter((side) => hands[side] < hand.minVertices) : [];
        if (hands && missing.length) {
          const what = missing.length === 2 ? "neither hand" : `no ${missing[0]} hand`;
          const counts = `left hand ${hands.left}, right hand ${hands.right}`;
          findings.push(finding(meta, "error",
            `"${model.mainFile}" hides the hands but models ${what}: vertices at the hands are ${counts}, and each hand needs at least ${hand.minVertices}. Worn, the avatar's ${missing.length === 2 ? "arms end" : `${missing[0]} arm ends`} at the wrist. In the Builder, under Overrides → Base Body, unselect Hands; keep it only if the model includes both hands, skinned to Avatar_LeftHand / Avatar_RightHand and their finger bones.`,
            { where: model.mainFile, measured: counts, limit: `≥ ${hand.minVertices} per hand`, data: { part: "hands", left: hands.left, right: hands.right } }));
        }
      }

      if (ctx.category === "upper_body" && extent && extent.bottom < longUpperBodyLine && !hidden.includes("lower_body")) {
        findings.push(finding(meta, "warning",
          `"${model.mainFile}" is an upper body that reaches down to ${share(extent.bottom)} of body height (below ${share(longUpperBodyLine)}, the lower legs) and does not hide the lower body, so the pants or skirt worn with it can poke through. If it is a dress, a long coat or a jumpsuit, select Lower body under Overrides → Wearables in the Builder; if it is meant to be worn over pants, check it with the default lower bodies.`,
          { where: model.mainFile, measured: share(extent.bottom), limit: `≥ ${share(longUpperBodyLine)} without hiding lower_body`, data: { part: "lower_body", bottom: extent.bottom } }));
      }
    }
    return findings;
  }
};
