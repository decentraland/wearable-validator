import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BodyShape } from "@dcl/schemas";
import { validate, manifest, fingerprintModel, createCatalog, type Catalog, type CatalogEntry, type ModelFingerprint } from "../../../index.js";
import { parseGlb } from "../../../logic/gltf.js";
import { found, status } from "#test/helpers/findings.js";
import { syntheticGlb, syntheticZip } from "#test/helpers/synthetic.js";
import { bumpySheet, merged, shifted } from "#test/helpers/meshes.js";

const rules = manifest.similarItems;
type Mesh = ReturnType<typeof bumpySheet>;
const glb = (geometry: Mesh) => syntheticGlb({ geometry, skinned: false });
const print = async (geometry: Mesh): Promise<ModelFingerprint> => fingerprintModel((await parseGlb(await glb(geometry))).doc, rules, manifest.materials.skinNameToken);
const entry = (n: number, creator: string, models: ModelFingerprint[], publishedAt = 1_650_000_000 + n * 86_400): CatalogEntry =>
  ({ urn: `urn:test:${n}`, name: `Hoodie ${n}`, creator, publishedAt, url: `https://decentraland.org/marketplace/contracts/0x${n}/items/0`, models });
const catalogOf = (entries: CatalogEntry[]): Catalog => createCatalog({ entries, common: { cells: [], signatures: [] } }, { rules });
const run = async (geometry: Mesh, catalog?: Catalog) => validate(await syntheticZip({ glb: await glb(geometry) }), { checks: ["similar-items"], services: { catalog } });

describe("similar-items (D-01)", () => {
  it("warns, naming the earliest published item with its link", async () => {
    const sheet = await print(bumpySheet());
    const result = await run(bumpySheet(), catalogOf([entry(2, "0xbbb", [sheet]), entry(1, "0xaaa", [sheet])]));
    assert.equal(status(result, "similar-items"), "warning");
    const findings = found(result, "similar-items");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "warning");
    assert.match(findings[0].message, /100% of the geometry of ".+\.glb" matches "Hoodie 1", published on 2022-04-16 by 0xaaa: https:\/\/decentraland\.org\/marketplace\/contracts\/0x1\/items\/0\./);
    assert.equal(findings[0].limit, `${rules.warnShare * 100}%`);
    assert.equal(findings[0].data?.urn, "urn:test:1");
    assert.equal(result.passed, null); // a subset never mints a verdict
  });

  it("warns on a copy that was moved", async () => {
    const result = await run(shifted(bumpySheet(), [0.011, 0.004, 0]), catalogOf([entry(1, "0xaaa", [await print(bumpySheet())])]));
    assert.equal(status(result, "similar-items"), "warning");
    assert.equal(found(result, "similar-items")[0].data?.shape, 1);
  });

  it("passes a model of its own", async () => {
    const result = await run(bumpySheet(8), catalogOf([entry(1, "0xaaa", [await print(bumpySheet())])]));
    assert.equal(status(result, "similar-items"), "passed");
    assert.equal(result.checks[0].measured, "no similar published item");
  });

  it("says nothing about a template many creators already published", async () => {
    const sheet = await print(bumpySheet());
    const many = Array.from({ length: rules.templateCreators }, (_, n) => entry(n + 1, `0x${n}`, [sheet]));
    const result = await run(bumpySheet(), catalogOf(many));
    assert.equal(status(result, "similar-items"), "passed");
    assert.equal(result.checks[0].measured, "a widely used template");
    const fewer = await run(bumpySheet(), catalogOf(many.slice(1)));
    assert.equal(status(fewer, "similar-items"), "warning");
  });

  it("warns when a published item sits whole inside the model", async () => {
    const upload = merged(bumpySheet(), shifted(bumpySheet(3, 24), [0, -0.6, 0]), shifted(bumpySheet(4, 24), [0, -1.0, 0]));
    const result = await run(upload, catalogOf([entry(1, "0xaaa", [await print(bumpySheet())])]));
    const findings = found(result, "similar-items");
    assert.equal(findings.length, 1);
    assert.match(findings[0].message, /contains 100% of "Hoodie 1", published on/);
    assert.equal(findings[0].limit, `${rules.containsShare * 100}%`);
  });

  it("warns once when both body shapes carry the same mesh", async () => {
    const bytes = await glb(bumpySheet());
    const manifest = { name: "Test Wearable", description: "synthetic", rarity: "common", data: { category: "upper_body", tags: ["test"], hides: [], replaces: [], representations: [
      { bodyShapes: [BodyShape.MALE], mainFile: "male.glb", contents: ["male.glb"] },
      { bodyShapes: [BodyShape.FEMALE], mainFile: "female.glb", contents: ["female.glb"] }
    ] } };
    const zip = await syntheticZip({ manifest, extraFiles: { "male.glb": bytes, "female.glb": bytes } });
    const result = await validate(zip, { checks: ["similar-items"], services: { catalog: catalogOf([entry(1, "0xaaa", [await print(bumpySheet())])]) } });
    assert.equal(found(result, "similar-items").length, 1);
    assert.equal(found(result, "similar-items")[0].where, "male.glb");
  });

  it("passes a model with too little geometry of its own", async () => {
    const result = await validate(await syntheticZip({ glb: await syntheticGlb({ triangles: 2 }) }), { checks: ["similar-items"], services: { catalog: catalogOf([]) } });
    assert.equal(status(result, "similar-items"), "passed");
    assert.equal(result.checks[0].measured, "too little geometry of its own to compare");
  });

  it("is skipped without a catalog and stays out of the default run", async () => {
    const result = await run(bumpySheet());
    assert.equal(status(result, "similar-items"), "skipped");
    assert.match(result.checks[0].skipReason ?? "", /services\.catalog/);
    const full = await validate(await syntheticZip());
    assert.equal(status(full, "similar-items"), undefined);
    assert.equal(full.passed, true);
  });

  it("runs on an emote's props", async () => {
    const zip = await syntheticZip({ kind: "emote" });
    const result = await validate(zip, { groups: ["catalog"], services: { catalog: catalogOf([]) } });
    assert.equal(status(result, "similar-items"), "passed");
  });
});
