import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { captureRequest, digest, digestJson, inputDigest, plannedCaptures, recipeRequests, rendererBuild, resolveCaptures, stressRequests, validCapture } from "./captures.js";
import { manifest } from "../manifest/index.js";
import type { CaptureRecord, CaptureRequest, CheckContext, Renderer } from "../types.js";
import { pngBytes } from "#test/helpers/synthetic.js";

const SIZE = 16;
const [MALE, FEMALE] = manifest.rendering.bodyShapes;

/** A minimal context — captures.ts reads files, item, itemType, category, manifest, captures, services, signal. */
function context(overrides: Partial<CheckContext> = {}): CheckContext {
  return {
    files: new Map([["model.glb", new Uint8Array([1, 2, 3])]]),
    item: { category: "hat", representations: [{ bodyShapes: [MALE], mainFile: "model.glb", contents: ["model.glb"] }] },
    itemType: "wearable",
    category: "hat",
    metadataMode: "builder",
    inputKind: "zip",
    totalBytes: 3,
    models: [],
    manifest,
    emptyFiles: [],
    captures: [],
    ...overrides
  };
}

function request(ctx: CheckContext, fields: Partial<CaptureRequest> = {}): Promise<CaptureRequest> {
  return captureRequest(ctx, {
    inputDigest: "input",
    rendererBuild: "build-a",
    recipeVersion: 1,
    bodyShape: MALE,
    mainFile: "model.glb",
    view: "avatar",
    azimuthDegrees: 0,
    size: SIZE,
    ...fields
  });
}

async function record(req: CaptureRequest, bytes = pngBytes(req.size, req.size)): Promise<CaptureRecord> {
  return { request: req, bytes, sha256: await digest(bytes), width: req.size, height: req.size };
}

function fakeRenderer(buildId: string, rendered: CaptureRequest[][], drop = 0): Renderer {
  return {
    buildId,
    capture: async (_input, requests) => {
      rendered.push(requests);
      return Promise.all(requests.slice(0, requests.length - drop).map((req) => record(req)));
    },
    stop: async () => {}
  };
}

