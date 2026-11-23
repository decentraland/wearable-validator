/** What an item hides when it is worn, read the way the engine reads it: shared by hides-replaces and hides-coverage. */
import type { NormalizedItem } from "../types.js";

const list = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []);

/**
 * The slots and body parts a body shape's version hides. A version's own overrideHides, when it lists anything, stands
 * in for the item's hides; replaces (deprecated by ADR-239) still hides what it names; an item never hides its own
 * category. `mainFile` picks the version; without one, or with no version of that name, it is the item's own lists.
 * The engine adds hides of its own on top (the base body under a skin), which are not part of this list.
 */
export function hiddenBy(item: NormalizedItem, mainFile?: string): string[] {
  const version = mainFile === undefined ? undefined : item.representations?.find((representation) => representation.mainFile === mainFile);
  const overrideHides = list(version?.overrideHides);
  const overrideReplaces = list(version?.overrideReplaces);
  const hidden = new Set([...(overrideHides.length ? overrideHides : list(item.hides)), ...(overrideReplaces.length ? overrideReplaces : list(item.replaces))]);
  if (item.category) hidden.delete(item.category);
  return [...hidden];
}

/** Slot names as creators read them in the Builder: "top_head" is "top head". */
export const slotLabel = (slot: string): string => slot.replaceAll("_", " ");

/** "a", "a and b", "a, b and c". */
export function listed(names: string[]): string {
  return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}
