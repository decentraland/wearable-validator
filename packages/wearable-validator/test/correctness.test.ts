import assert from "node:assert/strict";
import { test } from "node:test";
import { BodyShape, EmoteCategory, Rarity } from "@dcl/schemas";
import { validate } from "../src/index.js";
import { syntheticGlb, syntheticZip } from "#test/helpers/synthetic.js";

for (const mode of ["builder", "entity"] as const) {
  test(`${mode} metadata rejects unknown rarity and body shape`, async () => {
    const metadata = { name: "Test", rarity: "invalid", data: { category: "hat", representations: [{ bodyShapes: ["invalid"], mainFile: "model.glb", contents: ["model.glb"] }] } };
    const glb = await syntheticGlb();
    const input = mode === "builder" ? await syntheticZip({ glb, manifest: metadata }) : { files: new Map([["model.glb", glb]]), metadata };
    const result = await validate(input, { checks: ["metadata", "representations"] });
    assert.equal(result.checks.find(c => c.check === "metadata")?.status, "failed");
    assert.equal(result.checks.find(c => c.check === "representations")?.status, "failed");
    assert.ok(result.findings.some(f => f.where === "rarity"));
    assert.ok(result.findings.some(f => f.message.includes("invalid") && f.check === "representations"));
  });
}

test("known rarity and body shapes pass their checks", async () => {
  const metadata = { name: "Test", rarity: Rarity.COMMON, data: { category: "hat", representations: [{ bodyShapes: [BodyShape.MALE, BodyShape.FEMALE], mainFile: "model.glb", contents: ["model.glb"] }] } };
  const result = await validate(await syntheticZip({ manifest: metadata }), { checks: ["metadata", "representations"] });
  assert.ok(result.checks.every(c => c.status === "passed"));
});

test("distinct materials sharing a name are measured and validated consistently", async () => {
  const glb = await syntheticGlb({ materialName: "Same", extraMaterialDefs: [{ name: "Same" }, { name: "Same" }] });
  const result = await validate(glb, { category: "hat", checks: ["material-count"] });
  assert.equal(result.checks[0]?.status, "failed");
  assert.equal(result.checks[0]?.measured, "3 materials");
  assert.equal(result.findings[0]?.measured, 3);
});

test("material measurement uses the per-representation maximum", async () => {
  const first = await syntheticGlb({ materialName: "First", extraMaterials: 1 });
  const second = await syntheticGlb({ materialName: "Second", extraMaterialDefs: [{ name: "Other" }] });
  const result = await validate({ files: new Map([["male.glb", first], ["female.glb", second]]), metadata: {
    name: "Test", data: { category: "hat", representations: [
      { bodyShapes: [BodyShape.MALE], mainFile: "male.glb", contents: ["male.glb"] },
      { bodyShapes: [BodyShape.FEMALE], mainFile: "female.glb", contents: ["female.glb"] }
    ] }
  } }, { category: "hat", checks: ["material-count"] });
  assert.equal(result.checks[0]?.status, "passed");
  assert.equal(result.checks[0]?.measured, "2 materials");
});

for (const [size, status] of [[2.424, "failed"], [2.42, "passed"], [2.419, "passed"]] as const) {
  test(`bounding-box checks ${size} m without rounding away excess`, async () => {
    const result = await validate(await syntheticGlb({ scale: size }), { category: "hat", checks: ["bounding-box"] });
    assert.equal(result.checks[0]?.status, status);
    assert.ok(result.checks[0]?.measured?.includes(String(size)));
  });
}

for (const location of ["flat", "data"] as const) {
  for (const stiffness of [999, 2]) {
    test(`Builder ${location} spring settings validate stiffness ${stiffness}`, async () => {
      const springBones = [{ name: "springbone", stiffness }];
      const metadata = location === "flat" ? { name: "Test", category: "hat", springBones } : { name: "Test", data: { category: "hat", springBones } };
      const result = await validate(await syntheticZip({ manifest: metadata }), { checks: ["spring-bones"] });
      assert.equal(result.checks[0]?.status, stiffness === 999 ? "failed" : "passed");
      if (stiffness === 999) assert.equal(result.findings[0]?.measured, stiffness);
    });
  }
}

for (const category of ["invalid", ...Object.values(EmoteCategory).filter((value): value is EmoteCategory => typeof value === "string")]) {
  test(`emote category ${category} is checked against platform categories`, async () => {
    const result = await validate(await syntheticZip({ kind: "emote", manifest: { name: "Test", category } }), { checks: ["category"] });
    assert.equal(result.checks[0]?.status, category === "invalid" ? "failed" : "passed");
  });
}

test("bounding-box measurement includes an oversized second representation", async () => {
  const first = await syntheticGlb();
  const second = await syntheticGlb({ scale: 2.424 });
  const result = await validate({ files: new Map([["male.glb", first], ["female.glb", second]]), metadata: {
    name: "Test", data: { category: "hat", representations: [
      { bodyShapes: [BodyShape.MALE], mainFile: "male.glb", contents: ["male.glb"] },
      { bodyShapes: [BodyShape.FEMALE], mainFile: "female.glb", contents: ["female.glb"] }
    ] }
  } }, { category: "hat", checks: ["bounding-box"] });
  assert.equal(result.checks[0]?.status, "failed");
  assert.match(result.checks[0]?.measured ?? "", /female\.glb: 2\.424/);
  assert.equal(result.findings[0]?.where, "female.glb");
});

test("an emote.json holding entity metadata keeps its category and representations from emoteDataADR74", async () => {
  const representations = [{ bodyShapes: [BodyShape.MALE, BodyShape.FEMALE], mainFile: "model.glb", contents: ["model.glb"] }];
  const manifest = { name: "Test", description: "synthetic", rarity: "common", emoteDataADR74: { category: "fun", loop: false, tags: [], representations } };
  const result = await validate(await syntheticZip({ kind: "emote", manifest }), { checks: ["category", "representations"] });
  assert.deepEqual(Object.fromEntries(result.checks.map((row) => [row.check, row.status])), { category: "passed", representations: "passed" });
});
