/** What a curator must do with a finished run, from the code gate and the visual review alone: pure, no I/O. */
import type { CheckResult, Finding, Result } from "@dcl-regenesislabs/wearable-validator";
import type { CuratorDecision } from "../types.js";
import { groupFindings, type FindingGroup } from "./group-findings.js";

export interface DecisionInput {
  gate?: Result;
  visual?: Result;
  passed: boolean | null;
  /** The run's own failure, when it did not reach a result. */
  error?: string;
}

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;

const short = (text: string, max = 60): string => (text.length > max ? text.slice(0, max - 1) + "…" : text);

/** "render-valid: nothing visible on BaseMale" — the failed row with what it measured, or its first finding. */
function failedRow(row: CheckResult, findings: Finding[]): string {
  const cause = row.measured ?? findings.find((entry) => entry.check === row.check)?.message;
  return cause ? `${row.check}: ${short(cause)}` : `${row.check} failed`;
}

const MAX_NAMED_CHECKS = 3;

/** "file-size: The item totals 4.03 MB; the limit for an emote is 3 MB" — each failing code check with the gist of its first error. */
function codeReasons(gate: Result): string[] {
  const byCheck = new Map<string, FindingGroup[]>();
  for (const group of groupFindings(gate.findings.filter((entry) => entry.severity === "error"))) {
    byCheck.set(group.finding.check, [...(byCheck.get(group.finding.check) ?? []), group]);
  }
  if (byCheck.size === 0) return [plural(gate.summary.errors, "code error")];
  const named = [...byCheck].slice(0, MAX_NAMED_CHECKS).map(([check, groups]) => {
    // the part before " — " says what is wrong; the rest is how to fix it, which the finding list carries
    const gist = short(groups[0].message.split(" — ")[0], 90);
    const shapes = groups[0].shapes.length ? ` (${groups[0].shapes.join(", ")})` : "";
    return `${check}: ${gist}${shapes}${groups.length > 1 ? ` (+${groups.length - 1} more)` : ""}`;
  });
  const rest = byCheck.size - named.length;
  return rest > 0 ? [...named, `+${plural(rest, "more failing check")}`] : named;
}

/** An errored or skipped visual row, with the library's own words for why (no model, an inconclusive answer, a refused call). */
function unreviewedRow(row: CheckResult): string {
  return row.skipReason ? `${row.check}: ${short(row.skipReason)}` : `${row.check} was not reviewed`;
}

export function curatorDecision({ gate, visual, passed, error }: DecisionInput): CuratorDecision {
  if (error !== undefined) return { state: "blocked", reasons: ["the run failed"] };
  const blocked: string[] = [];
  const review: string[] = [];
  if (gate && gate.summary.errors > 0) blocked.push(...codeReasons(gate));
  for (const row of visual?.checks ?? []) {
    if (row.status === "failed") blocked.push(failedRow(row, visual?.findings ?? []));
    else if (row.status === "errored" || row.status === "skipped") review.push(unreviewedRow(row));
  }
  const warnings = (gate?.summary.warnings ?? 0) + (visual?.summary.warnings ?? 0);
  if (warnings > 0) review.push(plural(warnings, "warning"));
  if (!visual && blocked.length === 0) review.push("the visual review did not run");
  if (blocked.length) return { state: "blocked", reasons: blocked };
  if (passed === null && review.length === 0) review.push("no verdict");
  return review.length ? { state: "review", reasons: review } : { state: "ready", reasons: [] };
}
