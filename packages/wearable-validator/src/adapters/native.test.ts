import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { pngBytes } from "#test/helpers/synthetic.js";
import { manifest } from "../manifest/index.js";
import type { CaptureRequest, RenderInput } from "../types.js";
import { createNativeRenderer } from "./native.js";

const SIZE = manifest.rendering.imageSizePx;
const [MALE, FEMALE] = manifest.rendering.bodyShapes;

// A stand-in for the Unity render server: the same stdin/stdout protocol, a PNG per still, and a boot line that is not a result.
const FAKE_SERVER = `#!/usr/bin/env node
const { mkdirSync, writeFileSync, readFileSync, appendFileSync } = require("node:fs");
const { join } = require("node:path");
const out = process.argv[process.argv.indexOf("--out") + 1];
const png = readFileSync(join(__dirname, "still.png"));
console.log("Unity boot line, not a result");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    const job = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    appendFileSync(join(__dirname, "jobs.ndjson"), JSON.stringify(job) + "\\n");
    const entity = job.entity;
    const main = (entity.data ?? entity.emoteDataADR74).representations[0].contents[0].url;
    readFileSync(new URL(main));
    mkdirSync(join(out, job.id), { recursive: true });
    const files = [];
    for (const shape of job.bodyShapes) for (const time of job.times ?? [undefined]) for (const yaw of job.yaws) {
      const path = job.id + "/" + shape + "_" + (time ?? "x") + "_" + yaw + ".png";
      writeFileSync(join(out, path), png);
      files.push({ path, bodyShape: shape, yaw, ...(time === undefined ? {} : { time }) });
    }
    console.log(JSON.stringify({ id: job.id, ok: true, files, ms: 1 }));
  }
});
`;

const input: RenderInput = {
  files: new Map([["male.glb", new Uint8Array([1, 2, 3])], ["female.glb", new Uint8Array([4, 5, 6])]]),
  item: { category: "hat", representations: [{ bodyShapes: [MALE], mainFile: "male.glb", contents: ["male.glb"] }, { bodyShapes: [FEMALE], mainFile: "female.glb", contents: ["female.glb"] }] },
  itemType: "wearable",
  category: "hat"
};

function request(rendererBuild: string, fields: Partial<CaptureRequest>): CaptureRequest {
  const bodyShape = fields.bodyShape ?? MALE;
  const id = `${bodyShape.split(":").pop()}-${fields.view}-${fields.azimuthDegrees}-${fields.pose ?? "rest"}`;
  return { id, key: id, inputDigest: "input", rendererBuild, recipeVersion: 1, bodyShape, mainFile: "male.glb", view: "avatar", azimuthDegrees: 0, size: SIZE, ...fields };
}

