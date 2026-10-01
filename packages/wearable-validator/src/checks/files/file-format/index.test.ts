import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validate } from "../../../index.js";
import { pngBytes, pngHeaderBytes, syntheticGlb, syntheticZip } from "#test/helpers/synthetic.js";
import { enc } from "#test/helpers/bytes.js";
import { only } from "#test/helpers/findings.js";
import { wearableManifest } from "#test/helpers/manifest.js";

describe("file-format (S-01)", () => {
  // the GLB's JSON with its binary chunk inlined as a data: URI: a .gltf exported as "glTF Embedded"
  async function embeddedGltf(options: Parameters<typeof syntheticGlb>[0] = {}): Promise<Uint8Array> {
    const glb = await syntheticGlb(options);
    const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
    const jsonLength = view.getUint32(12, true);
    const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLength))) as { buffers: { uri?: string }[] };
    const binStart = 20 + jsonLength;
    const bin = glb.subarray(binStart + 8, binStart + 8 + view.getUint32(binStart, true));
    json.buffers[0].uri = `data:application/octet-stream;base64,${Buffer.from(bin).toString("base64")}`;
    return enc(JSON.stringify(json));
  }
  const gltfItem = (gltf: Uint8Array) => syntheticZip({
    manifest: wearableManifest({}, { representations: [{ bodyShapes: ["urn:decentraland:off-chain:base-avatars:BaseMale"], mainFile: "model.gltf", contents: ["model.gltf"] }] }),
    extraFiles: { "model.gltf": gltf }
  });

  it("accepts a .gltf with everything embedded, as published items use, and measures it like a GLB", async () => {
    const result = await validate(await gltfItem(await embeddedGltf({ triangles: 300 })), { checks: ["file-format", "gltf-valid", "triangle-count"] });
    assert.deepEqual(result.findings.filter((finding) => finding.severity === "error"), []);
    assert.equal(result.checks.find((row) => row.check === "triangle-count")?.measured, "300 tris");
  });

  it("refuses a .gltf that points at a file outside itself, and one that is not glTF", async () => {
    const external = enc(JSON.stringify({ asset: { version: "2.0" }, buffers: [{ byteLength: 4, uri: "model.bin" }] }));
    const [outside] = only((await validate(await gltfItem(external), { checks: ["file-format"] })).findings, "file-format");
    assert.equal(outside.where, "model.gltf");
    assert.match(outside.message, /"model\.bin" outside the file\. Export it as glTF Embedded, or as GLB/);
    const [empty] = only((await validate(await gltfItem(enc("{}")), { checks: ["file-format"] })).findings, "file-format");
    assert.match(empty.message, /not a glTF document/);
  });

  it("errors on a .glb whose content is not GLB binary", async () => {
    const zip = await syntheticZip({ glb: enc("not a real model at all, sorry!!") });
    const findings = only((await validate(zip, { checks: ["file-format"] })).findings, "file-format");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "error");
    assert.match(findings[0].message, /not GLB binary/);
  });

  it("errors on oversize facial-feature PNGs", async () => {
    const findings = only((await validate(pngBytes(300, 300), { category: "eyes", checks: ["file-format"] })).findings, "file-format");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "error");
    assert.equal(findings[0].limit, "256×256");
  });

  it("errors from the header alone on a facial-feature PNG claiming bomb-sized dimensions", async () => {
    const findings = only((await validate(pngHeaderBytes(12000, 12000), { category: "eyes", checks: ["file-format"] })).findings, "file-format");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "error");
    assert.equal(findings[0].measured, "12000×12000");
    assert.equal(findings[0].limit, "256×256");
  });

  it("passes a valid facial-feature PNG and a valid wearable zip", async () => {
    const facial = await validate(pngBytes(256, 256), { category: "mouth", checks: ["file-format"] });
    assert.equal(only(facial.findings, "file-format").length, 0);
    const zip = await validate(await syntheticZip(), { checks: ["file-format"] });
    assert.equal(only(zip.findings, "file-format").length, 0);
  });
});
