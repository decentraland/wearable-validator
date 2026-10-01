/** M-01 Triangle count — per-category budgets keep a full avatar renderable in crowded scenes. */
import { countTriangles } from "../../../logic/gltf.js";
import { wearableGeometryOnly } from "../../../logic/wearable-only.js";
import { effectiveTriangleLimit } from "../../../manifest/index.js";
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

const meta: CheckMeta = { name: "triangle-count", group: "model", rule: "M-01", docs: `${WEARABLES}#building-3d-models-for-wearables` };

export const triangleCount: CheckDefinition = {
  ...meta,
  title: "Triangle count",
  describe: "Triangle count stays within the per-category budget, including hidden-slot pooling.",
  explanation: "Each category has a triangle budget (for example 1,500 for upper body, 500 for eyewear). Hiding other categories adds their budget to yours, up to 4,000 for a helmet that hides the whole head.",
  fix: "Reduce geometry in Blender: add a Decimate modifier, delete faces that are never visible (inside the body), and merge tiny details into textures. Hiding other slots adds their budget to yours.",
  details: "Counts triangles per representation from the mesh data (indices ÷ 3; collider nodes excluded) and compares against the effective budget: the category's base plus every hidden slot's budget, the hidden slots being the representation's overrideHides when it sets them, else the item's hides; a helmet tops out at 4,000 however many head slots it hides.",
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
        findings.push(
          finding(meta, "error",
            `"${model.mainFile}" has ${total} triangles — the limit is ${limit}${pooled}. Remove geometry, or hide more slots to pool their budgets.`,
            { where: model.mainFile, measured: total, limit, data: { category, hides: [...hides] } })
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