async function withFakeServer(run: (command: string, log: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "native-renderer-"));
  const command = join(directory, "render-server");
  const log = join(directory, "jobs.ndjson");
  await writeFile(command, FAKE_SERVER);
  await chmod(command, 0o755);
  await writeFile(join(directory, "still.png"), pngBytes(SIZE, SIZE));
  try {
    await run(command, log);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("createNativeRenderer", () => {
  it("draws every requested view through one job per body shape, view and pose, from the item's own files", async () => {
    await withFakeServer(async (command, log) => {
      const renderer = await createNativeRenderer({ command, build: "test", workDirectory: await mkdtemp(join(tmpdir(), "native-work-")) });
      const requests = [
        ...[0, 90, 180].map((azimuthDegrees) => request(renderer.buildId, { view: "avatar", azimuthDegrees })),
        ...[0, 90].map((azimuthDegrees) => request(renderer.buildId, { bodyShape: FEMALE, view: "avatar", azimuthDegrees, pose: "dab", timeFraction: 0.5, skin: "00ff00" })),
        request(renderer.buildId, { view: "wearable", azimuthDegrees: 90 })
      ];
      const records = await renderer.capture(input, requests);
      await renderer.stop();
      assert.deepEqual(records.map((record) => record.request.id).sort(), requests.map((r) => r.id).sort());
      assert.ok(records.every((record) => record.width === SIZE && record.height === SIZE));
      const jobs = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      assert.equal(jobs.length, 3);
      assert.deepEqual(jobs.map((job) => [job.bodyShapes[0], job.view, job.pose, job.yaws, job.times]), [
        ["male", "avatar", manifest.rendering.wearablePose, [0, 90, 180], [manifest.rendering.wearablePoseFraction]],
        ["female", "avatar", "dab", [0, 90], [0.5]],
        ["male", "wearable", undefined, [90], undefined]
      ]);
      assert.match(jobs[1].params, /skinColor=00ff00/);
      assert.ok(jobs.every((job) => new URL(job.entity.data.representations[0].contents[0].url).protocol === "file:"));
      assert.equal(fileURLToPath(jobs[0].entity.data.representations[0].contents[0].url).endsWith("male.glb"), true);
    });
  });

  it("never hands the player a model that points at a file outside the item", async () => {
    const outside = ["http://169.254.170.2/v2/credentials", "file:///etc/passwd", "/etc/passwd", "//host/x.png", "../../x.png", "textures/%2e%2e/%2e%2e/x.png", "C:/x.png", "..\\x.png", "%252e%252e/%252e%252e/%252e%252e/etc/passwd", ".%252e/.%252e/etc/passwd", "%252e%252e%252f%252e%252e%252fetc/passwd", "..%255c..%255cetc", "x.bin?/../../etc/passwd", "file%253A///etc/passwd"];
    for (const uri of outside) {
      await withFakeServer(async (command, log) => {
        const renderer = await createNativeRenderer({ command, build: "test" });
        const glb = glbNaming(uri);
        const item: RenderInput = { ...input, files: new Map([["male.glb", glb], ["female.glb", glb]]) };
        await assert.rejects(renderer.capture(item, [request(renderer.buildId, { view: "avatar" })]), /outside the item/, uri);
        await renderer.stop();
        await assert.rejects(readFile(log), `the player never saw a job for ${uri}`);
      });
    }
  });

  it("draws a model that names a file next to it in the item, as smart wearables do", async () => {
    for (const uri of ["Bubble.png", "textures/Bubble%20Y.png", "./Bubble.png", "textures/../Bubble.png"]) {
      await withFakeServer(async (command, log) => {
        const renderer = await createNativeRenderer({ command, build: "test" });
        const glb = glbNaming(uri);
        const item: RenderInput = { ...input, files: new Map([["male.glb", glb], ["female.glb", glb]]) };
        await renderer.capture(item, [request(renderer.buildId, { view: "avatar" })]);
        await renderer.stop();
        assert.ok((await readFile(log, "utf8")).length > 0, `the player got the job for ${uri}`);
      });
    }
  });

  it("writes only the files the representations draw, and never outside the item's folder", async () => {
    await withFakeServer(async (command) => {
      const work = await mkdtemp(join(tmpdir(), "native-work-"));
      const renderer = await createNativeRenderer({ command, build: "test", workDirectory: work });
      const escaping: RenderInput = {
        ...input,
        files: new Map([...input.files, ["../../escape.sh", new Uint8Array([1])]]),
        item: { ...input.item, representations: [{ bodyShapes: [MALE], mainFile: "male.glb", contents: ["male.glb", "../../escape.sh"] }] }
      };
      await assert.rejects(renderer.capture(escaping, [request(renderer.buildId, { view: "avatar" })]), /not a file inside the item/);
      const undeclared: RenderInput = { ...input, files: new Map([...input.files, ["../../stray.sh", new Uint8Array([1])]]) };
      await renderer.capture(undeclared, [request(renderer.buildId, { view: "avatar" })]);
      await renderer.stop();
      // the item folder is <work>/<run>/item, so two levels up is the work folder itself
      await assert.rejects(readFile(join(work, "escape.sh")));
      await assert.rejects(readFile(join(work, "stray.sh")));
    });
  });

  it("refuses requests planned for another renderer build", async () => {
    await withFakeServer(async (command) => {
      const renderer = await createNativeRenderer({ command, build: "test" });
      await assert.rejects(renderer.capture(input, [request("other-build", { view: "avatar" })]), /different renderer build/);
    });
  });

  it("says when the render server cannot start", async () => {
    const renderer = await createNativeRenderer({ command: "/nonexistent/render-server", build: "test" });
    await assert.rejects(renderer.capture(input, [request(renderer.buildId, { view: "avatar" })]), /could not start|exited/);
  });
});

// a GLB with a JSON chunk only, whose one buffer is named by uri
function glbNaming(uri: string): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify({ asset: { version: "2.0" }, buffers: [{ byteLength: 4, uri }] }));
  const glb = new Uint8Array(20 + Math.ceil(json.length / 4) * 4).fill(32);
  const view = new DataView(glb.buffer);
  for (const [offset, value] of [[0, 0x46546c67], [4, 2], [8, glb.length], [12, glb.length - 20], [16, 0x4e4f534a]]) view.setUint32(offset, value, true);
  glb.set(json, 20);
  return glb;
}
