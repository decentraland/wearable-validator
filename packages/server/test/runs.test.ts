import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { digest, type CaptureRecord, type Result, type ReviewRequest, type ReviewResult } from "@dcl-regenesislabs/wearable-validator";
import { pngBytes, syntheticGlb, syntheticZip } from "../../wearable-validator/test/helpers/synthetic.js";
import { setupTokenCredentials } from "@dcl-regenesislabs/wearable-validator/ai";
import { dryRunReviewer, recordingReviewer, replayReviewer } from "../src/adapters/reviewer.js";
import { readRun, writeRun } from "../src/logic/run-store.js";

function reviewRequest(): ReviewRequest {
  return {
    check: "thumbnail-honesty",
    prompt: { version: 4, system: "System text.", instructions: "Instructions text.", schema: { type: "object" } },
    promptDigest: "digest-current",
    images: [
      { id: "BaseMale-avatar-000", label: "BaseMale: avatar, azimuth 0 degrees", bytes: pngBytes(4, 4), mimeType: "image/png" },
      { id: "thumbnail", label: "Original item thumbnail", bytes: pngBytes(4, 4, true), mimeType: "image/png" }
    ]
  };
}

describe("code gate", () => {
  it("stops on code failures before opening renderer binaries or OAuth", async () => {
    const directory = await mkdtemp(join(tmpdir(), "run-folder-gate-"));
    try {
      const file = join(directory, "invalid.zip");
      await writeFile(file, await syntheticZip({ glb: await syntheticGlb({ triangles: 2000 }) }));
      const script = resolve(import.meta.dirname, "../src/cli/review.ts");
      await assert.rejects(
        promisify(execFile)(process.execPath, [
          "--import", "tsx", script, file,
          "--renderer-build", join(directory, "missing-build")
        ], { env: { ...process.env, ANTHROPIC_OAUTH_SETUP_TOKEN: "sk-ant-oat01-never-used" } }),
        (error) => {
          assert.ok(error && typeof error === "object" && "stdout" in error && "stderr" in error);
          assert.equal(error.stderr, "");
          const output = JSON.parse(String(error.stdout));
          assert.equal(output.stage, "code");
          assert.equal(output.result.passed, false);
          assert.ok(output.result.findings.some((finding: { check: string }) => finding.check === "triangle-count"));
          return true;
        }
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("run folder", () => {
  it("writeRun → readRun round-trips captures byte-for-byte", async () => {
    const directory = await mkdtemp(join(tmpdir(), "run-folder-run-"));
    try {
      const captures: CaptureRecord[] = [];
      for (const [id, azimuthDegrees] of [["BaseMale-avatar-000", 0], ["BaseMale-avatar-090", 90]] as const) {
        const bytes = pngBytes(8, 8, azimuthDegrees === 90);
        captures.push({
          request: {
            id, key: `key-${id}`, inputDigest: "input", rendererBuild: "build", recipeVersion: 1,
            bodyShape: "urn:decentraland:off-chain:base-avatars:BaseMale", mainFile: "model.glb",
            view: "avatar", azimuthDegrees, size: 8
          },
          bytes, sha256: await digest(bytes), width: 8, height: 8
        });
      }
      const result: Result = {
        passed: null,
        checks: [{ check: "thumbnail-honesty", group: "rendering", status: "skipped", coverage: "missing", skipReason: "Configure services.reviewer." }],
        findings: [],
        captures,
        summary: { errors: 0, warnings: 0, checked: 0, skipped: 1 }
      };
      const thumbnail = pngBytes(4, 4);
      const index = await writeRun(directory, result, thumbnail);
      assert.equal(index, join(directory, "index.html"));

      const restored = await readRun(directory);
      assert.equal(restored.length, 2);
      for (const [i, capture] of restored.entries()) {
        assert.deepEqual(capture.request, captures[i].request);
        assert.equal(capture.sha256, captures[i].sha256);
        assert.equal(capture.width, 8);
        assert.equal(capture.height, 8);
        assert.equal(Buffer.compare(Buffer.from(capture.bytes), Buffer.from(captures[i].bytes)), 0);
      }

      const serialized = JSON.parse(await readFile(join(directory, "result.json"), "utf8"));
      assert.deepEqual(serialized.captures.map((c: { file: string }) => c.file), ["captures/BaseMale-avatar-000.png", "captures/BaseMale-avatar-090.png"]);
      assert.ok(serialized.captures.every((c: object) => !("bytes" in c)));
      const list = JSON.parse(await readFile(join(directory, "captures", "captures.json"), "utf8"));
      assert.deepEqual(Object.keys(list[0]).sort(), ["file", "height", "request", "sha256", "width"]);
      assert.equal(Buffer.compare(await readFile(join(directory, "thumbnail.png")), Buffer.from(thumbnail)), 0);
      const finding = JSON.parse(await readFile(join(directory, "thumbnail-honesty", "4-finding.json"), "utf8"));
      assert.equal(finding.check.check, "thumbnail-honesty");
      assert.deepEqual(finding.findings, []);
      const html = await readFile(index, "utf8");
      assert.ok(html.includes('id="BaseMale-avatar-090"') && html.includes("thumbnail.png"));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("records the prompt and context before the call and the answer after it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "run-folder-tap-"));
    try {
      const folder = join(directory, "thumbnail-honesty");
      let promptExistedDuringCall = false;
      const inner = {
        async review(): Promise<ReviewResult> {
          promptExistedDuringCall = await readFile(join(folder, "1-prompt.md"), "utf8").then(() => true, () => false);
          return { ok: true, answer: { verdict: "matches" }, metadata: { provider: "test", model: "fake", promptVersion: 4, promptDigest: "digest-current" } };
        }
      };
      const result = await recordingReviewer(inner, directory).review(reviewRequest());
      assert.equal(result.ok, true);
      assert.equal(promptExistedDuringCall, true);
      const prompt = await readFile(join(folder, "1-prompt.md"), "utf8");
      assert.ok(prompt.startsWith("# thumbnail-honesty · prompt v4 · digest digest-current\n## System\nSystem text."));
      assert.ok(prompt.includes("1. `Image ID: BaseMale-avatar-000` — BaseMale: avatar, azimuth 0 degrees — ![](../captures/BaseMale-avatar-000.png)"));
      assert.ok(prompt.includes("2. `Image ID: thumbnail` — Original item thumbnail — ![](../thumbnail.png)"));
      const context = JSON.parse(await readFile(join(folder, "2-context.json"), "utf8"));
      assert.equal(context.systemPrompt, "System text.");
      const images = context.messages[0].content.filter((block: { type: string }) => block.type === "image");
      assert.deepEqual(images.map((block: { id: string; file: string }) => [block.id, block.file]), [["BaseMale-avatar-000", "../captures/BaseMale-avatar-000.png"], ["thumbnail", "../thumbnail.png"]]);
      assert.ok(images.every((block: object) => !("data" in block) && "sha256" in block));
      assert.deepEqual(JSON.parse(await readFile(join(folder, "3-answer.json"), "utf8")), result);

      const dry = await dryRunReviewer().review(reviewRequest());
      assert.equal(dry.ok, false);
      assert.equal(dry.metadata.promptDigest, "digest-current");
      assert.equal(dry.ok === false && dry.reason, "The model was not called: the run server has no ANTHROPIC_OAUTH_SETUP_TOKEN.", "the server's reason names the variable, not a flag it no longer has");
      const flagged = await dryRunReviewer("The model was not called (--no-ai).").review(reviewRequest());
      assert.equal(flagged.ok === false && flagged.reason, "The model was not called (--no-ai).");

      const stale = { ...reviewRequest(), promptDigest: "digest-next" };
      const replayed = await replayReviewer(directory).review(stale);
      assert.equal(replayed.ok, true);
      assert.equal(replayed.metadata.promptDigest, "digest-next");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("readRun refuses a folder without captures.json", async () => {
    const directory = await mkdtemp(join(tmpdir(), "run-folder-empty-"));
    try {
      await assert.rejects(readRun(directory), /ENOENT/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("run folder edge cases", () => {
  async function capture(id: string, key: string, azimuthDegrees: number): Promise<CaptureRecord> {
    const bytes = pngBytes(8, 8, azimuthDegrees === 90);
    return {
      request: {
        id, key, inputDigest: "input", rendererBuild: "build", recipeVersion: 1,
        bodyShape: "urn:decentraland:off-chain:base-avatars:BaseMale", mainFile: "model.glb",
        view: "avatar", azimuthDegrees, size: 8
      },
      bytes, sha256: await digest(bytes), width: 8, height: 8
    };
  }
  function resultWith(captures: CaptureRecord[]): Result {
    return {
      passed: null,
      checks: [{ check: "thumbnail-honesty", group: "rendering", status: "skipped", coverage: "missing", skipReason: "Configure services.reviewer." }],
      findings: [],
      captures,
      summary: { errors: 0, warnings: 0, checked: 0, skipped: 1 }
    };
  }

  it("readRun treats a deleted PNG as a missing view instead of failing the run", async () => {
    const directory = await mkdtemp(join(tmpdir(), "run-folder-missing-"));
    try {
      const captures = [await capture("BaseMale-avatar-000", "k0", 0), await capture("BaseMale-avatar-090", "k90", 90)];
      await writeRun(directory, resultWith(captures));
      await rm(join(directory, "captures", "BaseMale-avatar-090.png"));
      const restored = await readRun(directory);
      assert.deepEqual(restored.map((c) => c.request.id), ["BaseMale-avatar-000"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("writeRun refuses two captures that would share one file name", async () => {
    const directory = await mkdtemp(join(tmpdir(), "run-folder-dup-"));
    try {
      const captures = [await capture("BaseMale-avatar-000", "k0", 0), await capture("BaseMale-avatar-000", "k0-other-build", 0)];
      await assert.rejects(writeRun(directory, resultWith(captures)), /share the id/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("setupTokenCredentials", () => {
  it("seeds a setup token as a year-long OAuth access credential and keeps edits in memory", async () => {
    const store = setupTokenCredentials("sk-ant-oat01-test");
    const credential = await store.read("anthropic");
    assert.equal(credential?.type, "oauth");
    assert.equal(credential?.type === "oauth" && credential.access, "sk-ant-oat01-test");
    assert.ok(credential?.type === "oauth" && credential.expires > Date.now() + 300 * 24 * 60 * 60 * 1000);
    assert.equal(await store.read("openai"), undefined);
    await store.modify("anthropic", async (current) => (current?.type === "oauth" ? { ...current, access: "sk-ant-oat01-rotated" } : current));
    const updated = await store.read("anthropic");
    assert.equal(updated?.type === "oauth" && updated.access, "sk-ant-oat01-rotated");
  });

  it("refuses anything that is not a setup token", () => {
    assert.throws(() => setupTokenCredentials("sk-ant-api03-key"), /setup-token/);
  });
});
