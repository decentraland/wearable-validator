/** E-05 Root motion — an emote that walks the avatar out of its animation area breaks collision and camera in-world. */
import type { Node } from "@gltf-transform/core";
import { channelKeys, emoteOnly, keyValue, parentNode, round3, type ChannelKeys } from "../../../logic/animation.js";
import { finding, type CheckDefinition, type CheckMeta, type Finding } from "../../../types.js";
import { manifest } from "../../../manifest/index.js";
import { EMOTES } from "../../docs.js";

const meta: CheckMeta = { name: "root-motion", group: "emote", rule: "E-05", docs: `${EMOTES}#the-animation-specifications` };

const RM = manifest.emote.rootMotion;

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function applyMat4(m: number[], p: number[]): [number, number, number] {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]
  ];
}

export const rootMotion: CheckDefinition = {
  ...meta,
  title: "Root motion",
  describe: "the hips stay inside the animation area: a cylinder around the avatar's origin, and near the ground",
  explanation: `The animation must keep the avatar inside the animation area: within ${RM.horizontalWarnMeters} m of the centre (the cylinder in the reference file and the Builder) and near the ground. Up to ${RM.horizontalErrorMeters} m is a warning, for a curator to judge whether the motion has a reason; further is rejected.`,
  fix: `Keep the hips within ${RM.horizontalWarnMeters} m of the centre of the animation area and near the ground — remove keys that walk the avatar away, or start the emote closer to the centre.`,
  details: "Follows the hips translation channel through the rig's rest transforms. Horizontally it measures every key's distance from the vertical axis through the origin, the centre of the animation area, so where the emote starts counts: over emote.rootMotion.horizontalWarnMeters warns, over horizontalErrorMeters fails. Vertically it measures the travel from the first key: over verticalWarnMeters warns, over verticalErrorMeters fails.",
  appliesTo: emoteOnly,
  run: (ctx) => {
    const findings: Finding[] = [];
    const rm = ctx.manifest.emote.rootMotion;
    const hipsPattern = new RegExp(rm.hipsPattern, "i");
    for (const model of ctx.models) {
      const hipChannels: { keys: ChannelKeys; node: Node }[] = [];
      for (const anim of model.doc.getRoot().listAnimations()) {
        for (const channel of anim.listChannels()) {
          if (channel.getTargetPath() !== "translation") continue;
          const node = channel.getTargetNode();
          if (!node || !hipsPattern.test(node.getName())) continue;
          const keys = channelKeys(channel);
          if (!keys || keys.count === 0) continue;
          hipChannels.push({ keys, node });
        }
      }
      if (hipChannels.length === 0) continue;
      const preferred = hipChannels.filter((c) => c.node.getName() === "Avatar_Hips");
      const used = preferred.length > 0 ? preferred : hipChannels;
      let horizontal = 0;
      let vertical = 0;
      for (const { keys, node } of used) {
        const parent = parentNode(node);
        const world = parent ? parent.getWorldMatrix() : IDENTITY;
        let base: [number, number, number] | null = null;
        for (let i = 0; i < keys.count; i++) {
          const p = applyMat4(world, keyValue(keys, i, 3));
          // the animation area is a cylinder around the origin, so every key counts, the first one included
          const h = Math.hypot(p[0], p[2]);
          if (h > horizontal) horizontal = h;
          if (!base) {
            base = p;
            continue;
          }
          const v = Math.abs(p[1] - base[1]);
          if (v > vertical) vertical = v;
        }
      }
      if (horizontal > rm.horizontalErrorMeters) {
        findings.push(
          finding(meta, "error", `The hips get ${round3(horizontal)} m away from the centre of the animation area — emotes must stay within ${rm.horizontalWarnMeters} m of it, and up to ${rm.horizontalErrorMeters} m is accepted with a warning. Reduce the root motion.`, {
            where: model.mainFile,
            measured: round3(horizontal),
            limit: rm.horizontalErrorMeters
          })
        );
      } else if (horizontal > rm.horizontalWarnMeters) {
        findings.push(
          finding(meta, "warning", `The hips get ${round3(horizontal)} m away from the centre of the animation area — emotes should stay within ${rm.horizontalWarnMeters} m of it. Up to ${rm.horizontalErrorMeters} m is accepted when the motion has a reason; a curator decides.`, {
            where: model.mainFile,
            measured: round3(horizontal),
            limit: rm.horizontalWarnMeters
          })
        );
      }
      if (vertical > rm.verticalErrorMeters) {
        findings.push(
          finding(meta, "error", `The hips travel ${round3(vertical)} m vertically — the hard limit is ${rm.verticalErrorMeters} m. Reduce the vertical motion.`, {
            where: model.mainFile,
            measured: round3(vertical),
            limit: rm.verticalErrorMeters
          })
        );
      } else if (vertical > rm.verticalWarnMeters) {
        findings.push(
          finding(meta, "warning", `The hips travel ${round3(vertical)} m vertically — more than ${rm.verticalWarnMeters} m often reads as the avatar leaving the ground. Double-check the motion is intentional.`, {
            where: model.mainFile,
            measured: round3(vertical),
            limit: rm.verticalWarnMeters
          })
        );
      }
    }
    return findings;
  }
};
