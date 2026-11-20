import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { manifest } from "../../../index.js";
import { of, runChecks } from "#test/helpers/emote.js";

describe("root-motion (E-05)", () => {
  it("warns between the documented radius and the hard limit (curators: 1 m, with leeway when the motion has a reason)", async () => {
    // like The Re-Animator / Reanimated!: starts at the centre, gets 1.48 m away
    const result = await runChecks(
      { animations: [{ name: "Walk_Avatar", seconds: 2, values: [0, 0, 0, 1.48, 0, 0, 0, 0, 0] }] },
      ["root-motion"]
    );
    const findings = of(result, "root-motion");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "warning");
    assert.equal(findings[0].measured, 1.48);
    assert.equal(findings[0].limit, manifest.emote.rootMotion.horizontalWarnMeters);
  });

  it("measures from the centre of the animation area, not from the first key", async () => {
    // crossing the cylinder side to side travels 1.8 m but never leaves it
    const inside = await runChecks(
      { animations: [{ name: "Cross_Avatar", seconds: 2, values: [-0.9, 0, 0, 0, 0, 0, 0.9, 0, 0] }] },
      ["root-motion"]
    );
    assert.equal(of(inside, "root-motion").length, 0);
    // starting outside the cylinder counts even if the avatar barely moves afterwards
    const startsOutside = await runChecks(
      { animations: [{ name: "Offset_Avatar", seconds: 2, values: [2, 0, 0, 2.1, 0, 0, 2, 0, 0] }] },
      ["root-motion"]
    );
    const errors = of(startsOutside, "root-motion").filter((f) => f.severity === "error");
    assert.equal(errors.length, 1);
    assert.equal(errors[0].measured, 2.1);
  });

  it("counts an armature that sits away from the origin", async () => {
    // real rigs carry the offset on the Armature node, not in the hips keys: the hips never move, but they are 2 m out
    const result = await runChecks(
      { armatureTranslation: [2, 0, 0], animations: [{ name: "Idle_Avatar", seconds: 2, values: [0, 0, 0, 0, 0, 0, 0, 0, 0] }] },
      ["root-motion"]
    );
    const errors = of(result, "root-motion").filter((f) => f.severity === "error");
    assert.equal(errors.length, 1);
    assert.equal(errors[0].measured, 2);
  });

  it("errors when the hips travel too far horizontally", async () => {
    const result = await runChecks(
      { animations: [{ name: "Run_Avatar", seconds: 2, values: [0, 0, 0, 2, 0, 0, 0, 0, 0] }] },
      ["root-motion"]
    );
    const errors = of(result, "root-motion").filter((f) => f.severity === "error");
    assert.equal(errors.length, 1);
    assert.equal(errors[0].measured, 2);
    assert.equal(errors[0].limit, manifest.emote.rootMotion.horizontalErrorMeters);
  });

  it("warns between the vertical warn and error thresholds", async () => {
    const result = await runChecks(
      { animations: [{ name: "Jump_Avatar", seconds: 2, values: [0, 0, 0, 0, 2, 0, 0, 0, 0] }] },
      ["root-motion"]
    );
    const findings = of(result, "root-motion");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "warning");
  });

  it("errors above the vertical hard limit", async () => {
    const result = await runChecks(
      { animations: [{ name: "Fly_Avatar", seconds: 2, values: [0, 0, 0, 0, 5, 0, 0, 0, 0] }] },
      ["root-motion"]
    );
    const findings = of(result, "root-motion");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "error");
  });

  it("passes small hip motion", async () => {
    const result = await runChecks({ animation: { name: "Wave_Avatar", seconds: 2 } }, ["root-motion"]);
    assert.equal(of(result, "root-motion").length, 0);
  });
});
