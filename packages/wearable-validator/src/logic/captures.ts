/**
 * Visual evidence helpers shared by every rendering-group check — isomorphic, pure.
 * Previous hop: checks/<rule>.ts expands its recipe into CaptureRequests and calls resolveCaptures().
 * Next hop: supplied captures are reused, the rest come from services.renderer (/rendering);
 * the ordered CaptureRecords go back to the check, which hands them to services.reviewer.
 */
import { imageSize } from "image-size";
import { decodePngSafe, isPngBytes } from "./images.js";
import type { CaptureRecord, CaptureRequest, CheckContext, RenderInput } from "../types.js";

export async function digest(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** sha256 of JSON with recursively sorted keys — key order never changes an identity. */
export function digestJson(value: unknown): Promise<string> {
  const canonical = JSON.stringify(value, (_key, entry: unknown) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
    const record = entry as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, record[key]]));
  });
  return digest(new TextEncoder().encode(canonical));
}

/** Everything that changes what the renderer draws: declared file bytes plus the metadata the previewer reads. */
export async function inputDigest(ctx: CheckContext): Promise<string> {
  const paths = [...new Set(ctx.item.representations?.flatMap((rep) => rep.contents) ?? [])].sort();
  const files: [string, string][] = [];
  for (const path of paths) {
    const bytes = ctx.files.get(path);
    if (bytes) files.push([path, await digest(bytes)]);
  }
  return digestJson({
    files,
    category: ctx.category,
    itemType: ctx.itemType,
    representations: ctx.item.representations,
    hides: ctx.item.hides ?? [],
    replaces: ctx.item.replaces ?? [],
    loop: ctx.item.loop,
    springBones: ctx.item.springBones
  });
}

/** The renderer's build, else the one build every supplied capture shares; undefined for none or mixed. */
export function rendererBuild(ctx: CheckContext): string | undefined {
  if (ctx.services?.renderer) return ctx.services.renderer.buildId;
  const builds = new Set(ctx.captures?.map((capture) => capture.request.rendererBuild));
  return builds.size === 1 ? [...builds][0] : undefined;
}

/** Fills id (PNG stem / model image id) and key (reuse identity: every field + the scene settings). */
export async function captureRequest(ctx: CheckContext, fields: Omit<CaptureRequest, "id" | "key">): Promise<CaptureRequest> {
  const { background, skin, wearablePose, wearablePoseFraction } = ctx.manifest.rendering;
  const shape = fields.bodyShape.split(":").pop() ?? fields.bodyShape;
  const pose = fields.pose ? `-${fields.pose}` : "";
  const time = fields.timeFraction === undefined ? "" : `-t${fields.timeFraction}`;
  const id = `${shape}-${fields.view}${pose}-${String(fields.azimuthDegrees).padStart(3, "0")}${time}`;
  const key = await digestJson({ ...fields, scene: { background, skin, wearablePose, wearablePoseFraction } });
  return { id, key, ...fields };
}

/** A capture counts only when it is the PNG the request asked for and its bytes match its own sha256. */
export async function validCapture(capture: CaptureRecord, request: CaptureRequest, maxBytes: number): Promise<boolean> {
  try {
    if (!(capture.bytes instanceof Uint8Array) || capture.bytes.length > maxBytes || !isPngBytes(capture.bytes)) return false;
    if ((await digestJson(capture.request)) !== (await digestJson(request))) return false;
    if ((await digest(capture.bytes)) !== capture.sha256) return false;
    const header = imageSize(capture.bytes);
    if (header.type !== "png" || header.width !== request.size || header.height !== request.size) return false;
    const png = decodePngSafe(capture.bytes);
    return !!png && png.width === request.size && png.height === request.size && capture.width === png.width && capture.height === png.height;
  } catch {
    return false;
  }
}

/**
 * supplied → render the missing → verify every key came back → write back to ctx.captures.
 * Returns a creator-facing reason instead of records when views are missing and no renderer is configured.
 */
