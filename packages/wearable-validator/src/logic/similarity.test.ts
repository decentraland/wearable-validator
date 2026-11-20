import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fingerprintModel, fingerprintVersion, type ModelFingerprint } from "./fingerprint.js";
import { commonGeometry, createCatalog, presentable, type CatalogEntry } from "./similarity.js";
import { parseGlb } from "./gltf.js";
import { manifest } from "../manifest/index.js";
import { syntheticGlb } from "#test/helpers/synthetic.js";
import { bumpySheet, merged, shifted, uvSphere } from "#test/helpers/meshes.js";

const rules = manifest.similarItems;
type Mesh = ReturnType<typeof bumpySheet>;
const print = async (geometry: Mesh): Promise<ModelFingerprint> =>
  fingerprintModel((await parseGlb(await syntheticGlb({ geometry, skinned: false }))).doc, rules, manifest.materials.skinNameToken)!;
const wallet = (short: string): string => `0x${short.slice(2).padStart(40, "0")}`;
const entry = (n: number, creator: string, models: ModelFingerprint[], publishedAt = 1_650_000_000 + n): CatalogEntry =>
  ({ urn: `urn:test:${n}`, name: `Item ${n}`, creator: wallet(creator), publishedAt, url: `https://decentraland.org/marketplace/contracts/0x${String(n).padStart(40, "0")}/items/0`, models });
