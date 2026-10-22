/**
 * An item's findings as a curator reads them: one entry per check, the ones that fail the item first, each file and each
 * fix said once, then the model's review as one line. Pure, so the Slack message only renders it.
 */
import { checks } from "@dcl-regenesislabs/wearable-validator";
import type { ReviewItem } from "./review-request.js";
import type { ItemFinding, ItemResult } from "./review-job.js";
import { groupFindings } from "./group-findings.js";

export interface ReportLine {
  text: string;
  severity: ItemFinding["severity"];
  /** Set when the line holds for fewer body shapes than the item has, e.g. "female". */
  only?: string;
}

export interface ReportCheck {
  check: string;
  title: string;
  rule: string;
  /** error when any of its findings fails the item. */
  severity: ItemFinding["severity"];
  lines: ReportLine[];
  /** What every line shares, said once under them: usually the limit and how to fix it. */
  note?: string;
}

export interface ItemReport {
  checks: ReportCheck[];
  /** Checks that fail the item, then checks a curator may want to look at. */
  toFix: number;
  toCheck: number;
  /** The visual checks the model answered, by title, with how they came out. */
  modelReview: { title: string; outcome: "passed" | ItemFinding["severity"] }[];
  /** What a smart wearable's code does, as the model read it: the one review a curator needs in words. */
  codeSummary?: string;
}

const CODE_REVIEW = "smart-wearable-code: ";

const SHAPES = ["male", "female"];
const MODEL_FILE = /\.(glb|gltf)$/i;
// `"male/shirt.glb" › Albedo` or `male/shirt.glb`
const FILE = /^"?([^"]+?)"?(?: › .*)?$/s;

const fileOf = (where: string | undefined): string | undefined => (where ? FILE.exec(where)?.[1] : undefined);
const bare = (file: string): string => file.replace(/^(male|female)\//i, "");
const titleOf = (check: string): string => checks[check]?.title ?? check;
const capitalize = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/** The body-shape folders an item ships, from its file paths. */
function itemShapes(item: ReviewItem): string[] {
  return SHAPES.filter((shape) => Object.keys(item.contents).some((path) => path.toLowerCase().startsWith(`${shape}/`)));
}

/**
 * Builder stores each model under its content hash, a name no curator recognises: with one model per body shape the
 * message says "the model" instead, and a sub-location such as a texture name is kept.
 */
function withoutModelFile(message: string, models: string[]): string {
  if (models.length !== 1) return message;
  let text = message;
  for (const file of new Set([...SHAPES.map((shape) => `${shape}/${models[0]}`), models[0]])) {
    text = text.split(`"${file}" › `).join("").split(`in "${file}"`).join("in the model").split(`"${file}"`).join("the model");
  }
  return text.startsWith("the model") ? capitalize(text) : text;
}

/** The words every message ends with, when there are several and they share at least a clause: said once as a note. */
function sharedEnding(messages: string[]): string {
  if (messages.length < 2) return "";
  const words = messages.map((message) => message.split(" "));
  let shared = 0;
  while (words.every((w) => w.length > shared + 1 && w[w.length - 1 - shared] === words[0][words[0].length - 1 - shared])) shared++;
  if (shared < 4) return "";
  return words[0].slice(words[0].length - shared).join(" ");
}

// a texture too large for the size limit is also too large for the QR scanner: the size error already asks to shrink it
const foldedIntoSizeError = (finding: ItemFinding, findings: ItemFinding[]): boolean =>
  finding.check === "qr-code" && finding.severity === "warning" && findings.some((other) => other.check === "texture-size" && other.severity === "error" && other.where === finding.where);

export function itemReport(item: ReviewItem, result: ItemResult): ItemReport {
  const shapes = itemShapes(item);
  const findings = result.findings.filter((finding) => !foldedIntoSizeError(finding, result.findings));
  const models = [...new Set(findings.map((finding) => fileOf(finding.where)).filter((file): file is string => !!file && MODEL_FILE.test(file)).map(bare))];

  const byCheck = new Map<string, ReportCheck>();
  for (const { finding, message, shapes: spanned } of groupFindings(findings)) {
    const entry = byCheck.get(finding.check) ?? { check: finding.check, title: titleOf(finding.check), rule: finding.rule, severity: finding.severity, lines: [] };
    if (finding.severity === "error") entry.severity = "error";
    const covers = spanned.length > 0 ? spanned : finding.bodyShape ? [finding.bodyShape] : shapes;
    const only = covers.length < shapes.length ? covers.join(", ") : undefined;
    entry.lines.push({ text: withoutModelFile(message, models), severity: finding.severity, ...(only ? { only } : {}) });
    byCheck.set(finding.check, entry);
  }

  for (const entry of byCheck.values()) {
    // errors before warnings within a check, then the ending the check's own-severity lines share lifted out of them
    entry.lines.sort((a, b) => Number(b.severity === "error") - Number(a.severity === "error"));
    const main = entry.lines.filter((line) => line.severity === entry.severity);
    const ending = sharedEnding(main.map((line) => line.text));
    if (!ending) continue;
    entry.lines = entry.lines.map((line) => (line.severity === entry.severity ? { ...line, text: line.text.slice(0, -ending.length).trim().replace(/[;,:—-]$/, "").trim() } : line));
    entry.note = capitalize(ending.replace(/^[;,:—-]\s*/, ""));
  }

  const ordered = [...byCheck.values()].sort((a, b) => Number(b.severity === "error") - Number(a.severity === "error"));
  const summaries = (result.visualSummary ?? "").split("\n");
  const reviewed = summaries.map((line) => line.split(":")[0].trim()).filter(Boolean);
  const codeSummary = summaries.find((line) => line.startsWith(CODE_REVIEW))?.slice(CODE_REVIEW.length);
  return {
    checks: ordered,
    toFix: ordered.filter((entry) => entry.severity === "error").length,
    toCheck: ordered.filter((entry) => entry.severity !== "error").length,
    modelReview: reviewed.map((check) => ({ title: titleOf(check), outcome: byCheck.get(check)?.severity ?? "passed" })),
    ...(codeSummary ? { codeSummary } : {})
  };
}
