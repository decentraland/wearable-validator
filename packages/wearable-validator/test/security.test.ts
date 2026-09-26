import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { it } from "node:test";
import { deflateSync } from "node:zlib";
import { decode, encode } from "fast-png";
import { digest, validCapture } from "../src/logic/captures.js";
import { manifest } from "../src/manifest/index.js";
import type { CaptureRequest } from "../src/types.js";
import { validate } from "../src/validate.js";
import { parseGlb } from "../src/logic/gltf.js";
import { InputLimitError, inputTooLarge, unpackZip } from "../src/loader.js";
import { decodePngSafe, imageDimensions } from "../src/logic/images.js";
import { amplifyingGlb, cyclicGlb, duplicatePngHeader, nodeChainGlb, oversizedPngData, pngChunk, pngWithProfile, repeatedImageGlb } from "./helpers/hostile-inputs.js";
import { pngBytes } from "./helpers/synthetic.js";

it("rejects self-cycles and disconnected multi-node cycles before loading a GLB", async () => {
  for (const children of [[[0]], [[1], [0]], [[], [2], [1]]]) {
    await assert.rejects(parseGlb(cyclicGlb(children)), /cycl/i);
  }
});

it("finishes validation and parent traversal of cyclic models without blocking the event loop", () => {
  const validation = new URL("../src/validate.ts", import.meta.url).href;
  const gltf = new URL("../src/logic/gltf.ts", import.meta.url).href;
  const fixtures = new URL("./helpers/hostile-inputs.ts", import.meta.url).href;
  const script = `import assert from "node:assert/strict";
import { Document } from "@gltf-transform/core";
import { colliderNodes } from ${JSON.stringify(gltf)};
import { validate } from ${JSON.stringify(validation)};
import { cyclicGlb } from ${JSON.stringify(fixtures)};
const result = await validate(cyclicGlb(), { category: "hat" });
assert.ok(result.findings.some(f => f.check === "gltf-valid" && f.severity === "error"));
const doc = new Document();
const node = doc.createNode();
node.addChild(node);
assert.throws(() => colliderNodes(doc), /cycle/i);`;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { timeout: 5000, encoding: "utf8" });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
});

it("rejects PNG pixel streams that expand beyond the declared scanlines", () => {
  assert.equal(decodePngSafe(oversizedPngData()), undefined);
});

it("reads the first PNG header like the decoders, and refuses to decode a file with two", () => {
  assert.deepEqual(imageDimensions(duplicatePngHeader()), { width: 1, height: 1 });
  assert.equal(decodePngSafe(duplicatePngHeader()), undefined);
});

it("names a damaged zip in the creator's words and keeps limit errors apart from it", async () => {
  const damaged = new Uint8Array(64);
  damaged.set([0x50, 0x4b, 0x03, 0x04]);
  await assert.rejects(unpackZip(damaged), (error: unknown) => error instanceof Error && !(error instanceof InputLimitError) && /cannot be opened/.test(error.message));
  await assert.rejects(unpackZip(new Uint8Array(8), 4), (error: unknown) => error instanceof InputLimitError && error.message === inputTooLarge(8, 4));
});

it("does not decompress color profiles when measuring PNG pixels", () => {
  for (const profile of [new Uint8Array([0]), deflateSync(new Uint8Array(1024 * 1024))]) {
    const image = decodePngSafe(pngWithProfile(profile));
    assert.ok(image);
    assert.equal(image.width, 1);
    assert.equal(image.data.length, 4);
  }
});

it("preserves 8-bit and 16-bit pixels with ordinary and Adam7 scanlines", () => {
  for (const channels of [1, 2, 3, 4]) {
    for (const depth of [8, 16] as const) {
      for (const interlace of ["null", "Adam7"] as const) {
        const data = depth === 16 ? new Uint16Array(3 * 2 * channels).fill(1024) : new Uint8Array(3 * 2 * channels).fill(128);
        const bytes = encode({ width: 3, height: 2, data, channels, depth }, { interlace });
        const safe = decodePngSafe(bytes);
        assert.ok(safe, `${channels} channels, ${depth} bits, ${interlace}`);
        assert.deepEqual(safe.data, decode(bytes).data);
      }
    }
  }
});

