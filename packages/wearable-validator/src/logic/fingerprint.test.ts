import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fingerprintModel } from "./fingerprint.js";
import { parseGlb } from "./gltf.js";
import { manifest } from "../manifest/index.js";
import { syntheticGlb } from "#test/helpers/synthetic.js";
import { bumpySheet, uvSphere } from "#test/helpers/meshes.js";

const rules = manifest.similarItems;
const print = async (options: Parameters<typeof syntheticGlb>[0]) => fingerprintModel((await parseGlb(await syntheticGlb(options))).doc, rules, manifest.materials.skinNameToken);

describe("model fingerprints", () => {
  it("is the same for the same mesh with another material, and one part per connected piece", async () => {
    const a = await print({ geometry: bumpySheet(), skinned: false });
    const b = await print({ geometry: bumpySheet(), skinned: false, materialName: "Other_MAT", texture: { size: 64 } });
    assert.deepEqual(a, b);
    assert.equal(a.parts.length, 1);
    assert.ok(a.cells.length >= rules.minCells);
    assert.ok(a.parts[0].triangles >= rules.minPartTriangles && a.parts[0].kinds >= rules.minPartKinds);
  });

  it("keeps the shape and loses the cells when the mesh is moved or scaled", async () => {
    const a = await print({ geometry: bumpySheet(), skinned: false });
    const moved = await print({ geometry: bumpySheet(), skinned: false, offset: [0.013, 0.002, 0] });
    const scaled = await print({ geometry: bumpySheet(), skinned: false, nodeScale: 1.07 });
    for (const other of [moved, scaled]) {
      assert.equal(other.parts[0].signature, a.parts[0].signature);
      assert.ok(Math.abs(other.parts[0].ratios[0] - a.parts[0].ratios[0]) < rules.ratioTolerance / 10);
      assert.ok(Math.abs(other.parts[0].ratios[1] - a.parts[0].ratios[1]) < rules.ratioTolerance / 10);
      assert.ok(other.cells.filter((cell) => a.cells.includes(cell)).length < a.cells.length / 2);
    }
  });

  it("does not depend on how the exporter split or ordered the vertices", async () => {
    const sheet = bumpySheet();
    // every triangle with its own three vertices, triangles reversed: what a re-export with new UV seams can produce
    const positions: number[] = [];
    for (let t = sheet.indices.length - 3; t >= 0; t -= 3) for (let k = 0; k < 3; k++) positions.push(...sheet.positions.subarray(sheet.indices[t + k] * 3, sheet.indices[t + k] * 3 + 3));
    const split = await print({ geometry: { positions: Float32Array.from(positions) }, skinned: false });
    const indexed = await print({ geometry: sheet, skinned: false });
    assert.deepEqual(split.cells, indexed.cells);
    assert.equal(split.parts.length, 1);
    assert.equal(split.parts[0].signature, indexed.parts[0].signature);
    assert.equal(split.parts[0].triangles, indexed.parts[0].triangles);
    assert.ok(Math.abs(split.parts[0].ratios[0] - indexed.parts[0].ratios[0]) < 1e-9);
  });

  it("gives another signature to another mesh, and few kinds to a primitive", async () => {
    const a = await print({ geometry: bumpySheet(), skinned: false });
    const b = await print({ geometry: bumpySheet(7), skinned: false });
    assert.notEqual(a.parts[0].signature, b.parts[0].signature);
    const sphere = await print({ geometry: uvSphere(), skinned: false });
    assert.ok(sphere.parts[0].triangles >= rules.minPartTriangles);
    assert.ok(sphere.parts[0].kinds < rules.minPartKinds);
  });

  it("leaves out skin-material meshes and colliders", async () => {
    const skin = await print({ geometry: bumpySheet(), skinned: false, materialName: "AvatarSkin_MAT" });
    assert.deepEqual(skin, { cells: [], parts: [] });
    const withCollider = await print({ geometry: bumpySheet(), skinned: false, colliderTriangles: 40 });
    assert.deepEqual(withCollider, await print({ geometry: bumpySheet(), skinned: false }));
  });

  it("places a skinned mesh through its joints", async () => {
    const standing = await print({ geometry: bumpySheet(), standing: true });
    const unskinned = await print({ geometry: bumpySheet(), skinned: false });
    assert.deepEqual(standing.cells, unskinned.cells);
  });
});
