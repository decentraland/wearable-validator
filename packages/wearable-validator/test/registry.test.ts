import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { registry, checks, explanations, fixes, details, DOCS_LINKS } from "../src/registry.js";

const GROUP_ORDER = ["files", "model", "emote", "content", "rendering", "code"];

describe("the registry", () => {
  it("lists every check in group order, each once", () => {
    const names = registry.map((c) => c.name);
    assert.equal(new Set(names).size, names.length);
    const groups = registry.map((c) => GROUP_ORDER.indexOf(c.group));
    assert.deepEqual(groups, [...groups].sort((a, b) => a - b));
    assert.ok(groups.every((g) => g >= 0));
  });

  it("every check carries plain-language text that can stand on its own", () => {
    for (const check of registry) {
      assert.ok(check.explanation.length > 30, `${check.name} explanation too short to explain anything`);
      assert.ok(check.fix.length > 40, `${check.name} fix too short to be actionable`);
      assert.ok(check.details.length > 30, `${check.name} details too short to say how it checks`);
      assert.match(check.docs, /^https:\/\//, `${check.name} docs must be a link`);
      assert.match(check.rule, /^[A-Z]-\d\d$/, `${check.name} rule id`);
    }
  });

  it("derives the website surfaces from the definitions", () => {
    for (const check of registry) {
      assert.equal(explanations[check.name], check.explanation);
      assert.equal(fixes[check.name], check.fix);
      assert.equal(details[check.name], check.details);
      assert.equal(DOCS_LINKS[check.name], check.docs);
      assert.equal(checks[check.name], check);
    }
  });

  it("every check lives in its own folder src/checks/<group>/<name>/ with a colocated test", async () => {
    const root = join(import.meta.dirname, "..", "src", "checks");
    for (const check of registry) {
      const folder = join(root, check.group, check.name);
      const entries = await readdir(folder).catch(() => []);
      assert.ok(entries.includes("index.ts"), `${check.name}: missing ${folder}/index.ts`);
      assert.ok(entries.includes("index.test.ts"), `${check.name}: missing ${folder}/index.test.ts`);
    }
  });
});
