/** V-01 Renders at all — a model the previewer draws as nothing is broken for everyone, whatever the other rules say. */
import { captureRequest, inputDigest, rendererBuild, resolveCaptures } from "../../../logic/captures.js";
import { subjectRatio } from "../../../logic/pixels.js";
import { finding, type CaptureRecord, type CaptureRequest, type CheckContext, type CheckDefinition, type CheckExecution, type CheckMeta, type Finding } from "../../../types.js";
import { WEARABLES } from "../../docs.js";

const meta: CheckMeta = { name: "render-valid", group: "rendering", rule: "V-01", docs: `${WEARABLES}#building-3d-models-for-wearables` };

/** One front view per body shape: the item alone for wearables, the avatar at the clip start for emotes. */
export async function renderValidRequests(ctx: CheckContext, build: string): Promise<CaptureRequest[] | string> {
  const representations = ctx.item.representations;
  if (!ctx.category || !representations?.length) return "Provide the item's category and declared body-shape representations to render it.";
  for (const path of new Set(representations.flatMap((rep) => rep.contents))) {
    if (!ctx.files.has(path)) return `Add the declared file "${path}" before rendering.`;
  }
  const digest = await inputDigest(ctx);
  const requests: CaptureRequest[] = [];
  for (const rep of representations) {
    if (!rep.contents.includes(rep.mainFile) || !rep.bodyShapes.length) return "Each representation needs a body shape and its main file in contents.";
    for (const bodyShape of rep.bodyShapes) {
      if (!ctx.manifest.rendering.bodyShapes.includes(bodyShape)) return "Declare each supported body shape once, with its own representation.";
      requests.push(await captureRequest(ctx, {
        inputDigest: digest,
        rendererBuild: build,
        recipeVersion: ctx.manifest.rendering.recipeVersion,
        bodyShape,
        mainFile: rep.mainFile,
        view: ctx.itemType === "wearable" ? "wearable" : "avatar",
        azimuthDegrees: 0,
        ...(ctx.itemType === "emote" ? { timeFraction: 0 } : {}),
        size: ctx.manifest.rendering.imageSizePx
      }));
    }
  }
  return requests;
}

/** Captures whose subject share is under the manifest floor — the same test render-valid reports, reused as a guard by other rules. */
export function emptyCaptures(ctx: CheckContext, captures: CaptureRecord[]): { capture: CaptureRecord; ratio: number }[] {
  const { minSubjectRatio, backgroundTolerance } = ctx.manifest.renderValid;
  const empty: { capture: CaptureRecord; ratio: number }[] = [];
  for (const capture of captures) {
    const ratio = subjectRatio(capture.bytes, backgroundTolerance) ?? 0;
    if (ratio < minSubjectRatio) empty.push({ capture, ratio });
  }
  return empty;
}

const percent = (ratio: number): string => `${(ratio * 100).toFixed(ratio < 0.01 ? 2 : 1)}%`;
/** A measured share, rounded down: a view just under a limit never reads as meeting it (0.0499 % shows as 0.04 %). */
function drawn(ratio: number): string {
  const digits = ratio < 0.01 ? 2 : 1;
  return `${(Math.floor(ratio * 10 ** (digits + 2) + 1e-9) / 10 ** digits).toFixed(digits)}%`;
}

function skipped(reason: string): CheckExecution {
  return { status: "skipped", coverage: "missing", findings: [], reason };
}

export const renderValid: CheckDefinition = {
  ...meta,
  title: "Renders at all",
  describe: "the item draws something visible on every declared body shape",
  explanation: "Before anything else is judged, the item has to show up: a model that loads but draws nothing (missing textures, broken materials, wrong scale) is broken for everyone who equips it.",
  fix: "Open the exported GLB in the Builder preview or Blender's glTF import. If it shows nothing, re-export with textures embedded, materials assigned, and the mesh at avatar scale (about 2 m tall). If it shows but tiny, check its scale against the avatar.",
  details: "Renders the item alone (wearables) or the avatar at the clip start (emotes) for each declared body shape, then measures how much of the frame is not backdrop: pixels whose red, green or blue sits farther than the manifest tolerance from the same channel of their row's first pixel, the backdrop. Below renderValid.minSubjectRatio the view counts as empty and fails; below renderValid.warnSubjectRatio it draws something but little, which is normal for small accessories and thin bands, so it is a warning to check the item's scale against the avatar.",
  appliesTo: (ctx) =>
    ctx.category && ctx.manifest.facialCategories.includes(ctx.category) ? "facial textures are not rendered on the avatar yet" : true,
  run: async (ctx) => {
    if (ctx.parseError) return skipped(`Fix the model before rendering it: ${ctx.parseError}`);
    const build = rendererBuild(ctx);
    if (!build) return skipped("Configure services.renderer to render the item, or supply captures from one renderer build.");
    const requests = await renderValidRequests(ctx, build);
    if (typeof requests === "string") return skipped(requests);
    const captures = await resolveCaptures(ctx, requests);
    if (typeof captures === "string") return skipped(captures);
    const { minSubjectRatio, warnSubjectRatio, backgroundTolerance } = ctx.manifest.renderValid;
    const findings: Finding[] = [];
    const ratios: number[] = [];
    for (const capture of captures) {
      const ratio = subjectRatio(capture.bytes, backgroundTolerance) ?? 0;
      ratios.push(ratio);
      const shape = capture.request.bodyShape.split(":").pop() ?? capture.request.bodyShape;
      const evidence = { where: capture.request.mainFile, measured: drawn(ratio), evidence: [{ captureId: capture.request.id }] };
      if (ratio < minSubjectRatio) {
        findings.push(finding(meta, "error",
          `"${capture.request.mainFile}" renders as nothing visible on ${shape}: ${drawn(ratio)} of the frame is drawn, the floor is ${percent(minSubjectRatio)}. Re-export with textures embedded and materials assigned, at avatar scale.`,
          { ...evidence, limit: `≥ ${percent(minSubjectRatio)}` }));
      } else if (ratio < warnSubjectRatio) {
        findings.push(finding(meta, "warning",
          `"${capture.request.mainFile}" draws only ${drawn(ratio)} of the frame on ${shape}. That is normal for small accessories and thin bands; if the item should look bigger, check its scale against the avatar in your 3D tool.`,
          { ...evidence, limit: `≥ ${percent(warnSubjectRatio)}` }));
      }
    }
    const measured = `${captures.length} views · ${drawn(Math.min(...ratios))} drawn at least`;
    if (findings.some((f) => f.severity === "error")) return { status: "failed", coverage: "complete", findings, measured };
    if (findings.length) return { status: "warning", coverage: "complete", findings, measured };
    return { status: "passed", coverage: "complete", findings: [], measured };
  }
};