it("preserves indexed palettes, transparency and split IDAT streams", () => {
  const base = pngBytes(4, 1);
  const header = base.slice(16, 29);
  header[8] = 2;
  header[9] = 3;
  const pixels = deflateSync(new Uint8Array([0, 0b00011011]));
  const bytes = Buffer.concat([
    base.subarray(0, 8), pngChunk("IHDR", header),
    pngChunk("PLTE", new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0])),
    pngChunk("tRNS", new Uint8Array([0, 255, 255, 255])),
    pngChunk("IDAT", pixels.subarray(0, 3)), pngChunk("IDAT", pixels.subarray(3)),
    pngChunk("IDAT", new Uint8Array()), base.subarray(-12)
  ]);
  const safe = decodePngSafe(bytes);
  assert.ok(safe);
  assert.deepEqual(safe.data, decode(bytes).data);
  assert.deepEqual(safe.palette, decode(bytes).palette);
});

it("applies PNG limits to thumbnail, QR and capture decoding", async () => {
  const bytes = oversizedPngData();
  const result = await validate({ files: new Map([["thumbnail.png", bytes]]) }, { checks: ["thumbnail", "qr-code"] });
  assert.ok(result.findings.some((finding) => finding.check === "thumbnail" && finding.severity === "error"));
  assert.ok(result.findings.some((finding) => finding.check === "qr-code" && finding.severity === "warning"));
  const review = await validate({ files: new Map([["thumbnail.png", bytes]]) }, { checks: ["thumbnail-honesty"] });
  assert.match(review.checks[0].skipReason ?? "", /decodable PNG or JPEG/);
  const request: CaptureRequest = { id: "test", key: "key", inputDigest: "input", rendererBuild: "test", recipeVersion: 1, bodyShape: manifest.rendering.bodyShapes[0], mainFile: "model.glb", view: "avatar", azimuthDegrees: 0, size: 1 };
  const capture = { request, bytes, sha256: await digest(bytes), width: 1, height: 1 };
  assert.equal(await validCapture(capture, request, manifest.rendering.maxCaptureBytes), false);
});

it("refuses accessors that would unpack past the file's data before allocating them", async () => {
  for (const shape of ["zero-stride", "no-buffer-view"] as const) {
    const bytes = amplifyingGlb(shape);
    assert.ok(bytes.length < 1024);
    await assert.rejects(parseGlb(bytes), /reads past the data|unpack to/, shape);
  }
});

it("counts every copy of a repeated embedded image toward the unpack limit", async () => {
  const png = pngBytes(64, 64);
  await parseGlb(repeatedImageGlb(png, 4));
  await assert.rejects(parseGlb(repeatedImageGlb(png, 4), png.length * 3), /unpack to/);
});

it("measures a deep node chain in linear time", async () => {
  const started = Date.now();
  const result = await validate(nodeChainGlb(8000), { category: "upper_body", checks: ["triangle-count", "bounding-box"] });
  assert.ok(Date.now() - started < 5000, `took ${Date.now() - started} ms`);
  assert.ok(result.findings.some((finding) => finding.check === "triangle-count" && finding.severity === "error"));
});

it("stops decoding textures for QR codes once the item's scan budget is spent", async () => {
  const pixels = manifest.images.maxScanPixels;
  manifest.images.maxScanPixels = 64 * 64 * 2;
  try {
    const result = await validate(repeatedImageGlb(pngBytes(64, 64), 5), { checks: ["qr-code"] });
    const skipped = result.findings.filter((finding) => finding.check === "qr-code");
    assert.equal(skipped.length, 1);
    assert.match(skipped[0].message, /^3 textures were not scanned/);
  } finally {
    manifest.images.maxScanPixels = pixels;
  }
});
