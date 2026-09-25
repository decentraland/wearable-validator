/** CLI runner for the rendering group: code gate → adapters → validate() → run folder, from a terminal instead of the website. */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { fetchCatalystItem, loadInput, parseItemReference, validate, type Input, type Result, type Services } from "@dcl-regenesislabs/wearable-validator";
import { createPiReviewer, setupTokenCredentials } from "@dcl-regenesislabs/wearable-validator/ai";
import { createRenderer } from "@dcl-regenesislabs/wearable-validator/rendering";
import { resolveBuildDirectory } from "../adapters/renderer.js";
import { dryRunReviewer, recordingReviewer, replayReviewer } from "../adapters/reviewer.js";
import { readEvidenceFile, readRun, resolveArtifactsDir, usageLine, writeRun } from "../logic/run-store.js";
import { referenceName, VISUAL_CHECKS } from "../logic/runs.js";

const NO_AI_REASON = "The model was not called (--no-ai).";

const ROOT = resolve(import.meta.dirname, "../../../..");

export interface Args {
  /** The zip's path, or the reference as typed when `reference` is set. */
  file: string;
  /** The URN candidates a shop URL or URN resolved to; the item is fetched from the catalyst instead of read from disk. */
  reference?: string[];
  buildDirectory?: string;
  from?: string;
  answer: boolean;
  thumbnail?: string;
  standalone: boolean;
  noAi: boolean;
  cache: "none" | "short";
  out: string;
}

export async function readArgs(argv = process.argv.slice(2)): Promise<Args> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      "renderer-build": { type: "string" },
      from: { type: "string" },
      answer: { type: "boolean", default: false },
      thumbnail: { type: "string" },
      standalone: { type: "boolean", default: false },
      "no-ai": { type: "boolean", default: false },
      cache: { type: "string", default: "none" },
      out: { type: "string" }
    }
  });
  const usage = "Usage: review -- <item.zip | urn | shop item URL> [--renderer-build <Build>] [--from <run dir>] [--answer] [--thumbnail <png>] [--standalone] [--no-ai] [--cache none|short] [--out packages/server/artifacts]";
  if (positionals.length !== 1) throw new Error(usage);
  // npm -w runs scripts from packages/server; INIT_CWD is where the command was typed, so relative paths mean what the user sees
  const cwd = process.env.INIT_CWD ?? process.cwd();
  const path = (value: string | undefined) => (value === undefined ? undefined : resolve(cwd, value));
  // a file on disk is the item whatever its path looks like; only then is the positional read as a reference (a token page throws its own hint)
  const reference = existsSync(path(positionals[0])!) ? undefined : parseItemReference(positionals[0]) ?? undefined;
  if (values.answer && !values.from) throw new Error("--answer replays <run>/thumbnail-honesty/3-answer.json — add --from <run dir>.");
  if (!process.env.ANTHROPIC_OAUTH_SETUP_TOKEN && !values["no-ai"] && !values.answer) throw new Error(`Set ANTHROPIC_OAUTH_SETUP_TOKEN (a claude setup-token), or pass --no-ai to skip the model.\n${usage}`);
  if (values.cache !== "none" && values.cache !== "short") throw new Error("Choose --cache none or --cache short.");
  return {
    file: reference ? positionals[0] : path(positionals[0])!,
    reference,
    buildDirectory: await resolveBuildDirectory(values["renderer-build"] ?? process.env.RENDERER_BUILD),
    from: path(values.from),
    answer: values.answer!,
    thumbnail: path(values.thumbnail),
    standalone: values.standalone!,
    noAi: values["no-ai"]!,
    cache: values.cache,
    out: resolveArtifactsDir(values.out ?? process.env.ARTIFACTS_DIR)
  };
}

export interface Item {
  /** What the code gate judges: the zip itself, or the published item as the catalyst serves it. */
  gateInput: Input;
  /** What the visual run gets: the unpacked files, so --thumbnail can replace one of them; a published item keeps its metadata. */
  input: Input;
  thumbnail?: Uint8Array;
  /** The run folder's name stem. */
  name: string;
}