describe("captures", () => {
  it("digestJson ignores key order at every depth and distinguishes values", async () => {
    const a = await digestJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: "x" } });
    const b = await digestJson({ a: { c: "x", d: [1, { y: 2, z: 1 }] }, b: 1 });
    assert.equal(a, b);
    assert.notEqual(a, await digestJson({ a: { c: "x", d: [{ y: 2, z: 1 }, 1] }, b: 1 }));
  });

  it("captureRequest fills the human id and a key that names the scene", async () => {
    const ctx = context();
    const front = await request(ctx);
    assert.equal(front.id, "BaseMale-avatar-000");
    assert.equal((await request(ctx, { bodyShape: FEMALE, view: "wearable", azimuthDegrees: 90, timeFraction: 0.5 })).id, "BaseFemale-wearable-090-t0.5");
    assert.equal(front.key, (await request(ctx)).key);
    assert.notEqual(front.key, (await request(ctx, { azimuthDegrees: 90 })).key);
    const scene = { ...manifest.rendering, background: "000000" };
    assert.notEqual(front.key, (await request(context({ manifest: { ...manifest, rendering: scene } }))).key);
  });

  it("validCapture rejects the wrong size, sha, format or request", async () => {
    const ctx = context();
    const req = await request(ctx);
    const max = manifest.rendering.maxCaptureBytes;
    assert.equal(await validCapture(await record(req), req, max), true);
    assert.equal(await validCapture(await record(req, pngBytes(SIZE, SIZE + 1)), req, max), false);
    assert.equal(await validCapture({ ...(await record(req)), sha256: "0".repeat(64) }, req, max), false);
    assert.equal(await validCapture(await record(req, new TextEncoder().encode("not a png at all, really")), req, max), false);
    assert.equal(await validCapture(await record(req), await request(ctx, { azimuthDegrees: 90 }), max), false);
    assert.equal(await validCapture(await record(req), req, 8), false);
  });

  it("rendererBuild prefers the renderer, else the one shared supplied build, else undefined", async () => {
    const ctx = context();
    const a = await record(await request(ctx, { rendererBuild: "build-a" }));
    const b = await record(await request(ctx, { rendererBuild: "build-b" }));
    assert.equal(rendererBuild(context({ captures: [] })), undefined);
    assert.equal(rendererBuild(context({ captures: [a, a] })), "build-a");
    assert.equal(rendererBuild(context({ captures: [a, b] })), undefined);
    assert.equal(rendererBuild(context({ captures: [a, b], services: { renderer: fakeRenderer("build-c", []) } })), "build-c");
  });

  it("resolveCaptures returns a reason without a renderer and renders only the missing keys", async () => {
    const ctx = context();
    const front = await request(ctx);
    const side = await request(ctx, { azimuthDegrees: 90 });
    const supplied = await record(front);
    ctx.captures = [supplied];
    assert.equal(await resolveCaptures(ctx, [front, side]), "Supply 1 missing or stale rendered views, or configure services.renderer to capture them.");
    const rendered: CaptureRequest[][] = [];
    ctx.services = { renderer: fakeRenderer("build-a", rendered) };
    const captures = await resolveCaptures(ctx, [front, side]);
    assert.ok(Array.isArray(captures));
    assert.deepEqual(rendered.map((batch) => batch.map((req) => req.id)), [["BaseMale-avatar-090"]]);
    assert.equal(captures[0], supplied);
    assert.equal(captures[1].request.id, "BaseMale-avatar-090");
    assert.deepEqual(ctx.captures.map((capture) => capture.request.id), ["BaseMale-avatar-000", "BaseMale-avatar-090"]);
  });

  it("resolveCaptures renders the rest of the recipe with the first request when more rendering rules follow", async () => {
    const ctx = context({ renderingRules: 2 });
    const front = await request(ctx, { inputDigest: await inputDigest(ctx), recipeVersion: manifest.rendering.recipeVersion, size: manifest.rendering.imageSizePx });
    const rendered: CaptureRequest[][] = [];
    ctx.services = { renderer: fakeRenderer("build-a", rendered) };
    const captures = await resolveCaptures(ctx, [front]);
    assert.ok(Array.isArray(captures));
    assert.equal(captures.length, 1);
    assert.equal(captures[0].request.id, "BaseMale-avatar-000");
    // one shape × two views × three azimuths plus the motion pass (a hat: two head poses × two azimuths), the asked view first and only once
    const { stress } = manifest.rendering;
    const expected = 6 + stress.poses[stress.categoryPoses.hat].length * stress.azimuthDegrees.length;
    assert.equal(rendered.length, 1);
    assert.equal(rendered[0].length, expected);
    assert.equal(rendered[0][0].key, front.key);
    assert.equal(new Set(rendered[0].map((req) => req.key)).size, expected);
    assert.equal(ctx.captures.length, expected);
    // the next rule finds every view already there
    const side = rendered[0].find((req) => req.id === "BaseMale-wearable-090")!;
    const again = await resolveCaptures(ctx, [side]);
    assert.ok(Array.isArray(again));
    assert.equal(rendered.length, 1);

    // the run's only rendering rule renders just what it asked for
    const alone = context({ renderingRules: 1 });
    const only = await request(alone, { inputDigest: await inputDigest(alone), recipeVersion: manifest.rendering.recipeVersion, size: manifest.rendering.imageSizePx });
    const batches: CaptureRequest[][] = [];
    alone.services = { renderer: fakeRenderer("build-a", batches) };
    await resolveCaptures(alone, [only]);
    assert.deepEqual(batches.map((batch) => batch.length), [1]);
  });

  it("resolveCaptures keeps other rules' captures and drops stale ones from the result", async () => {
    const ctx = context();
    const front = await request(ctx);
    const stale = await record(front, pngBytes(SIZE + 1, SIZE + 1));
    const other = await record(await request(ctx, { view: "wearable" }));
    ctx.captures = [stale, other];
    ctx.services = { renderer: fakeRenderer("build-a", []) };
    const captures = await resolveCaptures(ctx, [front]);
    assert.ok(Array.isArray(captures));
    assert.notEqual(captures[0], stale);
    assert.deepEqual(ctx.captures.map((capture) => capture.request.id), ["BaseMale-avatar-000", "BaseMale-wearable-000"]);
  });

  it("resolveCaptures rejects a renderer that returns fewer or invalid views", async () => {
    const ctx = context({ services: { renderer: fakeRenderer("build-a", [], 1) } });
    const requests = [await request(ctx), await request(ctx, { azimuthDegrees: 90 })];
    await assert.rejects(resolveCaptures(ctx, requests), /did not return a valid BaseMale-avatar-090 view/);
    ctx.captures = [];
    ctx.services = {
      renderer: {
        buildId: "build-a",
        capture: async (_input, batch) => Promise.all(batch.map((req) => record({ ...req, size: SIZE + 1 }))),
        stop: async () => {}
      }
    };
    await assert.rejects(resolveCaptures(ctx, requests), /did not return a valid BaseMale-avatar-000 view/);
  });

  it("resolveCaptures honours an aborted signal before rendering", async () => {
    const rendered: CaptureRequest[][] = [];
    const ctx = context({ services: { renderer: fakeRenderer("build-a", rendered) }, signal: AbortSignal.abort() });
    await assert.rejects(resolveCaptures(ctx, [await request(ctx)]), /abort/i);
    assert.deepEqual(rendered, []);
  });
});

