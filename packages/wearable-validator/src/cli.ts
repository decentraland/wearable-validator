#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { Command } from "commander";
import { validate } from "./validate.js";
import { registry } from "./registry.js";
import { explanations } from "./registry.js";
import type { Finding, Group, Result } from "./types.js";

const program = new Command();
program.name("wearable-validator").description("The Decentraland wearable & emote rule book as code.");

program
  .command("validate")
  .argument("<file>", "wearable/emote .zip, bare .glb, or facial-feature .png")
  .option("--groups <groups>", "comma-separated: files,model,emote,content,rendering,code")
  .option("--checks <checks>", "comma-separated check names (rule IDs like M-01 work as aliases)")
  .option("--category <category>", "category hint for bare GLBs (e.g. upper_body)")
  .option("--item-type <type>", "wearable | emote — overrides inference on bare GLBs")
  .option("--json", "print the raw Result JSON")
  .action(async (file: string, opts: { groups?: string; checks?: string; category?: string; itemType?: string; json?: boolean }) => {
    const bytes = new Uint8Array(await readFile(file));
    let result: Result;
    try {
      result = await validate(bytes, {
        groups: opts.groups?.split(",").map((g) => g.trim()) as Group[] | undefined,
        checks: opts.checks?.split(",").map((c) => c.trim()),
        category: opts.category,
        itemType: opts.itemType as "wearable" | "emote" | undefined
      });
    } catch (err) {
      console.error(`✖ ${err instanceof Error ? err.message : String(err)}`);
      process.exit(2);
    }
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      printPretty(basename(file), result);
    }
    process.exit(result.summary.errors > 0 ? 1 : 0);
  });

program
  .command("checks")
  .description("list every check with its group and rule-book ID")
  .action(() => {
    for (const check of registry) {
      const prompt = check.prompt ? `  prompt v${check.prompt.version}` : "";
      console.log(`${check.name.padEnd(20)} ${check.group.padEnd(9)} ${check.rule.padEnd(6)} ${check.describe}${prompt}`);
      console.log(`${" ".repeat(37)}${explanations[check.name] ?? ""}\n`);
    }
  });

function printPretty(file: string, result: Result): void {
  const verdict = result.passed === null ? "no verdict (partial or bare input)" : result.passed ? "PASSED" : "FAILED";
  console.log(`\n${file} — ${verdict}  (${result.summary.errors} errors, ${result.summary.warnings} warnings, ${result.summary.checked} checks)\n`);
  for (const finding of result.findings) {
    console.log(formatFinding(finding));
  }
  const skipped = result.checks.filter((c) => c.status === "skipped");
  for (const s of skipped) console.log(`… ${s.check} skipped — ${s.skipReason}`);
  const errored = result.checks.filter((c) => c.status === "errored");
  for (const e of errored) console.log(`! ${e.check} errored — ${e.skipReason}`);
}

function formatFinding(f: Finding): string {
  const icon = f.severity === "error" ? "✖" : "⚠";
  const head = `${icon} ${f.check}`.padEnd(22);
  const lines = [`${head}${f.message}`];
  if (f.where) lines.push(`${" ".repeat(22)}${f.where}`);
  if (f.evidence?.length) lines.push(`${" ".repeat(22)}evidence: ${f.evidence.map((e) => e.captureId).join(", ")}`);
  lines.push(`${" ".repeat(22)}${f.docs}   (rule ${f.rule})`);
  return lines.join("\n");
}

program.parseAsync();
