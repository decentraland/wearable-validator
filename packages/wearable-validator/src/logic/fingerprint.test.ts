import { describe, it } from "node:test";
import { Document } from "@gltf-transform/core";
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

  it("declines a model that asks for more work than the budget, and stops when cancelled", async () => {
    const sheet = bumpySheet();
    const cost = sheet.indices.length;
    assert.equal(await print({ geometry: sheet, skinned: false }, { ...rules, maxElements: cost - 1 }), null);
    assert.notEqual(await print({ geometry: sheet, skinned: false }, { ...rules, maxElements: cost }), null);
    const { doc } = await parseGlb(await syntheticGlb({ geometry: sheet, skinned: false }));
    assert.throws(() => fingerprintModel(doc, rules, manifest.materials.skinNameToken, AbortSignal.abort()), /abort/i);
  });

  it("counts indices, every node that reuses a mesh, and a skin's joints against the budget", () => {
    const sheet = bumpySheet();
    const build = (nodes: number, indices: Uint32Array, joints = 0) => {
      const doc = new Document();
      const buffer = doc.createBuffer();
      const scene = doc.createScene();
      const prim = doc.createPrimitive().setMode(4)
        .setAttribute("POSITION", doc.createAccessor().setType("VEC3").setArray(sheet.positions).setBuffer(buffer))
        .setIndices(doc.createAccessor().setType("SCALAR").setArray(indices).setBuffer(buffer));
      const mesh = doc.createMesh().addPrimitive(prim);
      const skin = joints ? doc.createSkin() : null;
      for (let j = 0; j < joints; j++) { const joint = doc.createNode(`bone${j}`); scene.addChild(joint); skin!.addJoint(joint); }
      for (let n = 0; n < nodes; n++) { const node = doc.createNode(`mesh${n}`).setMesh(mesh); if (skin) node.setSkin(skin); scene.addChild(node); }
      return doc;
    };
    const one = sheet.indices.length;
    const fits = (doc: Document, maxElements: number) => fingerprintModel(doc, { ...rules, maxElements }, manifest.materials.skinNameToken) !== null;
    // three vertices drawn a million times is a million triangles of work
    const repeated = Uint32Array.from({ length: 30_000 }, (_, i) => i % 3);
    assert.equal(fits(build(1, repeated), repeated.length - 1), false);
    assert.equal(fits(build(1, repeated), repeated.length), true);
    // the same mesh on four nodes is read four times
    assert.equal(fits(build(4, sheet.indices), 4 * one - 1), false);
    assert.equal(fits(build(4, sheet.indices), 4 * one), true);
    // a skin is read once, however many nodes use it
    assert.equal(fits(build(4, sheet.indices, 50), 4 * one + 49), false);
    assert.equal(fits(build(4, sheet.indices, 50), 4 * one + 50), true);
  });

  it("places a rigged mesh at bind pose when a whole bone chain was saved rotated", () => {
    const sheet = bumpySheet();
    const build = (armRotation: [number, number, number, number]) => {
      const doc = new Document();
      const buffer = doc.createBuffer();
      const scene = doc.createScene();
      // hips -> spine, and hips -> arm -> forearm -> hand -> five fingers: the arm chain outnumbers the trunk
      const names = ["hips", "spine", "arm", "forearm", "hand", "f1", "f2", "f3", "f4", "f5"];
      const parents = [-1, 0, 0, 2, 3, 4, 4, 4, 4, 4];
      const bind: [number, number, number][] = [[0, 1, 0], [0, 1.3, 0], [0.2, 1.4, 0], [0.5, 1.4, 0], [0.8, 1.4, 0], [0.9, 1.45, 0], [0.9, 1.42, 0], [0.9, 1.4, 0], [0.9, 1.38, 0], [0.9, 1.35, 0]];
      const joints = names.map((name) => doc.createNode(name));
      const inverse = new Float32Array(16 * names.length);
      names.forEach((_, j) => {
        const parent = parents[j];
        const at = bind[j], from = parent < 0 ? [0, 0, 0] : bind[parent];
        joints[j].setTranslation([at[0] - from[0], at[1] - from[1], at[2] - from[2]]);
        if (parent < 0) scene.addChild(joints[j]); else joints[parent].addChild(joints[j]);
        inverse.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -at[0], -at[1], -at[2], 1], j * 16);
      });
      joints[2].setRotation(armRotation);
      const skin = doc.createSkin().setInverseBindMatrices(doc.createAccessor().setType("MAT4").setArray(inverse).setBuffer(buffer));
      for (const joint of joints) skin.addJoint(joint);
      const prim = doc.createPrimitive().setMode(4)
        .setAttribute("POSITION", doc.createAccessor().setType("VEC3").setArray(sheet.positions).setBuffer(buffer))
        .setIndices(doc.createAccessor().setType("SCALAR").setArray(sheet.indices).setBuffer(buffer));
      scene.addChild(doc.createNode("mesh").setMesh(doc.createMesh().addPrimitive(prim)).setSkin(skin));
      return fingerprintModel(doc, rules, manifest.materials.skinNameToken)!;
    };
    const atBind = build([0, 0, 0, 1]);
    const armDown = build([0, 0, Math.sin(-0.35), Math.cos(-0.35)]);
    assert.ok(atBind.cells.length >= rules.minCells);
    assert.deepEqual(armDown.cells, atBind.cells);
  });

  it("follows a rigid mesh's bone to where it stands at bind, and reads only the vertices its indices reach", () => {
    const sheet = bumpySheet();
    const build = (headRotation: [number, number, number, number], sharedWithSkin = false) => {
      const doc = new Document();
      const buffer = doc.createBuffer();
      const scene = doc.createScene();
      const hips = doc.createNode("Avatar_Hips").setTranslation([0, 1, 0]);
      const head = doc.createNode("Avatar_Head").setTranslation([0, 0.6, 0]).setRotation(headRotation);
      scene.addChild(hips.addChild(head));
      const inverse = Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -1, 0, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -1.6, 0, 1]);
      const skin = doc.createSkin().addJoint(hips).addJoint(head).setInverseBindMatrices(doc.createAccessor().setType("MAT4").setArray(inverse).setBuffer(buffer));
      // a body mesh keeps the skin in the file; the hat is a plain mesh under the head bone
      const body = doc.createPrimitive().setMode(4).setMaterial(doc.createMaterial("AvatarSkin_MAT"))
        .setAttribute("POSITION", doc.createAccessor().setType("VEC3").setArray(Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0])).setBuffer(buffer));
      scene.addChild(doc.createNode("body").setMesh(doc.createMesh().addPrimitive(body)).setSkin(skin));
      // optionally the hat shares one POSITION accessor with far-away skin vertices its indices never reach
      const far = Float32Array.from({ length: 300 }, (_, i) => 5 + i * 0.01);
      const positions = sharedWithSkin ? Float32Array.from([...sheet.positions, ...far]) : sheet.positions;
      const hat = doc.createPrimitive().setMode(4)
        .setAttribute("POSITION", doc.createAccessor().setType("VEC3").setArray(positions).setBuffer(buffer))
        .setIndices(doc.createAccessor().setType("SCALAR").setArray(sheet.indices).setBuffer(buffer));
      head.addChild(doc.createNode("hat").setMesh(doc.createMesh().addPrimitive(hat)));
      return fingerprintModel(doc, rules, manifest.materials.skinNameToken)!;
    };
    const atBind = build([0, 0, 0, 1]);
    assert.ok(atBind.cells.length >= rules.minCells);
    assert.deepEqual(build([0, Math.sin(0.4), 0, Math.cos(0.4)]).cells, atBind.cells);
    assert.deepEqual(build([0, 0, 0, 1], true).cells, atBind.cells);
  });

  it("ignores vertices that are nowhere", async () => {
    const sheet = bumpySheet();
    const broken = Float32Array.from(sheet.positions);
    broken[0] = Number.NaN; broken[4] = Number.POSITIVE_INFINITY;
    const print_ = await some({ geometry: { positions: broken, indices: sheet.indices }, skinned: false });
    assert.ok(print_.cells.every(Number.isFinite));
    assert.equal(print_.cells.length, (await some({ geometry: sheet, skinned: false })).cells.length - 2);
  });
});