export async function resolveCaptures(ctx: CheckContext, requests: CaptureRequest[]): Promise<CaptureRecord[] | string> {
  const { maxCaptureBytes } = ctx.manifest.rendering;
  const resolved = new Map<string, CaptureRecord>();
  const missing: CaptureRequest[] = [];
  for (const request of requests) {
    ctx.signal?.throwIfAborted();
    const supplied = ctx.captures?.find((capture) => capture.request.key === request.key);
    if (supplied && (await validCapture(supplied, request, maxCaptureBytes))) resolved.set(request.key, supplied);
    else missing.push(request);
  }
  if (missing.length) {
    const renderer = ctx.services?.renderer;
    if (!renderer) return `Supply ${missing.length} missing or stale rendered views, or configure services.renderer to capture them.`;
    const input: RenderInput = { files: ctx.files, item: ctx.item, itemType: ctx.itemType, category: ctx.category! };
    const ahead = await recipeAhead(ctx, renderer.buildId, requests);
    const generated = await renderer.capture(input, [...missing, ...ahead], ctx.signal);
    for (const request of missing) {
      ctx.signal?.throwIfAborted();
      const capture = generated.find((value) => value.request.key === request.key);
      if (!capture || !(await validCapture(capture, request, maxCaptureBytes))) {
        throw new Error(`The renderer did not return a valid ${request.id} view. Capture the views again.`);
      }
      resolved.set(request.key, capture);
    }
    // the views rendered ahead join the context so the rules that follow find them there
    const aheadKeys = new Set(ahead.map((request) => request.key));
    ctx.captures = [...(ctx.captures ?? []), ...generated.filter((capture) => aheadKeys.has(capture.request.key))];
  }
  const captures = requests.map((request) => resolved.get(request.key)!);
  // other rules' captures stay in the result so one run can feed several checks — but only valid ones,
  // and never a stale capture whose id (file name) collides with a view resolved here
  const ids = new Set(requests.map((request) => request.id));
  const others: CaptureRecord[] = [];
  for (const capture of ctx.captures ?? []) {
    if (resolved.has(capture.request.key) || ids.has(capture.request.id)) continue;
    if (await validCapture(capture, capture.request, maxCaptureBytes)) others.push(capture);
  }
  ctx.captures = [...captures, ...others];
  return captures;
}

/**
 * The rest of the recipe, when other rendering rules will ask for it: a rule that wants two front views would
 * otherwise make the renderer load every body shape now and again for the rules after it. Nothing when this is
 * the run's only rendering rule, when the recipe cannot be built, or for views already asked for or supplied.
 */
async function recipeAhead(ctx: CheckContext, build: string, requests: CaptureRequest[]): Promise<CaptureRequest[]> {
  if ((ctx.renderingRules ?? 0) < 2) return [];
  const recipe = await recipeRequests(ctx, build);
  const stress = await stressRequests(ctx, build);
  if (typeof recipe === "string" || typeof stress === "string") return [];
  const asked = new Set(requests.map((request) => request.key));
  const ahead: CaptureRequest[] = [];
  for (const request of [...recipe, ...stress]) {
    if (asked.has(request.key)) continue;
    const supplied = ctx.captures?.find((capture) => capture.request.key === request.key);
    if (supplied && (await validCapture(supplied, request, ctx.manifest.rendering.maxCaptureBytes))) continue;
    ahead.push(request);
  }
  return ahead;
}

/**
 * The motion pass: worn views of a wearable at the stress poses its category calls for, front and side, both
 * shapes, skin in chroma green. Nothing for emotes. Together with the recipe it must fit the image budget.
 */
