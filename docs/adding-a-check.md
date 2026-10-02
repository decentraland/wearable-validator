# Adding a check

> **Status.** Live. Every existing check follows this shape; `test/registry.test.ts` and `test/source-links.test.ts` fail the build when a step is skipped.

A check is one folder. Open `packages/wearable-validator/src/checks/files/category/` and you have seen the whole pattern: `index.ts` (the rule) and `index.test.ts` (its tests). Nothing about a check lives anywhere else except its numbers, which live in the manifest.

## 1. Pick the group and the name

| Group | Rule-book phase | Folder |
| --- | --- | --- |
| `files` | P1 structure & metadata (`S-xx`) | `src/checks/files/` |
| `model` | P2 wearable model (`M-xx`) | `src/checks/model/` |
| `emote` | P3 emote animation (`E-xx`) | `src/checks/emote/` |
| `content` | P5 content policy (`F-xx`) | `src/checks/content/` |
| `rendering` | P4 visual QA (`V-xx`) | `src/checks/rendering/` |

The name is the API: readable kebab-case that says what is checked (`triangle-count`, `loop-seam`), never the rule ID. The rule ID is metadata; get it from the rule book.

## 2. Put the numbers in the manifest

Every limit, threshold, tolerance or list the check compares against goes in `src/manifest/manifest.json`, under a block named after the topic, and is declared in the `Manifest` interface in `src/manifest/index.ts`. Code keeps only structural constants (magic bytes, file-name conventions) with a one-line why-comment. Changing a number is a governance act: bump `version` in the manifest.

## 3. Write `index.ts`

```ts
/** M-15 Rule title — one line on why the rule exists. */
import { finding, type CheckDefinition, type CheckMeta, type Finding } from "../../../types.js";
import { WEARABLES } from "../../docs.js";

const meta: CheckMeta = { name: "my-check", group: "model", rule: "M-15", docs: `${WEARABLES}#the-exact-section` };

export const myCheck: CheckDefinition = {
  ...meta,
  title: "Rule title",
  describe: "one line: what it verifies (docs pages generate from this)",
  explanation: "Plain words for creators: what the rule is and why it exists.",
  fix: "Concrete steps: tool, menu path, number. Long enough to act on.",
  details: "How it measures: what is read from the file and what it is compared against.",
  categoryDependent: true,             // only if the limit depends on the category
  appliesTo: (ctx) => ctx.itemType === "wearable" ? true : "wearable-only rule — this item is an emote",
  measure: (ctx) => "1,240 tris",      // what the item measures, shown next to the status
  run: (ctx) => {
    const { limit } = ctx.manifest.myTopic;
    const findings: Finding[] = [];
    for (const model of ctx.models) {
      const measured = 0; // the algorithm
      if (measured > limit) {
        findings.push(finding(meta, "error",
          `"${model.mainFile}" has ${measured} things — the limit is ${limit}. Do this to fix it.`,
          { where: model.mainFile, measured, limit }));
      }
    }
    return findings;
  }
};
```

What each part must do:

- **The header comment** states the rule ID and why the rule exists. That is the only narration the file gets.
- **`meta`** is the identity every finding carries. `docs` is the creator-docs page with the exact section anchor; the base URLs are in `src/checks/docs.ts`.
- **`explanation`, `fix`, `details`** are shown on the website and the CLI. The registry test rejects short or missing text.
- **`appliesTo`** returns a reason string when the check does not apply; the check is then absent from results, not skipped.
- **`measure`** is display only and must never throw for a valid item.
- **Findings** say what is wrong, where, the measured value and the limit, and how to fix it, all in one sentence a creator can act on. Report every problem; never stop at the first.
- **Shared algorithms** used by more than one check go to `src/logic/<topic>.ts`. Helpers used by one check stay in its `index.ts`.

## 4. Register it

Add one import and one array entry to the group's `index.ts` in rule-book order. Registry order is execution and reporting order. That is the only edit outside the folder.

## 5. Write `index.test.ts`

Tests sit next to the check and drive it through `validate()` with in-memory fixtures. There are no binary fixtures in the repo.

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validate, manifest } from "../../../index.js";
import { found, status } from "#test/helpers/findings.js";
import { syntheticGlb, syntheticZip } from "#test/helpers/synthetic.js";

describe("my-check (M-15)", () => {
  it("errors above the limit", async () => {
    const glb = await syntheticGlb({ triangles: manifest.myTopic.limit + 1 });
    const result = await validate(await syntheticZip({ glb }), { checks: ["my-check"] });
    assert.equal(status(result, "my-check"), "failed");
    assert.match(found(result, "my-check")[0].message, /the limit is/);
  });

  it("passes a compliant item", async () => {
    const result = await validate(await syntheticZip(), { checks: ["my-check"] });
    assert.equal(status(result, "my-check"), "passed");
  });

  it("is not applicable to emotes", async () => {
    const result = await validate(await syntheticZip({ kind: "emote" }), { checks: ["my-check"] });
    assert.equal(result.checks.length, 0);
  });
});
```

Assert against `manifest.*`, never against a literal copy of the number. `syntheticGlb` builds a valid wearable or emote; every failing shape is one option away (see `SyntheticOptions` in `test/helpers/synthetic.ts`). Add an option there when a new failing shape is needed.

## 6. Generate and verify

```sh
cd packages/wearable-validator
npm run gen:sources     # rewrites src/source-links.json (check → file:line on GitHub)
npm test                # your folder's tests plus the registry and source-link suites
npm run typecheck
npx tsx src/cli.ts checks | grep my-check
```

## 7. Optional surfaces

- **Samples**: `npm run samples` (repo root) regenerates the website's example zips if the check needs a new example.
- **Catalyst regression**: `npm run catalyst -- --wearables 15 --emotes 10` (repo root) runs published items; a new rule that fails many committee-approved items is a warning candidate, not an error.

## Visual checks (`rendering` group)

Same folder and same definition, plus:

- `prompt: { version, system, instructions, schema }` on the definition when the check asks the vision model. A test pins the prompt digest; any text change bumps `manifest.<checkName>.promptVersion`.
- A flat manifest block named after the check (`thumbnailHonesty`) holding the capture recipe (views, azimuths, fractions, caps) and prompt version.
- Captures come from `resolveCaptures()` in `src/logic/captures.ts`; the check never talks to a browser or a model directly. Missing renderer or reviewer returns a `skipped` execution with the reason; an inconclusive or malformed answer returns `errored`. Neither is a pass.
- `docs/visual-validation.md` explains the renderer, the reviewer and the run folder every review writes.
