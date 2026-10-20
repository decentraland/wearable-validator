/** M-12 Hides/replaces — self-hides are ignored by the engine. Skins need no hides: the client always hides the base body under them. */
import { wearableGeometryOnly } from "../../../logic/wearable-only.js";
import { finding, type CheckDefinition, type CheckMeta, type Finding } from "../../../types.js";
import { UPLOADING } from "../../docs.js";

const meta: CheckMeta = { name: "hides-replaces", group: "model", rule: "M-12", docs: `${UPLOADING}#overrides` };

export const hidesReplaces: CheckDefinition = {
  ...meta,
  title: "Hides/replaces",
  describe: "hides/replaces don't include the item's own category.",
  explanation: "The hides and replaces lists must make sense — hiding or replacing your own category is redundant (the engine ignores it). Skins don't need to list the base slots: the client hides them under every skin.",
  fix: "Remove the item's own category from hides/replaces (the engine ignores it anyway), and double-check the hidden slots make sense for the design.",
  details: "Checks the hides/replaces lists for the item's own category (a warning: the engine ignores it).",
  categoryDependent: true,
  appliesTo: (ctx) => {
    const base = wearableGeometryOnly(ctx);
    if (base !== true) return base;
    if (ctx.metadataMode === "none") return "no metadata — hides/replaces come from the item manifest";
    return true;
  },
  measure: (ctx) => `hides ${ctx.item.hides?.length ?? 0} · replaces ${ctx.item.replaces?.length ?? 0}`,
  run: (ctx) => {
    const findings: Finding[] = [];
    const category = ctx.category!;
    const hides = ctx.item.hides ?? [];
    const replaces = ctx.item.replaces ?? [];
    if (hides.includes(category)) {
      findings.push(
        finding(meta, "warning",
          `hides includes the item's own category "${category}" — the engine ignores a self-hide, so it's harmless but redundant. Remove "${category}" from hides.`,
          { measured: category, data: { category, hides } })
      );
    }
    if (replaces.includes(category)) {
      findings.push(
        finding(meta, "warning",
          `replaces includes the item's own category "${category}" — the engine ignores a self-replace (replaces is deprecated by ADR-239), so it's harmless but redundant. Remove "${category}" from replaces.`,
          { measured: category, data: { category, replaces } })
      );
    }
    return findings;
  }
};
