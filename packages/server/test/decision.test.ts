import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { CheckResult, Finding, Result } from "@dcl-regenesislabs/wearable-validator";
import { curatorDecision } from "../src/logic/decision.js";

function row(check: string, status: CheckResult["status"], extra: Partial<CheckResult> = {}): CheckResult {
  return { check, group: "rendering", status, coverage: "complete", ...extra };
}

function finding(check: string, severity: Finding["severity"], message: string): Finding {
  return { check, group: "model", severity, message, rule: "M-01", docs: "https://docs.example/#x" };
}

/** A Result whose summary matches its rows and findings, the way validate() builds one. */
function result(checks: CheckResult[], findings: Finding[] = [], passed: boolean | null = null): Result {
  const errors = findings.filter((entry) => entry.severity === "error").length;
  const warnings = findings.filter((entry) => entry.severity === "warning").length;
  return { passed, checks, findings, captures: [], summary: { errors, warnings, checked: checks.length, skipped: checks.filter((entry) => entry.status === "skipped").length } };
}

const asked = { review: { provider: "anthropic", model: "m", promptVersion: 1, promptDigest: "d" } };
const cleanGate = result([row("triangle-count", "passed")], [], true);
const cleanVisual = result([row("render-valid", "passed"), row("thumbnail-honesty", "passed", asked), row("visual-quality", "passed", asked)]);

describe("curatorDecision", () => {
  it("is ready only when every row passed, nothing warned and the model answered every visual row", () => {
    assert.deepEqual(curatorDecision({ gate: cleanGate, visual: cleanVisual, passed: true }), { state: "ready", reasons: [] });
  });

  it("asks for a curator on a warning, counting the gate's and the visual ones together", () => {
    const gate = result([row("metadata", "warning")], [finding("metadata", "warning", "Tag is odd.")], true);
    const visual = result([row("thumbnail-honesty", "warning", asked)], [finding("thumbnail-honesty", "warning", "Different hat.")]);
    assert.deepEqual(curatorDecision({ gate, visual, passed: true }), { state: "review", reasons: ["2 warnings"] });
    assert.deepEqual(curatorDecision({ gate: cleanGate, visual, passed: true }).reasons, ["1 warning"]);
  });

  it("asks for a curator when a visual row was not reviewed, repeating the row's own reason", () => {
    const skipped = result([row("render-valid", "passed"), row("thumbnail-honesty", "skipped", { skipReason: "Configure services.reviewer to run this review." })]);
    assert.deepEqual(curatorDecision({ gate: cleanGate, visual: skipped, passed: null }), { state: "review", reasons: ["thumbnail-honesty: Configure services.reviewer to run this review."] });
    // the /ai adapter stamps its provider on a refused call too: the reason, not the provider, says what happened
    const refused = result([row("visual-quality", "errored", { skipReason: "Cannot read the OAuth session. Check the credential store and try again.", ...asked })]);
    assert.deepEqual(curatorDecision({ gate: cleanGate, visual: refused, passed: null }).reasons, ["visual-quality: Cannot read the OAuth session. Check the credential store a…"]);
    const inconclusive = result([row("visual-quality", "errored", { skipReason: "The frames are too dark to judge.", ...asked })]);
    assert.deepEqual(curatorDecision({ gate: cleanGate, visual: inconclusive, passed: null }).reasons, ["visual-quality: The frames are too dark to judge."]);
    assert.deepEqual(curatorDecision({ gate: cleanGate, visual: result([row("thumbnail-honesty", "skipped")]), passed: null }).reasons, ["thumbnail-honesty was not reviewed"]);
  });

  it("asks for a curator on a run without a verdict, even when nothing else stands out", () => {
    assert.deepEqual(curatorDecision({ gate: result([row("triangle-count", "passed")]), visual: cleanVisual, passed: null }), { state: "review", reasons: ["no verdict"] });
    assert.deepEqual(curatorDecision({ gate: result([row("triangle-count", "passed")]), passed: null }), { state: "review", reasons: ["the visual review did not run"] });
  });

  it("blocks on code errors, naming each failing check with what is wrong, whatever the visual review said", () => {
    const gate = result([row("triangle-count", "failed")], [finding("triangle-count", "error", "Too many — reduce them."), finding("texture-size", "error", "Too big."), finding("texture-size", "error", "Also big."), finding("metadata", "warning", "Odd.")], false);
    const reasons = ["triangle-count: Too many", "texture-size: Too big. (+1 more)"];
    assert.deepEqual(curatorDecision({ gate, passed: false }), { state: "blocked", reasons });
    assert.deepEqual(curatorDecision({ gate, visual: cleanVisual, passed: false }), { state: "blocked", reasons });
    const many = result([], ["a", "b", "c", "d", "e"].map((check) => finding(check, "error", `${check} is off.`)), false);
    assert.deepEqual(curatorDecision({ gate: many, passed: false }).reasons, ["a: a is off.", "b: b is off.", "c: c is off.", "+2 more failing checks"]);
  });

  it("names a code error both body shapes repeat once, with the shapes", () => {
    const at = (shape: string) => ({ ...finding("texture-size", "error", `"${shape}/a.glb" › Hat is 1024×1024; the limit is 512×512. Resize it.`), where: `"${shape}/a.glb" › Hat` });
    const gate = result([], [at("male"), at("female")], false);
    assert.deepEqual(curatorDecision({ gate, passed: false }).reasons, ['texture-size: "a.glb" › Hat is 1024×1024; the limit is 512×512. Resize it. (male, female)']);
  });

  it("blocks on a failed visual row, naming what it measured", () => {
    const visual = result([row("render-valid", "failed", { measured: "12 views · 0.1% drawn at least" }), row("thumbnail-honesty", "warning", asked)], [finding("render-valid", "error", "Nothing visible."), finding("thumbnail-honesty", "warning", "Different.")]);
    assert.deepEqual(curatorDecision({ gate: cleanGate, visual, passed: false }), { state: "blocked", reasons: ["render-valid: 12 views · 0.1% drawn at least"] });
    const bare = result([row("render-valid", "failed")], [finding("render-valid", "error", "The item renders as nothing visible on both body shapes; check the mesh and its materials.")]);
    assert.deepEqual(curatorDecision({ gate: cleanGate, visual: bare, passed: false }).reasons, ["render-valid: The item renders as nothing visible on both body shapes; ch…"]);
    assert.deepEqual(curatorDecision({ gate: cleanGate, visual: result([row("render-valid", "failed")]), passed: false }).reasons, ["render-valid failed"]);
  });

  it("blocks a run that failed, before anything else is weighed", () => {
    assert.deepEqual(curatorDecision({ gate: cleanGate, visual: cleanVisual, passed: null, error: "The browser crashed." }), { state: "blocked", reasons: ["the run failed"] });
  });
});
