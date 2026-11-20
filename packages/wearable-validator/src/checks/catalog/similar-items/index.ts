/**
 * D-01 Similar items — a model that is mostly someone else's published mesh gets a warning that names that item, so the
 * creator can say it is theirs, ask for permission or change it before a curator or the original's creator finds it.
 */
import { fingerprintModel } from "../../../logic/fingerprint.js";
import { skipped } from "../../../logic/review.js";
import { finding, type CatalogMatch, type CheckContext, type CheckDefinition, type CheckExecution, type CheckMeta, type Finding } from "../../../types.js";
import { POLICY } from "../../docs.js";

const meta: CheckMeta = { name: "similar-items", group: "catalog", rule: "D-01", docs: POLICY };

const percent = (share: number): string => `${Math.floor(share * 100)}%`;
const day = (unixSeconds: number): string => new Date(unixSeconds * 1000).toISOString().slice(0, 10);
const source = (match: CatalogMatch): string => `"${match.name}", published on ${day(match.publishedAt)} by ${match.creator}: ${match.url}`;
const PERMISSION = "If it is your own work, or you have that creator's permission, you can publish. If it is based on that item without permission, change the model or ask its creator first.";

const creators = (matches: CatalogMatch[]): number => new Set(matches.map((match) => match.creator.toLowerCase())).size;

/**
 * Matches of one uploaded model, split into what the rule warns about. Geometry that templateCreators or more creators
 * already published has no original to point at, whether the model is that geometry or contains it.
 */
export function judge(matches: CatalogMatch[], rules: CheckContext["manifest"]["similarItems"]): { similar?: CatalogMatch; template: boolean; contained: CatalogMatch[] } {
  const earliestFirst = [...matches].sort((a, b) => a.publishedAt - b.publishedAt);
  const similar = earliestFirst.filter((match) => match.share >= rules.warnShare);
  const inside = earliestFirst.filter((match) => match.contains >= rules.containsShare);
  const template = creators(similar) >= rules.templateCreators;
  const contained = creators(inside) >= rules.templateCreators ? [] : inside.filter((match) => match.share < rules.warnShare);
  return { similar: template ? undefined : similar[0], template, contained };
}

export const similarItems: CheckDefinition = {
  ...meta,
  title: "Similar to a published item",
  describe: "The model's geometry is compared with every published item by other creators; a model that is mostly an existing mesh, or contains one whole, gets a warning naming that item.",
  explanation: "Publishing someone else's model with a new texture is the most common way work gets copied in the marketplace. This compares your model's mesh with the items already published and tells you when it is nearly the same as one of them, or contains one of them, with a link so you can see which.",
  fix: "Open the linked item. If it is yours (another wallet, an earlier collection) or you have its creator's permission, you can publish: this is a warning, not a rejection. If your model is based on it without permission, model your own mesh or ask its creator before publishing.",
  details: "Textures, materials, UVs and names are ignored; colliders and skin-material meshes are left out. Position: the share of the model's vertices, snapped to a similarItems.gridMillimeters grid at bind pose (whatever pose the file was saved in), that sit where a published model has one. Shape: the share of its triangles in connected parts (at least minPartTriangles triangles) whose triangles connect the same way and have the same proportions (within ratioTolerance) as a part of the published model, so a copy that was moved or scaled still matches. Base-avatar geometry and geometry found in the items of commonCreators or more creators are removed first. A warning when either share reaches warnShare against an item by another creator, naming the earliest; none when templateCreators or more creators had already published that geometry. A second kind of warning when containsShare of a published item sits inside the model, with the same template exemption. At most maxFindings warnings per item. The uploader's own items (Options.ownCreators) never match. Skipped without a catalog, and for a model with more than maxElements vertices, indices and skin joints to read.",
  appliesTo: (ctx) => (ctx.models.length > 0 || ctx.parseError ? true : "no model to compare"),
  run: async (ctx): Promise<Finding[] | CheckExecution> => {
    const catalog = ctx.services?.catalog;
    if (!catalog) return skipped("Configure services.catalog to compare with published items.");
    const rules = ctx.manifest.similarItems;
    const fingerprints = [];
    for (const model of ctx.models) {
      const fingerprint = fingerprintModel(model.doc, rules, ctx.manifest.materials.skinNameToken, ctx.signal);
      if (!fingerprint) return skipped(`"${model.mainFile}" has more than ${rules.maxElements.toLocaleString("en-US")} vertices and indices to read, too many to compare with published items.`);
      fingerprints.push(fingerprint);
    }
    const answer = await catalog.match(fingerprints, { ownCreators: ctx.ownCreators, signal: ctx.signal });
    if (!answer.compared) return { status: "passed", coverage: "complete", findings: [], measured: "too little geometry of its own to compare" };
    const findings: Finding[] = [];
    const seen = new Set<string>();
    let templates = 0;
    ctx.models.forEach((model, index) => {
      const { similar, template, contained } = judge(answer.matches.filter((match) => match.model === index), rules);
      if (template) templates++;
      // both body shapes usually carry the same mesh: one warning per published item, not one per file
      if (similar && !seen.has(similar.urn) && findings.length < rules.maxFindings) {
        seen.add(similar.urn);
        findings.push(finding(meta, "warning",
          `${percent(similar.share)} of the geometry of "${model.mainFile}" matches ${source(similar)}. ${PERMISSION}`,
          { where: model.mainFile, measured: percent(similar.share), limit: percent(rules.warnShare), data: { urn: similar.urn, url: similar.url, creator: similar.creator, position: similar.position, shape: similar.shape } }));
      }
      for (const match of contained) {
        if (seen.has(match.urn) || findings.length >= rules.maxFindings) continue;
        seen.add(match.urn);
        findings.push(finding(meta, "warning",
          `"${model.mainFile}" contains ${percent(match.contains)} of ${source(match)}. If that part is your own work, or you have that creator's permission, you can publish. If not, replace that part or ask its creator first.`,
          { where: model.mainFile, measured: percent(match.contains), limit: percent(rules.containsShare), data: { urn: match.urn, url: match.url, creator: match.creator, contains: match.contains } }));
      }
    });
    const measured = findings.length > 0 ? `${findings.length} similar published item${findings.length === 1 ? "" : "s"}` : templates > 0 ? "a widely used template" : "no similar published item";
    return { status: findings.length > 0 ? "warning" : "passed", coverage: "complete", findings, measured };
  }
};
