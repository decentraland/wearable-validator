import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jsQR from "jsqr";
import { encode as encodePng } from "fast-png";
import { encode as encodeJpeg } from "jpeg-js";
import { validate } from "../../../index.js";
import { hasPayload, plausibleLocation } from "./index.js";
import { manifest } from "../../../manifest/index.js";
import { jpegWithFillBytes, pngHeaderBytes, pngWithLeadingChunk, syntheticGlb, syntheticZip } from "#test/helpers/synthetic.js";

// Version-2 QR module matrix for "https://example.com/qr" (generated once with the `qrcode`
// package, stored as packed bits — no binary fixture in git).
const QR_SIZE = 25;
const QR_HEX =
  "fe04bfc107d06ea88bb757e5dbab4aec165907faaafe01a500be2c3e5cb6288095e56a3c7619fb76bc2f54aae804f7" +
  "6117f1ae4efa0051c63f972af056118baf1fbdd56b7eea9c1b0499b9feaa7f8";

// Symbol 1 of a 2-symbol Structured Append sequence for "https://example.com/qr-structured-append" (generated once
// with `segno.make_sequence`, same packed format). jsQR does not implement Structured Append: it reads the header's
// symbol position (0000) as a terminator and returns empty content, while ZXing-based phone scanners open the URL.
const SA_SIZE = 25;
const SA_HEX =
  "fe703fc10ed06e954bb74165dba3eaec144107faaafe00000096a4d022af949cde2cfaa957eb69c42a64d95a4a3ef292d1e0ff94f98062443f99a" +
  "b7052b14ba5efbdd5fc4ae97dfb043e8bfeba5a8";

function qrRgba(scale = 8, quiet = 4, hex = QR_HEX, size = QR_SIZE): { data: Uint8Array; dim: number } {
  let bits = "";
  for (const c of hex) bits += parseInt(c, 16).toString(2).padStart(4, "0");
  const dim = (size + quiet * 2) * scale;
  const data = new Uint8Array(dim * dim * 4).fill(255);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (bits[y * size + x] !== "1") continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const i = (((y + quiet) * scale + dy) * dim + (x + quiet) * scale + dx) * 4;
          data[i] = data[i + 1] = data[i + 2] = 0;
        }
      }
    }
  }
  return { data, dim };
}

function qrPngBytes(): Uint8Array {
  const { data, dim } = qrRgba();
  return encodePng({ width: dim, height: dim, data, channels: 4 });
}

function structuredAppendPngBytes(): Uint8Array {
  const { data, dim } = qrRgba(8, 4, SA_HEX, SA_SIZE);
  return encodePng({ width: dim, height: dim, data, channels: 4 });
}

function qrJpegBytes(): Uint8Array {
  const { data, dim } = qrRgba();
  return new Uint8Array(encodeJpeg({ width: dim, height: dim, data }, 90).data);
}

