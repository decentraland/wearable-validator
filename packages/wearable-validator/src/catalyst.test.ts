import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { catalystFor, DEFAULT_CATALYST, fetchCatalystItem, parseItemReference, TESTNET_CATALYST } from "./catalyst.js";
import { catalystFetch, syntheticEntity } from "#test/helpers/entity.js";
import { syntheticZip } from "#test/helpers/synthetic.js";

const CONTRACT = "0x" + "ab".repeat(20);
const MATIC = `urn:decentraland:matic:collections-v2:${CONTRACT}:12`;
const ETHEREUM = `urn:decentraland:ethereum:collections-v2:${CONTRACT}:12`;
const AMOY = `urn:decentraland:amoy:collections-v2:${CONTRACT}:12`;

describe("parseItemReference", () => {
  it("takes a URN as it is, lower-cased and trimmed", () => {
    assert.deepEqual(parseItemReference(`  ${MATIC.toUpperCase()} `), [MATIC]);
    assert.deepEqual(parseItemReference("urn:decentraland:off-chain:base-avatars:BaseMale"), null, "only collection items are published entities");
  });

  it("turns a shop item URL or a marketplace contracts URL into the matic candidate, then the ethereum one", () => {
    const expected = [MATIC, ETHEREUM];
    assert.deepEqual(parseItemReference(`https://decentraland.org/shop/item/${CONTRACT}/12`), expected);
    assert.deepEqual(parseItemReference(`https://decentraland.org/shop/item/${CONTRACT.toUpperCase().replace("0X", "0x")}/12?utm=x`), expected);
    assert.deepEqual(parseItemReference(`https://market.decentraland.org/marketplace/contracts/${CONTRACT}/items/12`), expected);
  });

  it("turns a decentraland.zone shop URL into the amoy candidate", () => {
    assert.deepEqual(parseItemReference(`https://decentraland.zone/shop/item/${CONTRACT}/12`), [AMOY]);
    assert.deepEqual(parseItemReference(`https://market.decentraland.zone/marketplace/contracts/${CONTRACT}/items/12`), [AMOY]);
    assert.deepEqual(parseItemReference(AMOY), [AMOY]);
  });

  it("refuses a token page with a hint, and answers null for anything else", () => {
    assert.throws(() => parseItemReference(`https://decentraland.org/marketplace/contracts/${CONTRACT}/tokens/5`), /shop page instead/);
    assert.equal(parseItemReference("not a reference"), null);
    assert.equal(parseItemReference(""), null);
    assert.equal(parseItemReference("https://decentraland.org/shop/item/0x123/1"), null, "a contract address is 40 hex digits");
    assert.equal(parseItemReference("/home/me/tokens/shirt.zip"), null, "a local path is never a token page");
    assert.equal(parseItemReference("C:/Users/me/Downloads/tokens/shirt.zip"), null);
  });
});

