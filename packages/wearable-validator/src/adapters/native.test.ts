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
