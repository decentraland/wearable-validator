import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fingerprintModel, fingerprintVersion, type ModelFingerprint } from "./fingerprint.js";
import { commonGeometry, createCatalog, type CatalogEntry } from "./similarity.js";
import { parseGlb } from "./gltf.js";
import { manifest } from "../manifest/index.js";
import { syntheticGlb } from "#test/helpers/synthetic.js";
import { bumpySheet, merged, shifted, uvSphere } from "#test/helpers/meshes.js";

const rules = manifest.similarItems;
type Mesh = ReturnType<typeof bumpySheet>;
const print = async (geometry: Mesh): Promise<ModelFingerprint> =>
  fingerprintModel((await parseGlb(await syntheticGlb({ geometry, skinned: false }))).doc, rules, manifest.materials.skinNameToken)!;
const entry = (n: number, creator: string, models: ModelFingerprint[], publishedAt = 1_650_000_000 + n): CatalogEntry =>
  ({ urn: `urn:test:${n}`, name: `Item ${n}`, creator, publishedAt, url: `https://decentraland.org/marketplace/contracts/0x${n}/items/0`, models });
const none = { cells: [], signatures: [] };
const fingerprint = fingerprintVersion(rules);

describe("catalog comparison", () => {
  it("finds the same mesh by position and by shape, and nothing in another mesh", async () => {
    const catalog = createCatalog({ fingerprint, entries: [entry(1, "0xa", [await print(bumpySheet())]), entry(2, "0xb", [await print(bumpySheet(5))])], common: none }, { rules });
    const answer = await catalog.match([await print(bumpySheet())]);
    assert.equal(answer.compared, true);
    assert.deepEqual(answer.matches.map((match) => match.urn), ["urn:test:1"]);
    assert.equal(answer.matches[0].position, 1);
    assert.equal(answer.matches[0].shape, 1);
    assert.equal(answer.matches[0].contains, 1);
  });

  it("finds a moved copy by shape alone", async () => {
    const catalog = createCatalog({ fingerprint, entries: [entry(1, "0xa", [await print(bumpySheet())])], common: none }, { rules });
    const { matches } = await catalog.match([await print(shifted(bumpySheet(), [0.0137, 0.0021, 0]))]);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].shape, 1);
    assert.ok(matches[0].position < rules.warnShare);
  });

  it("does not match two primitives that only connect the same way", async () => {
    const catalog = createCatalog({ fingerprint, entries: [entry(1, "0xa", [await print(uvSphere())])], common: none }, { rules });
    assert.deepEqual((await catalog.match([await print(shifted(uvSphere(10, 16, 0.2), [0.3, 0, 0]))])).matches, []);
  });

  it("reports a published item that sits whole inside a larger upload", async () => {
    const catalog = createCatalog({ fingerprint, entries: [entry(1, "0xa", [await print(bumpySheet())])], common: none }, { rules });
    const upload = merged(bumpySheet(), shifted(bumpySheet(3, 24), [0, -0.6, 0]), shifted(bumpySheet(4, 24), [0, -1.0, 0]));
    const { matches } = await catalog.match([await print(upload)]);
    assert.equal(matches.length, 1);
    assert.ok(matches[0].share < rules.warnShare, `share ${matches[0].share}`);
    assert.ok(matches[0].contains >= rules.containsShare);
  });

  it("never matches the uploader's own items, told with each lookup", async () => {
    const sheet = await print(bumpySheet());
    const catalog = createCatalog({ fingerprint, entries: [entry(3, "0xC", [sheet], 300), entry(1, "0xa", [sheet], 100), entry(2, "0xb", [sheet], 200)], common: none }, { rules });
    assert.deepEqual((await catalog.match([sheet])).matches.map((match) => match.publishedAt), [100, 200, 300]);
    assert.deepEqual((await catalog.match([sheet], { ownCreators: ["0xA", "0xc"] })).matches.map((match) => match.urn), ["urn:test:2"]);
    assert.equal((await catalog.match([sheet])).matches.length, 3); // the same catalog serves the next uploader
  });

  it("answers for each uploaded model on its own", async () => {
    const hoodie = await print(bumpySheet());
    const big = await print(merged(bumpySheet(), shifted(bumpySheet(3, 24), [0, -0.6, 0]), shifted(bumpySheet(4, 24), [0, -1.0, 0])));
    const catalog = createCatalog({ fingerprint, entries: [entry(1, "0xa", [hoodie])], common: none }, { rules });
    // model 0 only contains the item, model 1 is the item: neither answer may hide the other
    const { matches } = await catalog.match([big, hoodie]);
    assert.deepEqual(matches.map((match) => match.model), [0, 1]);
    assert.ok(matches[0].share < rules.warnShare && matches[0].contains >= rules.containsShare);
    assert.equal(matches[1].share, 1);
  });

  it("refuses an index fingerprinted by another version", () => {
    assert.throws(() => createCatalog({ fingerprint: "0:1mm", entries: [], common: none }, { rules }), /Rebuild the index/);
    assert.throws(() => createCatalog({ fingerprint, entries: [], common: none }, { rules: { ...rules, gridMillimeters: 4 } }), /Rebuild the index/);
  });

  it("removes base-avatar geometry and what many creators ship before comparing", async () => {
    const body = await print(bumpySheet(9));
    const design = bumpySheet(2);
    const withBody = await print(merged(design, bumpySheet(9)));
    const other = await print(merged(shifted(bumpySheet(6), [0, -0.5, 0]), bumpySheet(9)));
    // as a base avatar
    let common = commonGeometry([], [body], rules);
    let answer = await createCatalog({ fingerprint, entries: [entry(1, "0xa", [other])], common }, { rules }).match([withBody]);
    assert.equal(answer.compared, true);
    assert.deepEqual(answer.matches, []);
    assert.equal((await createCatalog({ fingerprint, entries: [entry(1, "0xa", [other])], common }, { rules }).match([body])).compared, false);
    // as geometry found in many creators' items
    const crowd = Array.from({ length: rules.commonCreators }, (_, n) => entry(n + 10, `0x${n}`, [body]));
    common = commonGeometry(crowd, [], rules);
    assert.ok(common.cells.length >= body.cells.length && common.signatures.length === 1);
    assert.equal(commonGeometry(crowd.slice(1), [], rules).cells.length, 0);
    // without the removal the shared body alone is not a warning, but it is counted
    answer = await createCatalog({ fingerprint, entries: [entry(1, "0xa", [other])], common: none }, { rules }).match([withBody]);
    assert.deepEqual(answer.matches, []);
  });
});
