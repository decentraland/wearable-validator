import { loadInput } from "./loader.js";
import { registry, resolveCheck } from "./registry.js";
import type { CheckContext, CheckDefinition, CheckExecution, CheckResult, Finding, Group, Input, Options, Result } from "./types.js";

const CORE_GROUPS: Group[] = ["files", "model", "emote", "content"];

export async function validate(input: Input, options: Options = {}): Promise<Result> {
  validateOptions(options);
  options.signal?.throwIfAborted();

  const loaded = await loadInput(input, options);
  if (loaded.fatal) {
    return {
      passed: options.checks?.length || options.groups ? null : false,
      checks: [{ check: "file-format", group: "files", status: "failed", coverage: "complete" }],
      findings: loaded.fatal,
      captures: [],
      summary: { errors: loaded.fatal.length, warnings: 0, checked: 1, skipped: 0 }
    };
  }
  const ctx = loaded.ctx!;
  ctx.services = options.services;
  ctx.signal = options.signal;
  ctx.captures = options.captures ? structuredClone(options.captures) : [];

  const selected = selectChecks(options);
  ctx.renderingRules = selected.filter((check) => check.group === "rendering").length;
  if (ctx.renderingRules > 0) {
    // adapters receive a copy — a renderer must never be able to mutate the bytes the code checks judged
    ctx.files = new Map([...ctx.files].map(([path, bytes]) => [path, bytes.slice()]));
    ctx.item = structuredClone(ctx.item);
  }
  const findings: Finding[] = [];
  const checkResults: CheckResult[] = [];
  let skipped = 0;

  for (const check of selected) {
    options.signal?.throwIfAborted();
    const started = Date.now();
    const applicable = check.appliesTo ? check.appliesTo(ctx) : true;
    if (applicable !== true) continue; // inapplicable checks are ABSENT, not skipped

    if (check.categoryDependent && !ctx.category) {
      const finding: Finding = {
        check: check.name,
        group: check.group,
        severity: "warning",
        message: `Can't verify ${check.title.toLowerCase()} — the category is unknown and its limits depend on it. Pass --category (or metadata) to check exactly.`,
        data: { reason: "category-unknown" },
        rule: check.rule,
        docs: check.docs
      };
      findings.push(finding);
      checkResults.push({ check: check.name, group: check.group, status: "warning", coverage: "missing", durationMs: Date.now() - started });
      continue;
    }

    if (ctx.parseError && needsParsedModel(check) && ctx.models.length === 0) {
      checkResults.push({ check: check.name, group: check.group, status: "skipped", coverage: "missing", skipReason: ctx.parseError });
      skipped++;
      continue;
    }

    options.onProgress?.({ type: "check-started", check: check.name, group: check.group });
    try {
      const execution = normalizeExecution(await check.run(ctx), check);
      findings.push(...execution.findings);
      let measured: string | undefined;
      try {
        measured = check.measure?.(ctx);
      } catch {
        // display-only — a measurement failure must never affect the run
      }
      checkResults.push({
        check: check.name,
        group: check.group,
        status: execution.status,
        coverage: execution.coverage,
        measured: execution.measured ?? measured,
        skipReason: execution.reason,
        review: execution.review,
        durationMs: Date.now() - started
      });
      if (execution.status === "skipped") skipped++;
      options.onProgress?.({ type: "check-finished", result: checkResults.at(-1)!, findings: execution.findings });
    } catch (err) {
      if (options.signal?.aborted) throw err; // a cancelled run is not an errored row
      checkResults.push({
        check: check.name,
        group: check.group,
        status: "errored",
        coverage: "missing",
        skipReason: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - started
      });
      options.onProgress?.({ type: "check-finished", result: checkResults.at(-1)!, findings: [] });
    }
    // a live UI gets one frame between checks; without a listener the loop stays synchronous
    if (options.onProgress) await new Promise((resolve) => setTimeout(resolve, 0));
  }

  options.signal?.throwIfAborted();
  const errors = findings.filter((f) => f.severity === "error").length;
  const warnings = findings.filter((f) => f.severity === "warning").length;
  const checked = checkResults.filter((c) => c.status !== "skipped").length;

  return {
    passed: computePassed(ctx, options, checkResults, errors),
    checks: checkResults,
    findings,
    captures: ctx.captures ?? [],
    summary: { errors, warnings, checked, skipped }
  };
}

function validateOptions(options: Options): void {
  for (const group of options.groups ?? []) {
    if (![...CORE_GROUPS, "rendering", "code"].includes(group)) throw new Error(`Unknown group "${group}". Valid: files, model, emote, content, rendering, code.`);
  }
  for (const name of options.checks ?? []) {
    if (!resolveCheck(name)) throw new Error(`Unknown check "${name}". Run \`wearable-validator checks\` to list them.`);
  }
}

function selectChecks(options: Options): CheckDefinition[] {
  if (options.checks && options.checks.length > 0) {
    const wanted = new Set(options.checks.map((c) => resolveCheck(c)!.name));
    return registry.filter((c) => wanted.has(c.name));
  }
  const groups = new Set<Group>(options.groups ?? CORE_GROUPS);
  return registry.filter((c) => groups.has(c.group));
}

function needsParsedModel(check: CheckDefinition): boolean {
  return check.group === "model" || check.group === "emote";
}

function computePassed(ctx: CheckContext, options: Options, results: CheckResult[], errors: number): boolean | null {
  if (ctx.inputKind === "glb" || ctx.inputKind === "png-set") return null; // bare inputs never mint a verdict
  const requestedSubset = Boolean(options.checks?.length) || Boolean(options.groups && CORE_GROUPS.some((group) => !options.groups!.includes(group)));
  if (requestedSubset) return null; // partial run
  if (results.some((r) => r.coverage === "missing" || r.status === "skipped" || r.status === "errored")) return null; // couldn't assert everything
  return errors === 0;
}

/** Legacy Finding[] becomes a complete execution; explicit executions must agree with their findings. */
function normalizeExecution(value: Finding[] | CheckExecution, check: CheckDefinition): CheckExecution {
  const findings = Array.isArray(value) ? value : value.findings;
  if (!Array.isArray(findings) || findings.some((finding) => finding.check !== check.name || finding.group !== check.group)) {
    throw new Error("The check returned findings assigned to another rule.");
  }
  const status = findings.some((finding) => finding.severity === "error") ? "failed"
    : findings.some((finding) => finding.severity === "warning") ? "warning" : "passed";
  if (Array.isArray(value)) return { status, coverage: "complete", findings };
  const consistent =
    (value.status === "passed" && value.coverage === "complete" && findings.length === 0) ||
    (value.status === "warning" && status === "warning") ||
    (value.status === "failed" && status === "failed") ||
    ((value.status === "skipped" || value.status === "errored") && value.coverage === "missing" && Boolean(value.reason));
  if (!consistent) throw new Error("The check returned an inconsistent status or coverage.");
  return value;
}