describe("qr-code (F-04)", () => {
  it("errors when a PNG texture contains a decodable QR code", async () => {
    const glb = await syntheticGlb({ textureImages: [{ bytes: qrPngBytes(), name: "sneaky" }] });
    const result = await validate(await syntheticZip({ glb }), { checks: ["qr-code"] });
    const findings = result.findings.filter((f) => f.check === "qr-code");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "error");
    assert.match(findings[0].where ?? "", /model\.glb/);
    assert.match(findings[0].where ?? "", /sneaky/);
    assert.equal(findings[0].data?.decoded, "https://example.com/qr");
  });

  it("errors when a JPEG texture contains a decodable QR code", async () => {
    const glb = await syntheticGlb({ textureImages: [{ bytes: qrJpegBytes(), mimeType: "image/jpeg", name: "jq" }] });
    const result = await validate(await syntheticZip({ glb }), { checks: ["qr-code"] });
    const findings = result.findings.filter((f) => f.check === "qr-code");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "error");
  });

  it("tells content from no content, counting byte-only payloads", () => {
    assert.equal(hasPayload({ data: "", binaryData: [] }), false);
    assert.equal(hasPayload(null), false);
    assert.equal(hasPayload({ data: "", binaryData: [0xde, 0xad] }), true);
    assert.equal(hasPayload({ data: "https://example.com/qr", binaryData: [0x68] }), true);
  });

  it("errors on a code-shaped detection whose content jsQR cannot read (Structured Append)", async () => {
    const result = await validate(await syntheticZip({ thumbnail: structuredAppendPngBytes() }), { checks: ["qr-code"] });
    const findings = result.findings.filter((f) => f.check === "qr-code");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "error");
    assert.equal(findings[0].where, "thumbnail.png");
    assert.match(findings[0].message, /can't read/);
  });

  it("treats a real code's outline as code-shaped", () => {
    const { data, dim } = qrRgba();
    const qr = jsQR(new Uint8ClampedArray(data.buffer), dim, dim);
    assert.ok(qr);
    assert.equal(plausibleLocation(qr.location, dim, dim, manifest.images), true);
  });

  it("ignores the empty detections jsQR reported on published art", () => {
    // Measured on Stitch Up Tips' thumbnail (nail art) and Gatekeeper Jacket's JacketF_2D_View texture, both 1024×1024:
    // finder patterns a few pixels apart, outline folded over itself or far outside the image.
    const stitch = {
      topLeftCorner: { x: 912.2, y: 704.9 }, topRightCorner: { x: 919.1, y: 709.9 }, bottomRightCorner: { x: 479.6, y: 498.9 }, bottomLeftCorner: { x: 401.5, y: 520.6 },
      topLeftFinderPattern: { x: 912.5, y: 705 }, topRightFinderPattern: { x: 919.3, y: 710 }, bottomLeftFinderPattern: { x: 48.8, y: 391.5 }
    };
    const gatekeeper = {
      topLeftCorner: { x: 361.1, y: 754.9 }, topRightCorner: { x: 355.9, y: 748.7 }, bottomRightCorner: { x: -2206.6, y: 1770 }, bottomLeftCorner: { x: 1606.6, y: 540.2 },
      topLeftFinderPattern: { x: 362, y: 754.5 }, topRightFinderPattern: { x: 357, y: 748.5 }, bottomLeftFinderPattern: { x: 969, y: 646.5 }
    };
    assert.equal(plausibleLocation(stitch, 1024, 1024, manifest.images), false);
    assert.equal(plausibleLocation(gatekeeper, 1024, 1024, manifest.images), false);
  });

  it("errors when the thumbnail contains a QR code", async () => {
    const result = await validate(await syntheticZip({ thumbnail: qrPngBytes() }), { checks: ["qr-code"] });
    const findings = result.findings.filter((f) => f.check === "qr-code");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "error");
    assert.equal(findings[0].where, "thumbnail.png");
  });

  it("reports a texture whose header claims more pixels than the decode budget instead of decoding it", async () => {
    const glb = await syntheticGlb({ textureImages: [{ bytes: pngHeaderBytes(12000, 12000), name: "bomb" }] });
    const result = await validate(await syntheticZip({ glb }), { checks: ["qr-code"] });
    const findings = result.findings.filter((f) => f.check === "qr-code");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "warning");
    assert.match(findings[0].message, /12000×12000 — too large to scan/);
    assert.match(findings[0].where ?? "", /bomb/);
  });

  it("reports a thumbnail above the decode budget the same way", async () => {
    const result = await validate(await syntheticZip({ thumbnail: pngHeaderBytes(20000, 20000) }), { checks: ["qr-code"] });
    const findings = result.findings.filter((f) => f.check === "qr-code");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "warning");
    assert.equal(findings[0].where, "thumbnail.png");
    assert.equal(findings[0].measured, "20000×20000");
  });

  it("judges a bomb by its IHDR even behind a leading chunk, and refuses a PNG whose header cannot be read", async () => {
    const hidden = await validate(await syntheticZip({ thumbnail: pngWithLeadingChunk(pngHeaderBytes(12000, 12000)) }), { checks: ["qr-code"] });
    const [finding] = hidden.findings.filter((f) => f.check === "qr-code");
    assert.equal(finding.severity, "warning");
    assert.match(finding.message, /12000×12000 — too large to scan/);

    const headless = new Uint8Array(40);
    headless.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    headless.set([0, 0, 0, 0, 0x49, 0x44, 0x41, 0x54], 8);
    const unreadable = await validate(await syntheticZip({ thumbnail: headless }), { checks: ["qr-code"] });
    const [warning] = unreadable.findings.filter((f) => f.check === "qr-code");
    assert.equal(warning.severity, "warning");
    assert.match(warning.message, /header that could not be read/);
  });

  it("still scans a JPEG with fill bytes after SOI", async () => {
    const glb = await syntheticGlb({ textureImages: [{ bytes: jpegWithFillBytes(qrJpegBytes()), mimeType: "image/jpeg", name: "jq" }] });
    const result = await validate(await syntheticZip({ glb }), { checks: ["qr-code"] });
    const findings = result.findings.filter((f) => f.check === "qr-code");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "error");
  });

  it("passes a clean wearable zip", async () => {
    const glb = await syntheticGlb({ texture: { size: 64 } });
    const result = await validate(await syntheticZip({ glb }), { checks: ["qr-code"] });
    assert.equal(result.findings.filter((f) => f.check === "qr-code").length, 0);
    assert.equal(result.checks.find((c) => c.check === "qr-code")?.status, "passed");
  });
});