describe("stress poses", () => {
  it("adds worn front and side views at the category's clip moments, running included, with green skin, and nothing for emotes", async () => {
    const ctx = context({ category: "upper_body", item: { category: "upper_body", representations: [{ bodyShapes: [MALE, FEMALE], mainFile: "model.glb", contents: ["model.glb"] }] } });
    const requests = await stressRequests(ctx, "build-a");
    assert.ok(Array.isArray(requests));
    const { stress } = manifest.rendering;
    assert.equal(requests.length, 2 * stress.poses.arms.length * stress.azimuthDegrees.length);
    assert.deepEqual(requests.map((r) => r.id).slice(0, 2), ["BaseMale-avatar-dab-000-t0.5", "BaseMale-avatar-dab-090-t0.5"]);
    assert.ok(requests.every((r) => r.view === "avatar" && r.skin === stress.skin && r.pose && r.timeFraction !== undefined));
    // the pose, the moment and the skin are all part of the key, and none of them collide with the rest-pose recipe
    const recipe = await recipeRequests(ctx, "build-a");
    assert.ok(Array.isArray(recipe));
    assert.equal(new Set([...recipe, ...requests].map((r) => r.key)).size, recipe.length + requests.length);
    assert.ok(recipe.length + requests.length <= manifest.rendering.maxCaptures);

    const legs = await stressRequests(context({ category: "lower_body", item: { category: "lower_body", representations: [{ bodyShapes: [MALE], mainFile: "model.glb", contents: ["model.glb"] }] } }), "build-a");
    assert.ok(Array.isArray(legs));
    assert.deepEqual([...new Set(legs.map((r) => r.pose))], [...new Set(stress.poses.legs.map((pose) => pose.clip))]);
    // every body group is seen running, at more than one moment of the stride
    for (const group of Object.values(stress.poses)) assert.ok(group.filter((pose) => pose.clip === "run").length >= 2);
    // hands keep the pose where palms and fingers meet; head items keep the arm crossing the face
    assert.equal(stress.categoryPoses.hands_wear, "hands");
    assert.ok(stress.poses.hands.some((pose) => pose.clip === "clap"));
    assert.ok(stress.poses.head.some((pose) => pose.clip === "dab"));
    const unknown = await stressRequests(context({ category: "something_new", item: { category: "something_new", representations: [{ bodyShapes: [MALE], mainFile: "model.glb", contents: ["model.glb"] }] } }), "build-a");
    assert.ok(Array.isArray(unknown));
    assert.deepEqual([...new Set(unknown.map((r) => r.pose))], [...new Set(stress.poses.body.map((pose) => pose.clip))]);
    assert.deepEqual(await stressRequests(context({ itemType: "emote" }), "build-a"), []);
  });
});