describe("fetchCatalystItem", () => {
  it("resolves the first candidate the catalyst knows, downloads every file under the peer and reports progress per file", async () => {
    const entity = await syntheticEntity(await syntheticZip(), ETHEREUM);
    const fetch = catalystFetch([entity]);
    const progress: { text: string; done?: number; total?: number }[] = [];
    const item = await fetchCatalystItem([MATIC, ETHEREUM], { peer: "https://peer.example/", fetch, onProgress: (event) => progress.push(event) });
    assert.equal(item.urn, ETHEREUM);
    assert.equal(item.id, entity.id);
    assert.equal(item.name, "Test Wearable");
    assert.deepEqual([...item.files.keys()].sort(), ["image.png", "model.glb", "thumbnail.png"]);
    assert.deepEqual(item.files.get("model.glb"), entity.files.get("model.glb"));
    assert.deepEqual(item.content, entity.content);
    assert.deepEqual(item.metadata, entity.metadata);
    const lookups = fetch.calls.filter((call) => call.url.endsWith("/content/entities/active"));
    assert.deepEqual(lookups.map((call) => JSON.parse(call.body!)), [{ pointers: [MATIC] }, { pointers: [ETHEREUM] }], "one pointer per lookup, in candidate order");
    assert.ok(fetch.calls.every((call) => call.url.startsWith("https://peer.example/content/")), "the trailing slash of the peer is trimmed");
    assert.deepEqual(progress[0], { text: "Looking up the item on the catalyst" });
    assert.deepEqual(progress.slice(1).map((event) => [event.done, event.total]), [[0, 3], [1, 3], [2, 3], [3, 3]]);
  });

  it("refuses a published file name that points outside the item", async () => {
    const entity = await syntheticEntity(await syntheticZip(), MATIC);
    const [first] = entity.content;
    entity.content[0] = { file: "../../../../app/packages/server/render-server-user.sh", hash: first.hash };
    entity.files.set(entity.content[0].file, entity.files.get(first.file)!);
    await assert.rejects(fetchCatalystItem([MATIC], { fetch: catalystFetch([entity]) }), /not a file inside the item/);
  });

  it("names the item after its URN when the metadata has no name", async () => {
    const entity = await syntheticEntity(await syntheticZip(), MATIC, { name: "" });
    const item = await fetchCatalystItem([MATIC], { fetch: catalystFetch([entity]) });
    assert.equal(item.name, MATIC);
  });

  it("says when no candidate is published, and when the catalyst is down", async () => {
    await assert.rejects(fetchCatalystItem([MATIC, ETHEREUM], { fetch: catalystFetch([]) }), /No published item found for that reference/);
    await assert.rejects(fetchCatalystItem([MATIC], { fetch: catalystFetch([], { status: 503 }) }), /The catalyst answered 503 — try again in a moment\./);
  });

  it("refuses an item with more files than the limit before downloading anything", async () => {
    const entity = await syntheticEntity(await syntheticZip(), MATIC);
    const fetch = catalystFetch([entity]);
    await assert.rejects(fetchCatalystItem([MATIC], { fetch, maxFiles: 1 }), /The item has 3 files — the maximum is 1\./);
    assert.equal(fetch.calls.filter((call) => call.url.includes("/content/contents/")).length, 0);
  });

  it("stops at the byte limit from the declared content-length, and from the bytes themselves when the header lies", async () => {
    const entity = await syntheticEntity(await syntheticZip(), MATIC);
    const total = [...entity.files.values()].reduce((sum, bytes) => sum + bytes.byteLength, 0);
    // the header alone trips the limit: the bytes themselves are far under it, so only the content-length branch can fail
    const inflated = catalystFetch([entity], { contentLength: () => String(total * 100) });
    await assert.rejects(fetchCatalystItem([MATIC], { fetch: inflated, maxBytes: total * 10 }), /exceed the 0 MB input limit/, "the declared size alone trips the limit");
    const lying = catalystFetch([entity], { contentLength: () => "1" });
    await assert.rejects(fetchCatalystItem([MATIC], { fetch: lying, maxBytes: total - 1 }), /exceed the 0 MB input limit/);
    const honest = catalystFetch([entity], { contentLength: () => undefined });
    const item = await fetchCatalystItem([MATIC], { fetch: honest, maxBytes: total });
    assert.equal(item.files.size, 3, "exactly the limit passes");
  });

  it("refuses a content entry whose hash could not be a path segment, and reports a file the catalyst no longer serves", async () => {
    const entity = await syntheticEntity(await syntheticZip(), MATIC);
    const hostile = { ...entity, content: [...entity.content, { file: "extra.bin", hash: "../../etc/passwd" }] };
    await assert.rejects(fetchCatalystItem([MATIC], { fetch: catalystFetch([hostile]) }), /listed a file without a usable hash/);
    const gone = { ...entity, content: [...entity.content, { file: "extra.bin", hash: "bafymissing" }] };
    await assert.rejects(fetchCatalystItem([MATIC], { fetch: catalystFetch([gone]) }), /The catalyst answered 404 for "extra\.bin"\./);
  });

  it("stops every download once one fails: nothing is counted or reported after the rejection, and the queue is left alone", async () => {
    const entity = await syntheticEntity(await syntheticZip(), MATIC);
    const [first] = entity.content;
    // more files than workers: the missing one sits among the first batch, the extras behind it wait in the queue
    const extras = Array.from({ length: 8 }, (_, i) => ({ file: `extra${i}.bin`, hash: first.hash }));
    const files = new Map(entity.files);
    for (const extra of extras) files.set(extra.file, entity.files.get(first.file)!);
    const hostile = { ...entity, files, content: [...entity.content, { file: "missing.bin", hash: "bafymissing" }, ...extras] };
    const fetch = catalystFetch([hostile]);
    const progress: { done?: number }[] = [];
    await assert.rejects(fetchCatalystItem([MATIC], { fetch, onProgress: (event) => progress.push(event) }), /The catalyst answered 404 for "missing\.bin"\./);
    const reported = progress.length;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(progress.length, reported, "no progress lands after the caller was told");
    assert.ok(progress.every((event) => (event.done ?? 0) === 0), "a worker that held its bytes when another failed counts nothing");
    assert.equal(fetch.calls.filter((call) => call.url.includes("/content/contents/")).length, 6, "the files still queued are never fetched");
  });

  it("follows the caller's signal into every request", async () => {
    const entity = await syntheticEntity(await syntheticZip(), MATIC);
    const seen: (AbortSignal | null | undefined)[] = [];
    const inner = catalystFetch([entity]);
    const fetch: typeof globalThis.fetch = (input, init) => {
      seen.push(init?.signal);
      return inner(input, init);
    };
    const controller = new AbortController();
    await fetchCatalystItem([MATIC], { fetch, signal: controller.signal });
    assert.equal(seen.length, 4);
    assert.ok(seen.every((signal) => signal instanceof AbortSignal && !signal.aborted));
    controller.abort();
    assert.ok(seen.every((signal) => signal?.aborted), "the internal signal trips with the caller's");
  });

  it("asks the .zone catalyst for amoy items and the .org one for mainnet, unless a peer is named", async () => {
    assert.equal(catalystFor(AMOY), TESTNET_CATALYST);
    assert.equal(catalystFor(MATIC), DEFAULT_CATALYST);
    assert.equal(catalystFor(ETHEREUM), DEFAULT_CATALYST);
    const entity = await syntheticEntity(await syntheticZip(), AMOY);
    const fetch = catalystFetch([entity]);
    const item = await fetchCatalystItem([AMOY], { fetch });
    assert.equal(item.urn, AMOY);
    assert.ok(fetch.calls.every((call) => call.url.startsWith(`${TESTNET_CATALYST}/content/`)), "lookups and downloads go to the .zone catalyst");
    const named = catalystFetch([entity]);
    await fetchCatalystItem([AMOY], { peer: "https://peer.example", fetch: named });
    assert.ok(named.calls.every((call) => call.url.startsWith("https://peer.example/content/")), "a named peer wins");
  });

  it("rejects an entity without a content list", async () => {
    const entity = await syntheticEntity(await syntheticZip(), MATIC);
    const broken = { ...entity, content: undefined as unknown as { file: string; hash: string }[] };
    await assert.rejects(fetchCatalystItem([MATIC], { fetch: catalystFetch([broken]) }), /without an id or a content list/);
  });
});