/** The published item behind a reference, with the same progress the site shows. */
async function fetchReference(candidates: string[]): Promise<{ gateInput: Input; name: string }> {
  const item = await fetchCatalystItem(candidates, {
    peer: process.env.CATALYST_URL,
    onProgress: ({ text, done, total }) => {
      if (done === undefined) console.log(text);
      else process.stdout.write(`\r${text} ${done}/${total}${done === total ? "\n" : ""}`);
    }
  });
  console.log(`Found ${item.name} (${item.urn})`);
  return { gateInput: { files: item.files, metadata: item.metadata, content: item.content }, name: referenceName(item.urn) };
}

export async function readItem(args: Args): Promise<Item> {
  const { gateInput, name } = args.reference
    ? await fetchReference(args.reference)
    : { gateInput: new Uint8Array(await readEvidenceFile(args.file)), name: basename(args.file).replace(/\.zip$/i, "") };
  const loaded = await loadInput(gateInput, {});
  if (!loaded.ctx) throw new Error("Provide a readable Builder wearable/emote ZIP with its thumbnail and representations.");
  const files = loaded.ctx.files;
  const thumbnailPath = loaded.ctx.item.thumbnailPath ?? "thumbnail.png";
  if (args.thumbnail) files.set(thumbnailPath, await readEvidenceFile(args.thumbnail));
  const input: Input = gateInput instanceof Uint8Array ? { files } : { files, metadata: gateInput.metadata, content: gateInput.content };
  return { gateInput, input, thumbnail: files.get(thumbnailPath), name };
}

/** Repo-relative when inside the checkout (the documented commands run from the root), absolute otherwise. */
function display(path: string): string {
  const rel = relative(ROOT, path);
  return rel.startsWith("..") ? path : rel;
}

function printSummary(result: Result, index: string): void {
  for (const row of result.checks) {
    const count = result.findings.filter((finding) => finding.check === row.check).length;
    const parts = [row.check, row.status, `${count} finding${count === 1 ? "" : "s"}`, usageLine(row)].filter(Boolean);
    console.log(parts.join("  "));
    if (row.skipReason) console.log(`  ${row.skipReason}`);
  }
  for (const finding of result.findings) {
    const evidence = finding.evidence?.map((ref) => ref.captureId).join(", ");
    console.log(`  - ${finding.message}${finding.where ? ` (${finding.where})` : ""}${evidence ? `  evidence: ${evidence}` : ""}`);
  }
  console.log(`open ${display(index)}`);
}

async function main(): Promise<void> {
  const args = await readArgs();
  const { gateInput, input, thumbnail, name } = await readItem(args);
  // code gate is zero-cost: no browser, no OAuth until passed === true or --standalone; it judges the zip itself, not the unpacked files
  if (!args.standalone) {
    const code = await validate(gateInput);
    if (code.passed !== true) {
      console.log(JSON.stringify({
        stage: "code",
        result: code,
        message: "Visual review was not started. Fix code failures or missing coverage; use --standalone to run V-05 individually."
      }, null, 2));
      process.exitCode = 1;
      return;
    }
  }
  await mkdir(args.out, { recursive: true });
  const runDir = await mkdtemp(join(args.out, `visual-${name}-`));
  const captures = args.from ? await readRun(args.from) : undefined;
  const renderer = args.buildDirectory ? await createRenderer({ buildDirectory: args.buildDirectory }) : undefined;
  const reviewer = args.noAi ? dryRunReviewer(NO_AI_REASON)
    : args.answer ? replayReviewer(args.from!)
    : createPiReviewer({ credentials: setupTokenCredentials(process.env.ANTHROPIC_OAUTH_SETUP_TOKEN ?? ""), cache: args.cache });
  const services: Services = { renderer, reviewer: recordingReviewer(reviewer, runDir) };
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  console.log(`Running ${VISUAL_CHECKS.join(", ")}: reusing ${captures?.length ?? 0} supplied views, rendering the rest, then one model call per review.\nRun folder: ${display(runDir)}`);
  try {
    const result = await validate(input, { checks: VISUAL_CHECKS, captures, services, signal: controller.signal });
    const index = await writeRun(runDir, result, thumbnail);
    printSummary(result, index);
    const dryRunCompleted = args.noAi && result.checks.every((row) => row.status === "passed" || (row.status === "errored" && Boolean(row.skipReason?.includes(NO_AI_REASON))));
    process.exitCode = result.checks.every((row) => row.status === "passed") || dryRunCompleted ? 0 : 1;
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
    await renderer?.stop();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Visual review failed.");
    process.exitCode = 1;
  });
}
