import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BodyShape } from "@dcl/schemas";
import { AVATAR_BONE_NAMES, manifest, validate } from "../../../index.js";
import { found, status } from "#test/helpers/findings.js";
import { syntheticGlb, syntheticZip, type SyntheticOptions } from "#test/helpers/synthetic.js";

const { headCoverLine, hand, longUpperBodyLine } = manifest.hides;
const minHandVertices = hand.minVertices;
const CHECK = { checks: ["hides-coverage"] };

// on the standing test skeleton the feet are at 0.08 m and the head bone at 1.6 m (a body of 1.52 m)
/** A cube spanning `from`–`to` of body height. */
const span = (from: number, to: number, options: SyntheticOptions = {}) =>
  syntheticGlb({ standing: true, scale: 1.52 * (to - from), offset: [0, 0.08 + 1.52 * from, 0], ...options });

const LEFT_HAND = AVATAR_BONE_NAMES.indexOf("Avatar_LeftHand");
const RIGHT_FINGER = AVATAR_BONE_NAMES.indexOf("Avatar_RightHandIndex2");
/** Exactly `perHand` vertices on each hand, the rest on the hips; `right: false` leaves the right hand's on the forearm. */
function gloves(perHand: number, right = true): Promise<Uint8Array> {
  const other = right ? RIGHT_FINGER : AVATAR_BONE_NAMES.indexOf("Avatar_RightForeArm");
  return syntheticGlb({ triangles: Math.ceil((perHand * 2) / 3), skinData: { jointsByVertex: (v) => [v < perHand ? LEFT_HAND : v < perHand * 2 ? other : 0, 0, 0, 0] } });
}

function item(category: string, hides: string[], glb: Uint8Array, representation: Record<string, unknown> = {}) {
  const representations = [{ bodyShapes: [BodyShape.MALE, BodyShape.FEMALE], mainFile: "model.glb", contents: ["model.glb"], ...representation }];
  return syntheticZip({ glb, manifest: { name: "Test", description: "synthetic", rarity: "common", data: { category, tags: [], hides, replaces: [], representations } } });
}

