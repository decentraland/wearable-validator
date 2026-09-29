import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Finding } from "@dcl-regenesislabs/wearable-validator";
import { groupFindings } from "../src/logic/group-findings.js";

function finding(check: string, message: string, where?: string, severity: Finding["severity"] = "error"): Finding {
  return { check, group: "model", severity, message, rule: "M-01", docs: "https://docs.example/#x", ...(where ? { where } : {}) };
}

describe("groupFindings", () => {
  it("tells a finding once when the body shapes' files differ only in their folder, naming the file without it", () => {
    const male = '"male/SPRITE.glb" › Untitled';
    const female = '"female/SPRITE.glb" › Untitled';
    const groups = groupFindings([
      finding("texture-size", `${male} is 1024×1024; the maximum texture size is 512×512.`, male),
      finding("texture-size", `${female} is 1024×1024; the maximum texture size is 512×512.`, female)
    ]);
    assert.deepEqual(groups.map(({ message, shapes, count }) => ({ message, shapes, count })), [
      { message: '"SPRITE.glb" › Untitled is 1024×1024; the maximum texture size is 512×512.', shapes: ["male", "female"], count: 2 }
    ]);
  });

  it("groups a message that does not name the file by where it points, and counts plain repeats", () => {
    const seam = "The loop will visibly snap.";
    const groups = groupFindings([finding("loop-seam", seam, "male/a.glb", "warning"), finding("loop-seam", seam, "female/a.glb", "warning"), finding("thumbnail", "No alpha."), finding("thumbnail", "No alpha.")]);
    assert.deepEqual(groups.map(({ finding: first, shapes, count }) => [first.check, shapes, count]), [["loop-seam", ["male", "female"], 2], ["thumbnail", [], 2]]);
  });

  it("keeps findings apart when their files or values differ", () => {
    const groups = groupFindings([
      finding("texture-size", '"male/a.glb" › Hat is 1024×1024.', '"male/a.glb" › Hat'),
      finding("texture-size", '"female/a.glb" › Hat is 2048×2048.', '"female/a.glb" › Hat'),
      finding("texture-size", '"male/a.glb" › Belt is 1024×1024.', '"male/a.glb" › Belt')
    ]);
    assert.equal(groups.length, 3);
    assert.ok(groups.every(({ shapes }) => shapes.length === 0), "one body shape each: the message keeps its folder");
    assert.equal(groups[0].message, '"male/a.glb" › Hat is 1024×1024.');
  });
});