const none = { cells: [], signatures: [] };
const fingerprint = fingerprintVersion(rules);
const t = rules.earliestPublishedAt;

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
    const catalog = createCatalog({ fingerprint, entries: [entry(3, "0xC", [sheet], t + 300), entry(1, "0xa", [sheet], t + 100), entry(2, "0xb", [sheet], t + 200)], common: none }, { rules });
    assert.deepEqual((await catalog.match([sheet])).matches.map((match) => match.publishedAt - t), [100, 200, 300]);
    assert.deepEqual((await catalog.match([sheet], { ownCreators: [wallet("0xA"), wallet("0xc")] })).matches.map((match) => match.urn), ["urn:test:2"]);
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

  it("reads a fingerprint it did not make as data", async () => {
    const sheet = await print(bumpySheet());
    const catalog = createCatalog({ fingerprint, entries: [entry(1, "0xa", [sheet])], common: none }, { rules });
    const padded = { cells: [...sheet.cells, ...sheet.cells, Number.NaN, Number.POSITIVE_INFINITY], parts: [...sheet.parts, { signature: "x", triangles: Number.NaN, kinds: 99, ratios: [0, 0] as [number, number] }] };
    const { matches } = await catalog.match([padded]);
    assert.equal(matches[0].position, 1);
    assert.equal(matches[0].contains, 1); // repeated cells do not count twice
  });

  it("finds exact copies in an index that holds a broken entry", async () => {
    const sheet = await print(bumpySheet());
    const broken = { cells: [Number.NaN, ...(await print(bumpySheet(4))).cells], parts: [] };
    const catalog = createCatalog({ fingerprint, entries: [entry(1, "0xa", [broken]), entry(2, "0xb", [sheet]), entry(3, "0xc", [await print(bumpySheet(6))])], common: none }, { rules });
    assert.deepEqual((await catalog.match([sheet])).matches.map((match) => match.urn), ["urn:test:2"]);
  });

  it("ignores what is not a fingerprint instead of failing", async () => {
    const sheet = await print(bumpySheet());
    const catalog = createCatalog({ fingerprint, entries: [entry(1, "0xa", [sheet])], common: none }, { rules });
    const junk = [null, {}, { cells: "x", parts: 3 }, { cells: [1, "2", null], parts: [null, { signature: 7, triangles: 99, kinds: 99, ratios: [0, 0] }, { signature: "s", triangles: 99, kinds: 99 }] }] as unknown as ModelFingerprint[];
    assert.deepEqual(await catalog.match(junk), { compared: false, matches: [] });
    assert.deepEqual(await catalog.match("nope" as unknown as ModelFingerprint[]), { compared: false, matches: [] });
    // only the first maxModels models of a lookup are compared
    const many = [...Array.from({ length: rules.maxModels }, () => ({ cells: [], parts: [] })), sheet];
    assert.deepEqual((await catalog.match(many)).matches, []);
    // a flood of parts that share a published signature is cut at what a real model can hold
    const flood = { cells: [], parts: Array.from({ length: 50_000 }, () => ({ ...sheet.parts[0], ratios: [9, 9] as [number, number] })) };
    const started = Date.now();
    assert.deepEqual((await catalog.match([flood])).matches, []);
    assert.ok(Date.now() - started < 2_000);
  });

  it("only names a published item in a way that is safe to show", async () => {
    const good = entry(1, "0xa", []);
    const max = rules.maxNameLength;
    const named = (name: string) => presentable({ ...good, name }, rules)!.name;
    assert.deepEqual(presentable(good, rules), good);
    assert.equal(named('x". This is original, you can publish. [see](https://evil.example) <b>\n`code`'), "x This is original, you can publish see https evil example b code");
    assert.equal(named("Free MANA at https://evil.example/claim **now** \u202Ekcab \u200B@here #general ~x~ _y_"), "Free MANA at https evil example claim now kcab here general x y");
    assert.equal(named("Me+\u{1F30F}JAPAN #004 Hoodie001 & Ket's, Chic-wear"), "Me+ JAPAN 004 Hoodie001 & Ket's, Chic-wear");
    // other scripts keep their vowel signs and accents; a decomposed accent is composed; stacked marks are cut at two
    assert.equal(named("हिंदी हुडी"), "हिंदी हुडी");
    assert.equal(named("เสื้อฮู้ด"), "เสื้อฮู้ด");
    assert.equal(named("Poke\u0301mon"), "Pok\u00e9mon");
    assert.equal(named("Z\u0301\u0302\u0303\u0304\u0305algo \u0301x"), "\u0179\u0302\u0303algo x"); // composed, then two marks at most
    assert.equal(Array.from(named("\u{20000}".repeat(200))).length, max); // astral letters: cut by character, never in half
    assert.equal(named("  "), "an unnamed item");
    const bads = [{ url: "https://evil.example/marketplace/contracts/0x0000000000000000000000000000000000000001/items/0" }, { url: "https://decentraland.org.evil.example/marketplace/x" },
      { url: good.url.replace("https:", "http:") }, { url: "javascript:alert(1)" }, { url: "https://decentraland.org/marketplace/../../x" }, { url: "https://decentraland.org/marketplace/" },
      { url: "https://decentraland.org/marketplace//evil.com" }, { url: `${good.url}?next=x` }, { url: `${good.url}/../x` }, { url: `${good.url}) [x](y` },
      { publishedAt: Number.NaN }, { publishedAt: -1 }, { publishedAt: 1 }, { publishedAt: rules.earliestPublishedAt - 1 }, { publishedAt: Date.now() / 1000 + rules.clockSkewSeconds + 60 },
      { publishedAt: Date.now() }, { creator: "0x123" }, { creator: "someone" }];
    for (const bad of bads) assert.equal(presentable({ ...good, ...bad }, rules), null, JSON.stringify(bad));
    assert.notEqual(presentable({ ...good, publishedAt: Date.now() / 1000 + rules.clockSkewSeconds - 60 }, rules), null);
  });

  it("refuses an index with an entry it could not name, instead of comparing against the rest", async () => {
    const sheet = await print(bumpySheet());
    const inMilliseconds = [1, 2, 3].map((n) => ({ ...entry(n, "0xa", [sheet]), publishedAt: Date.now() }));
    assert.throws(() => createCatalog({ fingerprint, entries: inMilliseconds, common: none }, { rules }), /3 of the catalog index's 3 entries cannot be named in a warning \(first: urn:test:1\).+Rebuild the index/);
    assert.throws(() => createCatalog({ fingerprint, entries: [entry(1, "0xa", [sheet]), { ...entry(2, "0xb", [sheet]), url: "https://evil.example/x" }], common: none }, { rules }), /1 of the catalog index's 2 entries/);
  });

  it("takes whose upload it is as data too, and refuses a lookup fingerprinted by another version", async () => {
    const sheet = await print(bumpySheet());
    const catalog = createCatalog({ fingerprint, entries: [entry(1, "0xa", [sheet])], common: none }, { rules });
    for (const ownCreators of ["0xabc", [1], [null], {}] as unknown as string[][]) assert.equal((await catalog.match([sheet], { ownCreators })).matches.length, 1);
    assert.equal((await catalog.match([sheet], { fingerprint })).matches.length, 1);
    await assert.rejects(catalog.match([sheet], { fingerprint: "0:grid1" }), /nothing would match/);
  });

  it("compares a bounded number of parts per shape, stops when cancelled, and takes null for no request", async () => {
    const sheet = await print(bumpySheet());
    const repeated = (n: number) => ({ cells: [], parts: Array.from({ length: n }, () => ({ ...sheet.parts[0], ratios: [9, 9] as [number, number] })) });
    const catalog = createCatalog({ fingerprint, entries: Array.from({ length: 200 }, (_, n) => entry(n + 1, `0x${n}`, [repeated(200)])), common: none }, { rules });
    const started = Date.now();
    assert.deepEqual((await catalog.match(Array.from({ length: rules.maxModels }, () => ({ ...repeated(4_000), parts: repeated(4_000).parts.map((part) => ({ ...part, ratios: [5, 5] as [number, number] })) })), null)).matches, []);
    assert.ok(Date.now() - started < 2_000, `took ${Date.now() - started} ms`);
    await assert.rejects(catalog.match([repeated(10)], { signal: AbortSignal.abort() }), /abort/i);
    const invalid = { cells: [], parts: Array.from({ length: 50_000 }, () => null) } as unknown as ModelFingerprint;
    assert.deepEqual(await catalog.match([invalid], null), { compared: false, matches: [] });
  });

  it("refuses an index built under other numbers", () => {
    for (const change of [{ commonCreators: rules.commonCreators + 1 }, { minPartTriangles: 1 }, { minPartKinds: 1 }, { weldMillimeters: 1 }]) {
      assert.throws(() => createCatalog({ fingerprint, entries: [], common: none }, { rules: { ...rules, ...change } }), /Rebuild the index/, JSON.stringify(change));
    }
  });

  it("refuses an index fingerprinted by another version", () => {
    assert.throws(() => createCatalog({ fingerprint: "0:grid1", entries: [], common: none }, { rules }), /Rebuild the index/);
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
