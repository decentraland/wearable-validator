/** S-10 glTF hygiene — cameras, lights and unsupported extensions are ignored by the engine and only add weight or break parsing. */
import { isGlb, readModelJson } from "../../../logic/gltf.js";
import { isFacial } from "../../../logic/facial.js";
import { finding, type CheckDefinition, type CheckMeta, type Finding } from "../../../types.js";
import { WEARABLES } from "../../docs.js";

const meta: CheckMeta = { name: "gltf-hygiene", group: "files", rule: "S-10", docs: `${WEARABLES}#building-3d-models-for-wearables` };

const LIGHTS_EXTENSION = "KHR_lights_punctual";

/** True when the node's rotation maps the local Y axis to ±world Z within `tolDeg` — a Z-up export. */
function isZUpRotation(quaternion: [number, number, number, number], tolDeg: number): boolean {
  const [x, y, z, w] = quaternion;
  const rotatedYz = 2 * w * x + 2 * y * z; // Z component of the quaternion-rotated Y axis
  return Math.abs(rotatedYz) >= Math.cos((tolDeg * Math.PI) / 180);
}

export const gltfHygiene: CheckDefinition = {
  ...meta,
  title: "glTF hygiene",
  describe: "no cameras or lights; extensions allowlisted; Y-up orientation",
  explanation: "The model must not include cameras, lights or unsupported extensions — the engine ignores them, they only add weight.",
  fix: "Delete cameras and lights from the scene before exporting (or untick 'Cameras' and 'Punctual Lights' in Blender's glTF export panel). Disable unsupported material extensions.",
  details:
    "Reads the raw glTF JSON — even when the model won't parse: cameras and lights are errors; required extensions outside the supported allowlist are errors; unknown used extensions warn.",
  measure: (ctx) => {
    const extensions = new Set<string>();
    for (const model of ctx.models) {
      const used = model.json.extensionsUsed;
      if (Array.isArray(used)) for (const ext of used as string[]) extensions.add(ext);
    }
    return `${extensions.size} extension${extensions.size === 1 ? "" : "s"} used`;
  },
  appliesTo: (ctx) => (isFacial(ctx) ? "facial-feature wearables carry no GLB model" : true),
  run: (ctx) => {
    const findings: Finding[] = [];
    const allowlist = new Set(ctx.manifest.gltf.extensionAllowlist);
    // Read raw GLB JSON chunks independently of gltf-transform: a GLB with an
    // unsupported required extension refuses to parse — exactly when this check matters.
    const inspected: { where: string; json: Record<string, unknown>; rotationSource?: (typeof ctx.models)[number] }[] = [];
    const parsedByFile = new Map(ctx.models.map((m) => [m.mainFile, m]));
    for (const [path, bytes] of ctx.files) {
      if (!(path.endsWith(".glb") && isGlb(bytes)) && !path.endsWith(".gltf")) continue;
      try {
        inspected.push({ where: path, json: readModelJson(bytes), rotationSource: parsedByFile.get(path) });
      } catch {
        // gltf-valid (S-02) reports unreadable containers
      }
    }
    for (const model of inspected) {
      const where = model.where;
      const json = model.json;
      const cameras = json.cameras;
      if (Array.isArray(cameras) && cameras.length > 0) {
        findings.push(
          finding(meta, "error", `"${where}" contains ${cameras.length} camera(s) — remove cameras before exporting; they are not allowed in item GLBs.`, {
            where,
            measured: cameras.length
          })
        );
      }
      const used = Array.isArray(json.extensionsUsed) ? (json.extensionsUsed as string[]) : [];
      const required = Array.isArray(json.extensionsRequired) ? (json.extensionsRequired as string[]) : [];
      if (used.includes(LIGHTS_EXTENSION) || required.includes(LIGHTS_EXTENSION)) {
        findings.push(
          finding(meta, "error", `"${where}" contains lights (${LIGHTS_EXTENSION}) — remove lights before exporting; they are not allowed in item GLBs.`, { where })
        );
      }
      for (const ext of required) {
        if (ext === LIGHTS_EXTENSION || allowlist.has(ext)) continue;
        findings.push(
          finding(meta, "error", `"${where}" requires the extension "${ext}", which renderers are not guaranteed to support — export without it. Allowed: ${[...allowlist].join(", ")}.`, {
            where,
            data: { extension: ext }
          })
        );
      }
      for (const ext of used) {
        if (ext === LIGHTS_EXTENSION || allowlist.has(ext) || required.includes(ext)) continue;
        findings.push(
          finding(meta, "warning", `"${where}" uses the extension "${ext}", which is outside the supported set — it may be ignored by renderers.`, {
            where,
            data: { extension: ext }
          })
        );
      }

      // Off by default: fired on virtually every committee-approved catalyst item (see manifest discrepancies).
      const zUpEnabled = (ctx.manifest.gltf as { zUpHeuristic?: boolean }).zUpHeuristic === true;
      const tolDeg = ctx.manifest.epsilons.zUpRotationToleranceDegrees;
      const parsed = model.rotationSource;
      const scene = parsed ? parsed.doc.getRoot().getDefaultScene() ?? parsed.doc.getRoot().listScenes()[0] : undefined;
      for (const node of zUpEnabled && scene ? scene.listChildren() : []) {
        if (isZUpRotation(node.getRotation(), tolDeg)) {
          findings.push(
            finding(
              meta,
              "warning",
              `"${where}"'s root node "${node.getName()}" is rotated ±90° about X — this looks like a Z-up export. Export with Y-up (the Blender toolkit does this automatically).`,
              { where, data: { node: node.getName() } }
            )
          );
          break; // one Z-up warning per model is enough
        }
      }
    }
    return findings;
  }
};
