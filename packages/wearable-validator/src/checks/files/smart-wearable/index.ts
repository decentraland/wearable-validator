/** S-11 Smart wearable — a scene bundle runs code on every wearer's client, so it must be complete, permission-scoped and within the video cap. */
import { RequiredPermission } from "@dcl/schemas";
import { mb } from "../../../logic/bytes.js";
import { finding, type CheckContext, type CheckDefinition, type CheckMeta, type Finding } from "../../../types.js";
import { SMART } from "../../docs.js";

const meta: CheckMeta = { name: "smart-wearable", group: "files", rule: "S-11", docs: SMART };

const PERMISSION_VALUES: Set<string> = new Set(Object.values(RequiredPermission));

// the Builder keeps a scene bundle per body shape (male/scene.json, female/scene.json); a zip may keep one at its root
const SCENE = /(^|\/)scene\.json$/;

const sceneFiles = (ctx: CheckContext): string[] => [...ctx.files.keys()].filter((path) => SCENE.test(path));

/** A scene's main script, resolved from the scene file's own folder; undefined when it would leave the item. */
function resolveMain(scenePath: string, main: string): string | undefined {
  const parts = [...scenePath.split("/").slice(0, -1), ...main.split("/")].filter((part) => part !== "" && part !== ".");
  return parts.includes("..") ? undefined : parts.join("/");
}

function isSmartWearable(ctx: CheckContext): boolean {
  if (sceneFiles(ctx).length > 0) return true;
  if ((ctx.item.requiredPermissions ?? []).length > 0) return true;
  for (const path of ctx.files.keys()) {
    if (/(^|\/)game\.js$/.test(path)) return true;
  }
  return false;
}

export const smartWearable: CheckDefinition = {
  ...meta,
  title: "Smart wearable",
  describe: "scene bundle complete, permissions allowlisted, video within limits, no stray empty files",
  explanation: "Smart wearables must include a complete scene bundle, request only allowed permissions, and keep the preview video under 250 MB.",
  fix: "Include the complete scene bundle (scene.json + code), request only allowed permissions, and keep the preview video under 250 MB.",
  details: "Checks each scene bundle is complete (every scene.json, at the root or in a body shape's folder, with its main script beside it), requested permissions are in the allowed set, video files stay under the cap (by size — never decoded), and reports stray zero-byte files.",
  measure: (ctx) => (ctx.emptyFiles.length > 0 ? `${ctx.emptyFiles.length} empty files` : undefined),
  appliesTo: (ctx) =>
    isSmartWearable(ctx) || ctx.emptyFiles.length > 0 ? true : "not a smart wearable (no scene.json, game.js bundle, or requiredPermissions) and no empty files",
  run: (ctx) => {
    const findings: Finding[] = [];
    for (const path of ctx.emptyFiles) {
      findings.push(
        finding(meta, "error", `"${path}" is a 0-byte file — empty files break deployment (it was ignored during validation). Remove it from the zip.`, { where: path })
      );
    }
    if (!isSmartWearable(ctx)) return findings;

    const scenes = sceneFiles(ctx);
    if (scenes.length === 0) findings.push(finding(meta, "error", "The item looks like a smart wearable but has no scene.json — include the scene definition."));
    const scenePermissions: string[] = [];
    for (const scenePath of scenes) {
      let scene: unknown;
      try {
        scene = JSON.parse(new TextDecoder().decode(ctx.files.get(scenePath)));
      } catch {
        scene = undefined;
      }
      if (typeof scene !== "object" || scene === null || Array.isArray(scene)) {
        findings.push(finding(meta, "error", `"${scenePath}" is not a valid scene definition (a JSON object) — re-export the smart wearable.`, { where: scenePath }));
        continue;
      }
      const { main, requiredPermissions } = scene as { main?: unknown; requiredPermissions?: unknown };
      const mainPath = typeof main === "string" && main !== "" ? resolveMain(scenePath, main) : undefined;
      if (typeof main !== "string" || main === "") {
        findings.push(finding(meta, "error", `"${scenePath}" declares no main script — set "main" to the compiled JS bundle.`, { where: scenePath }));
      } else if (!mainPath || !ctx.files.has(mainPath)) {
        findings.push(finding(meta, "error", `"${scenePath}" points at "${main}" but that file is not in the item next to it — include the compiled bundle.`, { where: mainPath ?? main }));
      }
      if (Array.isArray(requiredPermissions)) scenePermissions.push(...requiredPermissions.filter((p): p is string => typeof p === "string"));
    }

    const permissions = new Set([...(ctx.item.requiredPermissions ?? []), ...scenePermissions]);
    for (const permission of permissions) {
      if (!PERMISSION_VALUES.has(permission)) {
        findings.push(
          finding(meta, "warning", `Required permission "${permission}" is not in the allowed set (${[...PERMISSION_VALUES].join(", ")}) — it will be flagged for committee review.`, {
            where: "requiredPermissions",
            data: { permission }
          })
        );
      }
    }

    const videoLimit = ctx.manifest.fileSize.smartWearableVideoBytes;
    for (const [path, bytes] of ctx.files) {
      if (path.endsWith(".mp4") && bytes.length > videoLimit) {
        findings.push(
          finding(meta, "error", `Video "${path}" is ${mb(bytes.length)} MB; the maximum is ${mb(videoLimit)} MB.`, {
            where: path,
            measured: bytes.length,
            limit: videoLimit
          })
        );
      }
    }
    return findings;
  }
};
