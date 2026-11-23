/**
 * M-12 Hides/replaces — the lists say what disappears when the item is worn. An item cannot hide itself, and a skin has
 * to hide the accessory slots the engine leaves visible on top of it (curators send skins back for it).
 */
import { hiddenBy, listed, slotLabel } from "../../../logic/hides.js";
import { wearableGeometryOnly } from "../../../logic/wearable-only.js";
import { finding, type CheckContext, type CheckDefinition, type CheckMeta, type Finding } from "../../../types.js";
import { UPLOADING } from "../../docs.js";

const meta: CheckMeta = { name: "hides-replaces", group: "model", rule: "M-12", docs: `${UPLOADING}#overrides` };

/** The slots a skin leaves visible, per version: one entry when every version hides the same, one per file otherwise. */
function skinGaps(ctx: CheckContext): { where?: string; missing: string[] }[] {
  const { skinMustHide } = ctx.manifest.hides;
  const missingFor = (mainFile?: string): string[] => {
    const hidden = hiddenBy(ctx.item, mainFile);
    return skinMustHide.filter((slot) => !hidden.includes(slot));
  };
  const files = [...new Set((ctx.item.representations ?? []).map((representation) => representation.mainFile))];
  const perFile = files.map((file) => ({ where: file, missing: missingFor(file) }));
  const same = perFile.every((entry) => entry.missing.join() === perFile[0].missing.join());
  const gaps = perFile.length && !same ? perFile : [{ missing: perFile[0]?.missing ?? missingFor() }];
  return gaps.filter((gap) => gap.missing.length > 0);
}

export const hidesReplaces: CheckDefinition = {
  ...meta,
  title: "Hides/replaces",
  describe: "hides/replaces don't name the item's own category, and a skin hides every accessory slot.",
  explanation: "The hides list (Overrides in the Builder) says which slots and body parts disappear when the item is worn. An item cannot hide its own category, so that entry does nothing. A skin replaces the whole avatar: the engine hides the body, hair, facial hair, clothes, shoes and hand accessories under it, but a mask, eyewear, earring, tiara, top-head item, hat or helmet the player also wears is still drawn on top unless the skin hides those slots. Curators ask skins to hide all of them.",
  fix: "In the Builder, open the item, go to Overrides and edit the two lists (Base Body and Wearables). Remove the item's own category. For a skin, under Wearables select mask, eyewear, earring, tiara, top head, hat and helmet (and every other option offered), then save and publish again.",
  details: "Reads hides and replaces from the item's metadata. The item's own category in either list warns. For a skin, each body shape's list (its overrideHides when it has any, otherwise hides, plus replaces) must contain every slot in hides.skinMustHide; the missing ones are named in a warning. Head, hands, hair, facial hair, upper body, lower body, feet and hand accessories are not required: the engine hides them under every skin.",
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
          `hides includes the item's own category "${category}". An item cannot hide itself, so this entry does nothing. Remove "${category}" from hides, and check that the rest of the list hides only what the item covers.`,
          { measured: category, data: { category, hides } })
      );
    }
    if (replaces.includes(category)) {
      findings.push(
        finding(meta, "warning",
          `replaces includes the item's own category "${category}". An item cannot replace itself, so this entry does nothing (replaces is deprecated by ADR-239). Remove "${category}" from replaces.`,
          { measured: category, data: { category, replaces } })
      );
    }
    if (category === "skin") {
      const required = ctx.manifest.hides.skinMustHide;
      for (const { where, missing } of skinGaps(ctx)) {
        const names = listed(missing.map(slotLabel));
        findings.push(
          finding(meta, "warning",
            `${where ? `"${where}": this` : "This"} skin does not hide ${names} (${missing.length} of the ${required.length} accessory slots a skin must hide). The engine hides the body and clothes under a skin, but not these slots, so ${missing.length === 1 ? "an item worn there" : "items worn there"} would be drawn on top of the skin. In the Builder, under Overrides → Wearables, select ${names}.`,
            { where, measured: `${required.length - missing.length} of ${required.length} hidden`, limit: `all ${required.length}`, data: { category, missing } })
        );
      }
    }
    return findings;
  }
};
