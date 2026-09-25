/** The Unity renderer as a component: one browser per run, its captures and diagnostics routed to the run's stream and the log. */
import { mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { IConfigComponent, ILoggerComponent } from "@well-known-components/interfaces";
import type { Renderer } from "@dcl-regenesislabs/wearable-validator";
import { createRenderer } from "@dcl-regenesislabs/wearable-validator/rendering";
import type { RunSink } from "../types.js";
import { appLogger, type AppLogger } from "./log-buffer.js";

const ROOT = resolve(import.meta.dirname, "../../../..");
// packages/server/renderer-build is the gitignored home for the PR #10053 Unity build, so RENDERER_BUILD is optional once it is there
const DEFAULT_BUILD = join(ROOT, "packages/server/renderer-build");
const DEFAULT_PROFILE = join(tmpdir(), "wearable-validator-chromium");
const SINGLETON_FILES = ["SingletonLock", "SingletonCookie", "SingletonSocket"];

export interface IRendererComponent {
  readonly available: boolean;
  readonly buildDirectory?: string;
  /** Undefined when no build is configured. */
  forRun(run: RunSink): Promise<Renderer | undefined>;
}

/** RENDERER_BUILD when set (relative to where the command was typed), else the default folder when its wasm is there. */
export async function resolveBuildDirectory(configured: string | undefined, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  if (configured) return resolve(env.INIT_CWD ?? process.cwd(), configured);
  return stat(join(DEFAULT_BUILD, "avatar-preview-renderer.wasm")).then(() => DEFAULT_BUILD).catch(() => undefined);
}

/**
 * Where Chromium keeps its profile between runs: the compiled WASM, the shaders and the avatar the previewer
 * downloads are most of a cold start. Chromium locks a profile, so it is only safe while one run renders at a time.
 */
export async function resolveProfileDirectory(config: IConfigComponent, log: AppLogger): Promise<string | undefined> {
  const configured = await config.getString("CHROMIUM_PROFILE_DIR");
  if (configured === "") return undefined;
  const concurrent = (await config.getNumber("MAX_CONCURRENT_RUNS")) ?? 1;
  if (concurrent > 1) {
    log.warn("MAX_CONCURRENT_RUNS above 1: every render starts from a cold browser (Chromium locks one profile at a time)", { concurrent });
    return undefined;
  }
  const directory = configured ? resolve(process.env.INIT_CWD ?? process.cwd(), configured) : DEFAULT_PROFILE;
  try {
    await mkdir(directory, { recursive: true });
    // a container killed mid-render leaves Chromium's singleton files behind and the next launch refuses the
    // profile ("in use by another Chromium process on another computer"); one browser at a time makes them stale
    await Promise.all(SINGLETON_FILES.map((name) => rm(join(directory, name), { force: true })));
    log.info("browser profile kept between runs", { directory });
    return directory;
  } catch (error) {
    log.warn("cannot keep a browser profile: every render starts cold", { directory, error: error instanceof Error ? error.message : String(error) });
    return undefined;
  }
}

export async function createRendererComponent(components: { config: IConfigComponent; logs: ILoggerComponent }): Promise<IRendererComponent> {
  const { config, logs } = components;
  const log = appLogger(logs, "renderer");
  const buildDirectory = await resolveBuildDirectory(await config.getString("RENDERER_BUILD"));
  // the library reads these from the process environment at launch; a value that only the config knows (a test map) is handed over here
  for (const key of ["CHROMIUM_ARGS", "CHROMIUM_SANDBOX", "CHROMIUM_EXECUTABLE"]) {
    const value = await config.getString(key);
    if (value !== undefined && process.env[key] === undefined) process.env[key] = value;
  }
  if (!buildDirectory) log.warn("no Unity build found: visual runs will skip rendering (put the PR #10053 build in packages/server/renderer-build or set RENDERER_BUILD)");
  // a slow host (few vCPUs, software rendering) needs longer per previewer command than the manifest assumes
  const timeouts = {
    commandTimeoutMs: await config.getNumber("RENDER_COMMAND_TIMEOUT_MS"),
    loadTimeoutMs: await config.getNumber("RENDER_LOAD_TIMEOUT_MS"),
    timeoutMs: await config.getNumber("RENDER_TOTAL_TIMEOUT_MS")
  };
  const overrides = Object.fromEntries(Object.entries(timeouts).filter(([, value]) => value !== undefined));
  if (Object.keys(overrides).length) log.info("render timeouts overridden", overrides);
  const profileDirectory = await resolveProfileDirectory(config, log);
  return {
    available: Boolean(buildDirectory),
    buildDirectory,
    forRun: async (run) =>
      buildDirectory
        ? createRenderer({ buildDirectory, timeouts: overrides, profileDirectory, onCapture: (capture) => void run.capture(capture), onLog: (message, fields) => log.info(message, { run: run.id, ...fields }) })
        : undefined
  };
}
