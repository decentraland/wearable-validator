/** E-03 Bone targets — tracks that target anything but the avatar's (or prop's) bones never play in-world. */
import type { Node } from "@gltf-transform/core";
import { emoteOnly, parentNode } from "../../../logic/animation.js";
import { listSome } from "../../../logic/format.js";
import { AVATAR_BONE_NAME_SET } from "../../../manifest/index.js";
import { finding, type CheckDefinition, type CheckMeta, type Finding } from "../../../types.js";
import { EMOTES } from "../../docs.js";

const meta: CheckMeta = { name: "bone-targets", group: "emote", rule: "E-03", docs: `${EMOTES}#the-animation-specifications` };

function isUnderNodeNamed(node: Node, name: string): boolean {
  let current: Node | null = node;
  while (current) {
    if (current.getName() === name) return true;
    current = parentNode(current);
  }
  return false;
}

export const boneTargets: CheckDefinition = {
  ...meta,
  title: "Bone targets",
  describe: "animation channels target only canonical avatar bones, spring bones, or prop bones from prop clips",
  explanation: "Animation tracks may only target the avatar's bones (or the prop's). Tracks pointing anywhere else won't play in-world.",
  fix: "Remove animation tracks that target meshes or non-avatar objects — only the avatar's rig bones (and the prop armature) can be animated.",
  details: "Every animation channel must target a canonical avatar bone, a spring bone, or the prop armature — mesh nodes and unknown names fail.",
  appliesTo: emoteOnly,
  measure: (ctx) => {
    let channels = 0;
    for (const model of ctx.models) for (const a of model.doc.getRoot().listAnimations()) channels += a.listChannels().length;
    return `${channels} channels`;
  },
  run: (ctx) => {
    const findings: Finding[] = [];
    const springToken = ctx.manifest.skeleton.springBoneToken.toLowerCase();
    const propArmatureName = ctx.manifest.skeleton.propArmatureName;
    for (const model of ctx.models) {
      for (const anim of model.doc.getRoot().listAnimations()) {
        const clipName = anim.getName();
        const isPropClip = clipName.endsWith("_Prop");
        // one finding per clip and kind, naming every node: a clip retargeted from another rig misses dozens of bones
        const offending = { mesh: new Set<string>(), prop: new Set<string>(), unknown: new Set<string>() };
        for (const channel of anim.listChannels()) {
          const target = channel.getTargetNode();
          if (!target) continue;
          const name = target.getName();
          if (AVATAR_BONE_NAME_SET.has(name)) continue;
          if (name.toLowerCase().includes(springToken)) continue;
          const underProp = isUnderNodeNamed(target, propArmatureName);
          if (underProp && isPropClip) continue;
          offending[target.getMesh() ? "mesh" : underProp ? "prop" : "unknown"].add(name);
        }
        const report = (names: Set<string>, message: (list: string, one: boolean) => string) => {
          if (names.size === 0) return;
          const nodes = [...names];
          findings.push(
            finding(meta, "error", message(listSome(nodes.map((n) => `"${n}"`)), nodes.length === 1), {
              where: nodes.length === 1 ? `${model.mainFile} › ${nodes[0]}` : model.mainFile,
              data: { clip: clipName, nodes }
            })
          );
        };
        report(offending.mesh, (list, one) =>
          `Clip "${clipName}" animates the mesh ${one ? "node" : "nodes"} ${list} — emotes may only animate avatar bones, never meshes or objects. Remove the object animation and animate the skeleton instead.`);
        report(offending.prop, (list, one) =>
          `Clip "${clipName}" animates the prop ${one ? "bone" : "bones"} ${list} — bones under "${propArmatureName}" may only be animated from a clip ending in "_Prop". Move those keys to the prop clip.`);
        report(offending.unknown, (list, one) =>
          `Clip "${clipName}" animates ${list}, which ${one ? "is not a canonical Avatar_* bone" : "are not canonical Avatar_* bones"}. Retarget the animation to the Decentraland skeleton (check the bone names' exact casing).`);
      }
    }
    return findings;
  }
};
