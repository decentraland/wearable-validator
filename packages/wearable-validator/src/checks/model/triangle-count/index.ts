/** M-01 Triangle count — per-category budgets keep a full avatar renderable in crowded scenes. */
import { countTriangles } from "../../../logic/gltf.js";
import { wearableGeometryOnly } from "../../../logic/wearable-only.js";
import { effectiveTriangleLimit, manifest } from "../../../manifest/index.js";
import { finding, type CheckContext, type CheckDefinition, type CheckMeta, type Finding } from "../../../types.js";
import { WEARABLES } from "../../docs.js";

/**
 * The slots a model's representation hides: its own overrideHides when it sets any, else the item's hides — the engine
 * reads them the same way. A model several representations share must fit each of their budgets.
 */
function hidesFor(ctx: CheckContext, mainFile: string): string[][] {
  const itemHides = ctx.item.hides ?? [];
  const sets = (ctx.item.representations ?? [])
    .filter((rep) => rep.mainFile === mainFile)
    .map((rep) => [...new Set(rep.overrideHides && rep.overrideHides.length > 0 ? rep.overrideHides : itemHides)]);
  return sets.length > 0 ? sets : [[...new Set(itemHides)]];
}

/**
 * The tolerated share and how far over a count is, both as percentages at the tolerated share's own precision (10, or
 * 12.5), the excess rounded up: a count past the margin never reads as the tolerated share, one within never above it.
 */
export function marginText(ratio: number, total: number, limit: number): { tolerated: string; over: string } {
  const percent = ratio * 100;
  const decimals = [0, 1, 2].find((d) => Math.abs(Math.round(percent * 10 ** d) - percent * 10 ** d) < 1e-6) ?? 2;
  const scale = 10 ** decimals;
  const over = Math.ceil(((total - limit) * 100 * scale) / limit - 1e-9) / scale;
  return { tolerated: (Math.round(percent * scale) / scale).toFixed(decimals), over: over.toFixed(decimals) };
}

const TOLERATED = marginText(manifest.triangles.warningMarginRatio, 0, 1).tolerated;

const meta: CheckMeta = { name: "triangle-count", group: "model", rule: "M-01", docs: `${WEARABLES}#building-3d-models-for-wearables` };

export const triangleCount: CheckDefinition = {
  ...meta,
  title: "Triangle count",
  describe: "Triangle count stays within the per-category budget, including hidden-slot pooling.",
  explanation: `Each category has a triangle budget (for example 1,500 for upper body, 500 for eyewear). Hiding other categories adds their budget to yours: hiding the base hands adds 500, and an item that hides the whole head may reach 4,000. Up to ${TOLERATED}% over the budget is a warning; more than that is rejected.`,
  fix: "Reduce geometry in Blender: add a Decimate modifier, delete faces that are never visible (inside the body), and merge tiny details into textures. Hiding other slots adds their budget to yours.",
  details: "Counts triangles per representation from the mesh data (indices ÷ 3; collider nodes excluded) and compares against the effective budget: the category's base plus every hidden slot's budget, the hidden slots being the representation's overrideHides when it sets them, else the item's hides. Hiding the base hands adds 500; hiding the head counts as hiding every head slot; a helmet, or anything hiding the head, tops out at 4,000. A count over the budget by at most triangles.warningMarginRatio of it (rounded down) warns; above that it fails.",
  categoryDependent: true,
  appliesTo: wearableGeometryOnly,
  measure: (ctx) => {
    const counts = ctx.models.map((m) => countTriangles(m.doc).total);
    if (counts.length === 0) return undefined;
    return `${Math.max(...counts).toLocaleString("en")} tris`;
  },
  run: (ctx) => {
    const findings: Finding[] = [];
    const category = ctx.category!;
    for (const model of ctx.models) {
      const { total, hasStripOrFan } = countTriangles(model.doc);
      // the strictest budget among the representations this model is drawn for
      const [hides, limit] = hidesFor(ctx, model.mainFile)
        .map((set) => [set, effectiveTriangleLimit(category, set)] as const)
        .reduce((strictest, next) => (next[1] < strictest[1] ? next : strictest));
      if (total > limit) {
        const pooled = hides.length > 0 ? ` (base budget for ${category} plus the hidden slots: ${hides.join(", ")})` : ` for ${category}`;
        const ratio = ctx.manifest.triangles.warningMarginRatio;
        const margin = Math.floor(limit * ratio);
        const { tolerated, over } = marginText(ratio, total, limit);
        const within = total <= limit + margin;
        findings.push(
          finding(meta, within ? "warning" : "error",
            within
              ? `"${model.mainFile}" has ${total} triangles, ${over}% over the limit of ${limit}${pooled}. Up to ${tolerated}% over (${limit + margin}) is accepted with a warning; trim geometry to stay within the budget.`
              : `"${model.mainFile}" has ${total} triangles, ${over}% over the limit of ${limit}${pooled}; up to ${tolerated}% over (${limit + margin}) is accepted. Remove geometry, or hide more slots to pool their budgets.`,
            { where: model.mainFile, measured: total, limit, data: { category, hides: [...hides], tolerated: limit + margin } })
        );
      }
      if (hasStripOrFan) {
        findings.push(
          finding(meta, "warning",
            `"${model.mainFile}" uses TRIANGLE_STRIP/FAN primitives — these count as vertices−2 triangles per glTF, but most exporters emit plain triangle lists. Re-export with triangles for predictable counting.`,
            { where: model.mainFile })
        );
      }
    }
    return findings;
  }
};
