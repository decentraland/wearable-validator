/**
 * The rule book as one ordered list. Registry order IS execution and reporting order —
 * stable across runs (files → model → emote → content → rendering → code; within a group, rule-book table order).
 * Every creator-facing surface (explanations, fixes, details, docs links) is derived from the
 * definitions here, so nothing can drift from the check that runs.
 */
import type { CheckDefinition } from "./types.js";
import { filesChecks } from "./checks/files/index.js";
import { modelChecks } from "./checks/model/index.js";
import { emoteChecks } from "./checks/emote/index.js";
import { contentChecks } from "./checks/content/index.js";
import { renderingChecks } from "./checks/rendering/index.js";
import { codeChecks } from "./checks/code/index.js";

export const registry: CheckDefinition[] = [
  ...filesChecks,
  ...modelChecks,
  ...emoteChecks,
  ...contentChecks,
  ...renderingChecks,
  ...codeChecks
];

const byName = new Map(registry.map((c) => [c.name, c]));
const byRule = new Map(registry.map((c) => [c.rule.toLowerCase(), c]));

/** Resolve a check name or a rule-book ID alias ('M-01') to its definition. */
export function resolveCheck(nameOrRule: string): CheckDefinition | undefined {
  return byName.get(nameOrRule) ?? byRule.get(nameOrRule.toLowerCase());
}

export const checks: Record<string, CheckDefinition> = Object.fromEntries(byName);

const surface = (field: "explanation" | "fix" | "details" | "docs"): Record<string, string> =>
  Object.fromEntries(registry.map((c) => [c.name, c[field]]));

/** Plain-language explanation per check name. */
export const explanations = surface("explanation");
/** Concrete fix guidance per check name. */
export const fixes = surface("fix");
/** How each check measures, per check name. */
export const details = surface("details");
/** Creator-docs link per check name. */
export const DOCS_LINKS = surface("docs");

export const DOCS_BASE = "https://dcl-regenesislabs.github.io/wearable-validator/checks";
/** Live creator-docs page per check until the generated per-check site deploys. */
export const docsUrl = (check: string): string => DOCS_LINKS[check] ?? `${DOCS_BASE}/${check}`;
