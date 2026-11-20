import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fingerprintModel } from "./fingerprint.js";
import { parseGlb } from "./gltf.js";
import { manifest } from "../manifest/index.js";
import { syntheticGlb } from "#test/helpers/synthetic.js";
import { bumpySheet, uvSphere } from "#test/helpers/meshes.js";

const rules = manifest.similarItems;
const print = async (options: Parameters<typeof syntheticGlb>[0], limits = rules) => fingerprintModel((await parseGlb(await syntheticGlb(options))).doc, limits, manifest.materials.skinNameToken);
const some = async (options: Parameters<typeof syntheticGlb>[0]) => (await print(options))!;

describe("model fingerprints", () => {
  it("is the same for the same mesh with another material, and one part per connected piece", async () => {
    const a = await some({ geometry: bumpySheet(), skinned: false });
    const b = await some({ geometry: bumpySheet(), skinned: false, materialName: "Other_MAT", texture: { size: 64 } });
    assert.deepEqual(a, b);
    assert.equal(a.parts.length, 1);
    assert.ok(a.cells.length >= rules.minCells);
    assert.ok(a.parts[0].triangles >= rules.minPartTriangles && a.parts[0].kinds >= rules.minPartKinds);
  });

  it("keeps the shape and loses the cells when the mesh is moved or scaled", async () => {
    const a = await some({ geometry: bumpySheet(), skinned: false });
    const moved = await some({ geometry: bumpySheet(), skinned: false, offset: [0.013, 0.002, 0] });
    const scaled = await some({ geometry: bumpySheet(), skinned: false, nodeScale: 1.07 });
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
    const split = await some({ geometry: { positions: Float32Array.from(positions) }, skinned: false });
    const indexed = await some({ geometry: sheet, skinned: false });
    assert.deepEqual(split.cells, indexed.cells);
    assert.equal(split.parts.length, 1);
    assert.equal(split.parts[0].signature, indexed.parts[0].signature);
    assert.equal(split.parts[0].triangles, indexed.parts[0].triangles);
    assert.ok(Math.abs(split.parts[0].ratios[0] - indexed.parts[0].ratios[0]) < 1e-9);
  });

  it("gives another signature to another mesh, and few kinds to a primitive", async () => {
    const a = await some({ geometry: bumpySheet(), skinned: false });
    const b = await some({ geometry: bumpySheet(7), skinned: false });
    assert.notEqual(a.parts[0].signature, b.parts[0].signature);
    const sphere = await some({ geometry: uvSphere(), skinned: false });
    assert.ok(sphere.parts[0].triangles >= rules.minPartTriangles);
    assert.ok(sphere.parts[0].kinds < rules.minPartKinds);
  });

  it("leaves out skin-material meshes and colliders", async () => {
    const skin = await some({ geometry: bumpySheet(), skinned: false, materialName: "AvatarSkin_MAT" });
    assert.deepEqual(skin, { cells: [], parts: [] });
    const withCollider = await print({ geometry: bumpySheet(), skinned: false, colliderTriangles: 40 });
    assert.deepEqual(withCollider, await print({ geometry: bumpySheet(), skinned: false }));
  });

  it("places a skinned mesh at bind pose, whatever pose the file was saved in", async () => {
    const standing = await some({ geometry: bumpySheet(), standing: true });
    const unskinned = await some({ geometry: bumpySheet(), skinned: false });
    assert.deepEqual(standing.cells, unskinned.cells);
    const posed = await some({ geometry: bumpySheet(), standing: true, pose: { Avatar_LeftArm: [0.2, 0.1, 0], Avatar_Head: [0, 0.3, 0.1], Avatar_Hips: [0.05, 0, 0] } });
    assert.deepEqual(posed.cells, standing.cells);
    assert.equal(posed.parts[0].signature, standing.parts[0].signature);
    assert.ok(Math.abs(posed.parts[0].ratios[0] - standing.parts[0].ratios[0]) < 1e-9);
  });

  it("reads a triangle strip and a fan as the surface they draw", async () => {
    const ribbon: number[] = [];
    for (let i = 0; i < 120; i++) ribbon.push(i * 0.004, 1 + (i % 2) * 0.03 + Math.sin(i) * 0.004, Math.cos(i * 0.7) * 0.01);
    const positions = Float32Array.from(ribbon);
    const list: number[] = [];
    for (let i = 0; i + 2 < 120; i++) list.push(i, i + 1, i + 2);
    const strip = await some({ geometry: { positions, mode: 5 }, skinned: false });
    assert.deepEqual(strip, await some({ geometry: { positions, indices: Uint32Array.from(list) }, skinned: false }));
    assert.equal(strip.parts[0].triangles, 118);
    const fan: number[] = [];
    for (let i = 1; i + 1 < 120; i++) fan.push(0, i, i + 1);
    assert.deepEqual(await some({ geometry: { positions, mode: 6 }, skinned: false }), await some({ geometry: { positions, indices: Uint32Array.from(fan) }, skinned: false }));
  });

  it("declines a model that draws more vertices than the budget, and stops when cancelled", async () => {
    const vertices = bumpySheet().positions.length / 3;
    assert.equal(await print({ geometry: bumpySheet(), skinned: false }, { ...rules, maxVertices: vertices - 1 }), null);
    assert.notEqual(await print({ geometry: bumpySheet(), skinned: false }, { ...rules, maxVertices: vertices }), null);
    const { doc } = await parseGlb(await syntheticGlb({ geometry: bumpySheet(), skinned: false }));
    assert.throws(() => fingerprintModel(doc, rules, manifest.materials.skinNameToken, AbortSignal.abort()), /abort/i);
  });
});