describe("hides-coverage (M-16)", () => {
  it("errors when a top-head item hides the head it sits above", async () => {
    const result = await validate(await item("top_head", ["head"], await span(headCoverLine + 0.06, headCoverLine + 0.5)), CHECK);
    const findings = found(result, "hides-coverage");
    assert.equal(status(result, "hides-coverage"), "failed");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "error");
    assert.equal(findings[0].where, "model.glb");
    assert.match(findings[0].message, /hides the head but does not cover it: its lowest point is at 106%/);
    assert.match(findings[0].message, /unselect Head/);
  });

  it("errors when an item that ends below the head hides the head", async () => {
    const result = await validate(await item("upper_body", ["head"], await span(0.5, headCoverLine - 0.1)), CHECK);
    assert.match(found(result, "hides-coverage")[0].message, /its highest point is at 90%/);
  });

  it("passes a helmet that hides the head and spans it", async () => {
    const result = await validate(await item("helmet", ["head", "hair"], await span(headCoverLine - 0.15, headCoverLine + 0.15)), CHECK);
    assert.equal(status(result, "hides-coverage"), "passed");
  });

  it("does not judge the head on a model with no head and feet bones to measure against", async () => {
    const result = await validate(await item("top_head", ["head"], await syntheticGlb()), CHECK);
    assert.equal(status(result, "hides-coverage"), "passed");
  });

  it("errors when a top hides the hands and models none", async () => {
    const result = await validate(await item("upper_body", ["hands"], await syntheticGlb()), CHECK);
    const findings = found(result, "hides-coverage");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "error");
    assert.match(findings[0].message, /hides the hands but models neither hand: .*left hand 0, right hand 0/);
    assert.equal(findings[0].limit, `≥ ${minHandVertices} per hand`);
  });

  it("names the hand a one-handed item leaves missing", async () => {
    const result = await validate(await item("hands_wear", ["hands"], await gloves(minHandVertices, false)), CHECK);
    const findings = found(result, "hides-coverage");
    assert.equal(findings.length, 1);
    assert.match(findings[0].message, /models no right hand/);
    assert.match(findings[0].message, /right arm ends at the wrist/);
  });

  it("passes gloves that hide the hands and model both, fingers included", async () => {
    const result = await validate(await item("hands_wear", ["hands"], await gloves(minHandVertices)), CHECK);
    assert.equal(status(result, "hides-coverage"), "passed");
  });

  it("counts a rigid piece at the hand even when it is skinned to the forearm", async () => {
    const forearm = AVATAR_BONE_NAMES.indexOf("Avatar_LeftForeArm");
    // on the standing skeleton the left wrist is at x 0.7 m and its knuckle at 0.78 m: the piece sits past the palm's middle
    const atTheHand = await syntheticGlb({ standing: true, scale: 0.06, offset: [0.76, 1.33, 0], skinData: { joints: [forearm, 0, 0, 0] } });
    const worn = found(await validate(await item("hands_wear", ["hands"], atTheHand), CHECK), "hides-coverage");
    assert.equal(worn.length, 1);
    assert.match(worn[0].message, /models no right hand/);
    const atTheElbow = await syntheticGlb({ standing: true, scale: 0.06, offset: [0.4, 1.33, 0], skinData: { joints: [forearm, 0, 0, 0] } });
    const cuff = found(await validate(await item("hands_wear", ["hands"], atTheElbow), CHECK), "hides-coverage");
    assert.match(cuff[0].message, /models neither hand/);
  });

  it("errors on gloves one vertex short per hand", async () => {
    const result = await validate(await item("hands_wear", ["hands"], await gloves(minHandVertices - 1)), CHECK);
    assert.equal(status(result, "hides-coverage"), "failed");
  });

  it("warns when an upper body reaches the lower legs without hiding the lower body", async () => {
    const dress = await span(longUpperBodyLine - 0.15, 0.85);
    const result = await validate(await item("upper_body", [], dress), CHECK);
    const findings = found(result, "hides-coverage");
    assert.equal(status(result, "hides-coverage"), "warning");
    assert.equal(findings.length, 1);
    assert.match(findings[0].message, /reaches down to 5% of body height .* does not hide the lower body/);
    const hidden = await validate(await item("upper_body", ["lower_body"], dress), CHECK);
    assert.equal(status(hidden, "hides-coverage"), "passed");
  });

  it("passes a top that stops above the lower legs, and a long item in another category", async () => {
    const top = await validate(await item("upper_body", [], await span(longUpperBodyLine + 0.05, 0.85)), CHECK);
    assert.equal(status(top, "hides-coverage"), "passed");
    const wings = await validate(await item("top_head", [], await span(0.05, 1.4)), CHECK);
    assert.equal(status(wings, "hides-coverage"), "passed");
  });

  it("reads a version's own overrideHides in place of the item's hides", async () => {
    const hat = await span(headCoverLine + 0.06, headCoverLine + 0.5);
    const overridden = await validate(await item("hat", [], hat, { overrideHides: ["head"] }), CHECK);
    assert.equal(status(overridden, "hides-coverage"), "failed");
    const replaced = await validate(await item("hat", ["head"], hat, { overrideHides: ["hair"] }), CHECK);
    assert.equal(status(replaced, "hides-coverage"), "passed");
  });

  it("reports what the item hides and where it sits", async () => {
    const result = await validate(await item("helmet", ["head"], await span(0.85, 1.15)), CHECK);
    assert.equal(result.checks[0].measured, "hides head · spans 85%–115% of body height");
  });

  it("is not applicable to skins, emotes or a bare model", async () => {
    const skin = await validate(await item("skin", [], await syntheticGlb()), CHECK);
    assert.equal(skin.checks.length, 0);
    const emote = await validate(await syntheticZip({ kind: "emote" }), CHECK);
    assert.equal(emote.checks.length, 0);
    const bare = await validate(await syntheticGlb(), { ...CHECK, category: "hat" });
    assert.equal(bare.checks.length, 0);
  });
});