export async function stressRequests(ctx: CheckContext, build: string): Promise<CaptureRequest[] | string> {
  if (ctx.itemType !== "wearable") return [];
  const recipe = ctx.manifest.rendering;
  const representations = ctx.item.representations;
  if (!ctx.category || !representations?.length) return "Provide the item's category and declared body-shape representations to render it.";
  const poses = recipe.stress.poses[recipe.stress.categoryPoses[ctx.category] ?? "body"] ?? [];
  const digest = await inputDigest(ctx);
  const requests: CaptureRequest[] = [];
  for (const rep of representations) {
    if (!rep.contents.includes(rep.mainFile) || !rep.bodyShapes.length) return "Each representation needs a body shape and its main file in contents.";
    for (const bodyShape of rep.bodyShapes)
      for (const pose of poses)
        for (const azimuthDegrees of recipe.stress.azimuthDegrees) {
          requests.push(await captureRequest(ctx, {
            inputDigest: digest,
            rendererBuild: build,
            recipeVersion: recipe.recipeVersion,
            bodyShape,
            mainFile: rep.mainFile,
            view: "avatar",
            azimuthDegrees,
            pose: pose.clip,
            timeFraction: pose.fraction,
            skin: recipe.stress.skin,
            size: recipe.imageSizePx
          }));
        }
  }
  const base = await recipeRequests(ctx, build);
  if (typeof base === "string") return base;
  if (base.length + requests.length > recipe.maxCaptures) return "The capture recipe exceeds its image budget.";
  return requests;
}

/** The renderer's full recipe for this item: bodyShapes × views × (emote fractions) × azimuths — the set every visual rule shares. */
export async function recipeRequests(ctx: CheckContext, build: string): Promise<CaptureRequest[] | string> {
  const recipe = ctx.manifest.rendering;
  const representations = ctx.item.representations;
  if (!ctx.category || !representations?.length) return "Provide the item's category and declared body-shape representations to render it.";
  for (const path of new Set(representations.flatMap((rep) => rep.contents))) {
    if (!ctx.files.has(path)) return `Add the declared file "${path}" before rendering.`;
  }
  const digest = await inputDigest(ctx);
  const views = recipe.views[ctx.itemType];
  const azimuths = recipe.azimuthDegrees[ctx.itemType];
  const fractions = ctx.itemType === "emote" ? recipe.emoteFractions : [undefined];
  const requests: CaptureRequest[] = [];
  const seen = new Set<string>();
  for (const rep of representations) {
    if (!rep.contents.includes(rep.mainFile) || !rep.bodyShapes.length) return "Each representation needs a body shape and its main file in contents.";
    for (const bodyShape of rep.bodyShapes) {
      if (!recipe.bodyShapes.includes(bodyShape) || seen.has(bodyShape)) return "Declare each supported body shape once, with its own representation.";
      seen.add(bodyShape);
      for (const view of views)
        for (const timeFraction of fractions)
          for (const azimuthDegrees of azimuths) {
            requests.push(await captureRequest(ctx, {
              inputDigest: digest,
              rendererBuild: build,
              recipeVersion: recipe.recipeVersion,
              bodyShape,
              mainFile: rep.mainFile,
              view,
              azimuthDegrees,
              ...(timeFraction === undefined ? {} : { timeFraction }),
              size: recipe.imageSizePx
            }));
          }
    }
  }
  if (requests.length > recipe.maxCaptures) return "The capture recipe exceeds its image budget.";
  return requests;
}

/** How many views a full visual run asks the renderer for (recipe plus motion pass); 0 when the item cannot be rendered. */
export async function plannedCaptures(ctx: CheckContext): Promise<number> {
  const recipe = await recipeRequests(ctx, "");
  const stress = await stressRequests(ctx, "");
  return typeof recipe === "string" || typeof stress === "string" ? 0 : recipe.length + stress.length;
}

/** The label the model reads beside each image id: "BaseMale: avatar, azimuth 90 degrees[, clip fraction 0.5]". */
export function captureLabel(request: CaptureRequest): string {
  const shape = request.bodyShape.split(":").pop() ?? request.bodyShape;
  const pose = request.pose ? `, pose ${request.pose}` : "";
  const time = request.timeFraction === undefined ? "" : `, clip fraction ${request.timeFraction}`;
  const skin = request.skin ? ", skin rendered bright green" : "";
  return `${shape}: ${request.view}${pose}, azimuth ${request.azimuthDegrees} degrees${time}${skin}`;
}
