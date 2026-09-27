/** Which build is running: the commit and build time the Docker image recorded, or "dev" straight from a checkout. */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export interface IBuildInfoComponent {
  commit: string;
  builtAt: string | null;
  version: string;
  startedAt: number;
}

const PACKAGE_ROOT = resolve(import.meta.dirname, "../..");

function field(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

export async function createBuildInfoComponent(): Promise<IBuildInfoComponent> {
  const pkg = await readJson(resolve(PACKAGE_ROOT, "package.json")).catch(() => ({}));
  // build-info.json is written by the Dockerfile from its COMMIT_HASH build arg; a plain checkout has none
  const build = await readJson(resolve(PACKAGE_ROOT, "build-info.json")).catch(() => ({}));
  return { commit: field(build, "commit") ?? "dev", builtAt: field(build, "builtAt") ?? null, version: field(pkg, "version") ?? "0.0.0", startedAt: Date.now() };
}
