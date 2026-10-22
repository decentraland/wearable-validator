/** What makes an item a smart wearable and where its code is: shared by the bundle check (S-11) and the code review (S-12). */
import type { CheckContext } from "../types.js";

// the Builder keeps a scene bundle per body shape (male/scene.json, female/scene.json); a zip may keep one at its root
const SCENE = /(^|\/)scene\.json$/;

export const sceneFiles = (ctx: CheckContext): string[] => [...ctx.files.keys()].filter((path) => SCENE.test(path));

/** A scene's main script, resolved from the scene file's own folder; undefined when it would leave the item. */
export function resolveMain(scenePath: string, main: string): string | undefined {
  const parts = [...scenePath.split("/").slice(0, -1), ...main.split("/")].filter((part) => part !== "" && part !== ".");
  return parts.includes("..") ? undefined : parts.join("/");
}

export function isSmartWearable(ctx: CheckContext): boolean {
  if (sceneFiles(ctx).length > 0) return true;
  if ((ctx.item.requiredPermissions ?? []).length > 0) return true;
  for (const path of ctx.files.keys()) {
    if (/(^|\/)game\.js$/.test(path)) return true;
  }
  return false;
}

/** The scene file parsed, or undefined when it is not a JSON object. */
export function readScene(ctx: CheckContext, scenePath: string): Record<string, unknown> | undefined {
  try {
    const scene: unknown = JSON.parse(new TextDecoder().decode(ctx.files.get(scenePath)));
    return typeof scene === "object" && scene !== null && !Array.isArray(scene) ? (scene as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