describe("plannedCaptures", () => {
  const item = (category: string, shapes: string[]): Partial<CheckContext> => ({ category, item: { category, representations: [{ bodyShapes: shapes, mainFile: "model.glb", contents: ["model.glb"] }] } });
  const { views, azimuthDegrees, emoteFractions, stress } = manifest.rendering;
  const recipeOf = (kind: "wearable" | "emote", shapes: number) => shapes * views[kind].length * azimuthDegrees[kind].length * (kind === "emote" ? emoteFractions.length : 1);
  const stressOf = (poses: keyof typeof stress.poses, shapes: number) => shapes * stress.poses[poses].length * stress.azimuthDegrees.length;

  async function agrees(ctx: CheckContext, expected: number): Promise<void> {
    const recipe = await recipeRequests(ctx, "build-a");
    const motion = await stressRequests(ctx, "build-a");
    assert.ok(Array.isArray(recipe) && Array.isArray(motion));
    assert.equal(recipe.length + motion.length, expected);
    assert.equal(await plannedCaptures(ctx), expected);
  }

  it("counts the recipe plus the category's motion pass for a wearable on both shapes", async () => {
    await agrees(context(item("upper_body", [MALE, FEMALE])), recipeOf("wearable", 2) + stressOf("arms", 2));
    assert.equal(await plannedCaptures(context(item("upper_body", [MALE, FEMALE]))), 28);
  });

  it("uses the head poses for a hat and halves everything for a one-shape wearable", async () => {
    await agrees(context(item("hat", [MALE, FEMALE])), recipeOf("wearable", 2) + stressOf("head", 2));
    await agrees(context(item("hat", [MALE])), recipeOf("wearable", 1) + stressOf("head", 1));
    assert.equal(await plannedCaptures(context(item("hat", [MALE]))), 14);
  });

  it("counts every clip fraction and no motion pass for an emote", async () => {
    await agrees(context({ itemType: "emote", ...item("fun", [MALE, FEMALE]) }), recipeOf("emote", 2));
    assert.equal(await plannedCaptures(context({ itemType: "emote", ...item("fun", [MALE, FEMALE]) })), 20);
  });

  it("answers 0 when the item cannot be rendered", async () => {
    assert.equal(await plannedCaptures(context({ category: undefined })), 0);
    assert.equal(await plannedCaptures(context({ files: new Map() })), 0);
    assert.equal(await plannedCaptures(context({ item: { category: "hat", representations: [] } })), 0);
  });
});

describe("captures passthrough", () => {
  it("drops other-rule captures that collide with a resolved id or fail their own validation", async () => {
    const ctx = context();
    const fresh = await request(ctx);
    const staleSameId = await record({ ...fresh, key: "other-key", rendererBuild: "build-b" });
    const otherRule = await record(await request(ctx, { azimuthDegrees: 45 }));
    const corrupt = { ...(await record(await request(ctx, { azimuthDegrees: 135 }))), bytes: new Uint8Array([1, 2, 3]) };
    ctx.captures = [staleSameId, otherRule, corrupt];
    const rendered: CaptureRequest[][] = [];
    ctx.services = { renderer: fakeRenderer("build-a", rendered) };
    const resolved = await resolveCaptures(ctx, [fresh]);
    assert.ok(Array.isArray(resolved));
    assert.deepEqual(rendered.map((batch) => batch.length), [1]);
    assert.deepEqual(ctx.captures?.map((capture) => capture.request.id), [fresh.id, otherRule.request.id]);
    assert.equal(ctx.captures?.[0].request.key, fresh.key);
  });
});
