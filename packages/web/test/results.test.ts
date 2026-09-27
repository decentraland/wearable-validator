import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CheckResult, Finding, Result } from "@dcl-regenesislabs/wearable-validator";
import type { WireResult } from "../src/api.js";
import { EMPTY_VISUAL, reduceVisual, type VisualEvent, type VisualState } from "../src/progress.js";
import { Results } from "../src/results.js";
import { statusLabel } from "../src/rules.js";

/** The results page rendered once, without a browser: what History says about a run's code checks at each phase. */

const row = (check: string, group: CheckResult["group"], status: CheckResult["status"] = "passed"): CheckResult => ({ check, group, status, coverage: "complete" });
const gate: Result = { passed: true, checks: [row("file-format", "files")], findings: [], captures: [], summary: { errors: 0, warnings: 0, checked: 1, skipped: 0 } };
const NOT_SAVED = "Code checks were not saved for this run.";

function page(visual: VisualState, result: Result | null): string {
  return renderToStaticMarkup(createElement(Results, { scope: "t", result, visual, aiChecks: [], modelKnown: false, filter: "all", onFilter: () => undefined, visualShown: true }));
}
const stateOf = (events: VisualEvent[]): VisualState => events.reduce(reduceVisual, { ...EMPTY_VISUAL, id: "h" });

describe("results page", () => {
  it("says the code checks are running, not unsaved, while a live run is before its gate", () => {
    for (const events of [[{ type: "upload-started", reference: true } as VisualEvent], [{ type: "upload-started" } as VisualEvent, { type: "upload-finished", id: "h" } as VisualEvent]]) {
      const html = page(stateOf(events), null);
      assert.match(html, /code checks running/);
      assert.doesNotMatch(html, /not saved/);
    }
  });

  it("says the code checks were not saved only for a finished run, once", () => {
    const visual: WireResult = { ...gate, checks: [row("render-valid", "rendering")], captures: [] };
    const html = page(stateOf([{ type: "done", data: { result: visual } }]), null);
    assert.equal(html.split(NOT_SAVED).length - 1, 1);
    assert.doesNotMatch(html, /code checks not saved|code checks did not run/);
  });

  it("does not call the code checks unsaved on a run that failed or was cancelled before its gate", () => {
    const failed = page(stateOf([{ type: "upload-started", reference: true }, { type: "error", data: { message: "No published item found for that reference." } }]), null);
    assert.doesNotMatch(failed, /not saved/);
    assert.match(failed, /code checks did not run/);
    const cancelled = page(stateOf([{ type: "upload-started" }, { type: "cancel-requested" }, { type: "error", data: { message: "Cancelled." } }]), null);
    assert.doesNotMatch(cancelled, /not saved/);
    assert.match(cancelled, /code checks did not run/);
  });

  it("counts the saved gate's checks and never mentions unsaved checks when the gate is there", () => {
    const html = page(stateOf([{ type: "done", data: { gate } }]), gate);
    assert.match(html, /of \d+ code checks apply/);
    assert.doesNotMatch(html, /not saved|did not run|running/);
  });
});

describe("statusLabel", () => {
  const finding = (severity: "error" | "warning"): Finding => ({ check: "texture-size", group: "model", severity, message: "", rule: "M-03", docs: "" });
  it("counts a failing rule's errors and a reviewed rule's warnings, so the list adds up to the verdict", () => {
    assert.equal(statusLabel("failed", Array.from({ length: 8 }, () => finding("error"))), "8 errors");
    assert.equal(statusLabel("failed", [finding("error")]), "1 error");
    assert.equal(statusLabel("warning", [finding("warning")]), "1 warning");
    assert.equal(statusLabel("passed", []), "Passed");
    assert.equal(statusLabel("skipped", []), "Not checked");
  });
});
