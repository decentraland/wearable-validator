/**
 * The /native entry: the avatar-preview-renderer's native Linux render server in place of Chromium. The same Unity
 * scene, drawn on the CPU by Mesa's llvmpipe with no browser: one long-running process takes JSON jobs on stdin and
 * answers one JSON line per job on stdout, writing the stills to a folder. Node-only.
 * Previous hop: checks/rendering/* ask for CaptureRequests. Next hop: the stills come back as CaptureRecords.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { digest, digestJson } from "../logic/captures.js";
import { decodePngSafe } from "../logic/images.js";
import { manifest } from "../manifest/index.js";
import type { CaptureRecord, CaptureRequest, RenderInput, Renderer } from "../types.js";

export interface NativeRendererOptions {
  /** The render server to start: its RenderServer/entrypoint.sh, or a launcher that runs it as another user. */
  command: string;
  /** Identity of the player build (its release and sha256): part of buildId, so another build's stills are never reused. */
  build: string;
  /** Where item files and stills are written; the render server must be able to read and write it. */
  workDirectory?: string;
  /** One job's deadline; past it the process is killed and the next capture starts a new one. */
  jobTimeoutMs?: number;
  onCapture?: (capture: CaptureRecord) => void;
  onLog?: (message: string, fields?: Record<string, unknown>) => void;
}

interface RenderedFile { path: string; bodyShape: string; yaw: number; time?: number }
interface JobResult { id: string; ok: boolean; error?: string; files: RenderedFile[]; ms: number }

// what the render server inherits: never the host's tokens
const SERVER_ENV = ["PATH", "HOME", "TMPDIR", "LANG", "TZ", "LP_NUM_THREADS", "MESA_SHADER_CACHE_DIR", "LIBGL_ALWAYS_SOFTWARE", "GALLIUM_DRIVER"];

const shapeLabel = (bodyShape: string): string => (/BaseFemale$/i.test(bodyShape) ? "female" : "male");
const same = (a: number, b: number): boolean => Math.abs(a - b) < 1e-4;

export async function createNativeRenderer(options: NativeRendererOptions): Promise<Renderer> {
  const size = manifest.rendering.imageSizePx;
  const workDirectory = options.workDirectory ?? join(tmpdir(), "wearable-validator-native");
  const jobTimeoutMs = options.jobTimeoutMs ?? manifest.rendering.loadTimeoutMs;
  const log = options.onLog ?? (() => {});
  const buildId = await digestJson({ native: options.build, size, platform: process.platform, architecture: process.arch });
  let server: RenderServer | undefined;
  let queued: Promise<unknown> = Promise.resolve();

  const serialize = <T>(work: () => Promise<T>): Promise<T> => {
    const result = queued.then(work, work);
    queued = result.catch(() => {});
    return result;
  };

  async function capture(input: RenderInput, requests: CaptureRequest[], signal?: AbortSignal): Promise<CaptureRecord[]> {
    signal?.throwIfAborted();
    if (requests.some((request) => request.rendererBuild !== buildId)) throw new Error("Capture requests target a different renderer build.");
    if (requests.some((request) => request.size !== size)) throw new Error(`The render server draws ${size} px stills only.`);
    return serialize(async () => {
      const folder = join(workDirectory, randomUUID());
      try {
        const entity = await writeItem(input, join(folder, "item"));
        const records: CaptureRecord[] = [];
        for (const [index, group] of groupRequests(requests).entries()) {
          signal?.throwIfAborted();
          server ??= startServer(options.command, workDirectory, size, log);
          const jobId = `${folder.split("/").pop()}-${index}`;
          const job = jobFor(jobId, entity, input, group);
          const result = await server.run(job, jobTimeoutMs, signal).catch((error: unknown) => {
            // a wedged or crashed player cannot be trusted with the next job
            server?.kill();
            server = undefined;
            throw error;
          });
          if (!result.ok) throw new Error(`The render server could not draw the item: ${result.error ?? "unknown error"}`);
          for (const request of group) {
            const file = result.files.find((f) => f.bodyShape === shapeLabel(request.bodyShape) && same(f.yaw, request.azimuthDegrees)
              && (f.time === undefined || same(f.time, timeOf(input, request))));
            if (!file) throw new Error(`The render server returned no still for ${request.id}.`);
            const bytes = new Uint8Array(await readFile(join(workDirectory, file.path)));
            const png = decodePngSafe(bytes);
            if (!png || png.width !== size || png.height !== size) throw new Error(`The render server's still for ${request.id} is not a ${size} px PNG.`);
            const record: CaptureRecord = { request, bytes, sha256: await digest(bytes), width: png.width, height: png.height };
            options.onCapture?.(record);
            records.push(record);
          }
          await rm(join(workDirectory, jobId), { recursive: true, force: true });
        }
        return records;
      } finally {
        await rm(folder, { recursive: true, force: true });
      }
    });
  }

  async function stop(): Promise<void> {
    server?.kill();
    server = undefined;
  }

  return { buildId, capture, stop };
}

const timeOf = (input: RenderInput, request: CaptureRequest): number =>
  request.timeFraction ?? (input.itemType === "emote" ? 0 : manifest.rendering.wearablePoseFraction);

/** One job per body shape, view, pose and skin: the server draws every yaw and time of a job from one load. */
function groupRequests(requests: CaptureRequest[]): CaptureRequest[][] {
  const groups = new Map<string, CaptureRequest[]>();
  for (const request of requests) {
    const key = [request.bodyShape, request.view, request.pose ?? "", request.skin ?? ""].join("|");
    groups.set(key, [...(groups.get(key) ?? []), request]);
  }
  return [...groups.values()];
}

function jobFor(id: string, entity: object, input: RenderInput, group: CaptureRequest[]): Record<string, unknown> {
  const [first] = group;
  const { background, skin, wearablePose } = manifest.rendering;
  const params = new URLSearchParams({ background, skinColor: first.skin ?? skin }).toString();
  const yaws = [...new Set(group.map((request) => request.azimuthDegrees))];
  const job: Record<string, unknown> = { id, entity, yaws, bodyShapes: [shapeLabel(first.bodyShape)], params };
  if (input.itemType === "emote") return { ...job, times: [...new Set(group.map((request) => timeOf(input, request)))] };
  if (first.view === "wearable") return { ...job, view: "wearable" };
  return { ...job, view: "avatar", pose: first.pose ?? wearablePose, times: [...new Set(group.map((request) => timeOf(input, request)))] };
}

/** The item's files on disk, readable by the render server's user, and the preview's item JSON pointing at them. */
async function writeItem(input: RenderInput, directory: string): Promise<object> {
  const urls = new Map<string, string>();
  for (const [key, bytes] of input.files) {
    const path = join(directory, key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    urls.set(key, pathToFileURL(path).href);
  }
  await shareWithGroup(dirname(directory));
  const representations = (input.item.representations ?? []).map((rep) => ({
    bodyShapes: rep.bodyShapes,
    mainFile: rep.mainFile,
    contents: rep.contents.map((key) => {
      const url = urls.get(key);
      if (!url) throw new Error(`Add the declared preview file "${key}".`);
      return { key, url };
    }),
    overrideHides: rep.overrideHides ?? [],
    overrideReplaces: rep.overrideReplaces ?? []
  }));
  const id = "urn:decentraland:off-chain:preview:visual-review";
  return input.itemType === "emote"
    ? { id, emoteDataADR74: { category: input.category, loop: input.item.loop ?? false, representations } }
    : { id, data: { category: input.category, hides: input.item.hides ?? [], replaces: input.item.replaces ?? [], representations } };
}

// the server writes under umask 077; the render server may run as another user that shares the folder's group
async function shareWithGroup(path: string): Promise<void> {
  await chmod(path, 0o2750);
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) await shareWithGroup(child);
    else await chmod(child, 0o640);
  }
}

interface RenderServer {
  run(job: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<JobResult>;
  kill(): void;
}

function startServer(command: string, outDirectory: string, size: number, log: (message: string, fields?: Record<string, unknown>) => void): RenderServer {
  const env: Record<string, string> = { RENDER_SERVER_SIZE: String(size) };
  for (const key of SERVER_ENV) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  // its own process group: the display and the player go down with it
  const child: ChildProcessWithoutNullStreams = spawn(command, ["--serve", "--out", outDirectory], { env, stdio: ["pipe", "pipe", "pipe"], detached: true });
  const waiting = new Map<string, { resolve: (result: JobResult) => void; reject: (error: Error) => void }>();
  const tail: string[] = [];
  let exited: Error | undefined;
  const fail = (error: Error): void => {
    exited ??= error;
    for (const job of waiting.values()) job.reject(exited);
    waiting.clear();
  };
  log("render server started", { command, pid: child.pid });
  // Unity prints a few boot lines to stdout too: only JSON lines are results
  createInterface({ input: child.stdout }).on("line", (line) => {
    if (!line.startsWith("{")) return;
    const result = JSON.parse(line) as JobResult;
    waiting.get(result.id)?.resolve(result);
  });
  createInterface({ input: child.stderr }).on("line", (line) => {
    tail.push(line);
    if (tail.length > 30) tail.shift();
  });
  child.on("error", (error) => fail(new Error(`The render server could not start (${command}): ${error.message}`)));
  child.on("exit", (code, signal) => fail(new Error(`The render server exited (${signal ?? code}). Its last log lines: ${tail.slice(-5).join(" | ")}`)));
  return {
    run(job, timeoutMs, signal) {
      if (exited) return Promise.reject(exited);
      return new Promise<JobResult>((resolve, reject) => {
        const id = String(job.id);
        const settle = (finish: () => void): void => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          waiting.delete(id);
          finish();
        };
        const timer = setTimeout(() => settle(() => reject(new Error(`The render server did not answer within ${Math.round(timeoutMs / 1000)} s.`))), timeoutMs);
        const abort = (): void => settle(() => reject(signal?.reason ?? new Error("The capture was aborted.")));
        signal?.addEventListener("abort", abort, { once: true });
        waiting.set(id, { resolve: (result) => settle(() => resolve(result)), reject: (error) => settle(() => reject(error)) });
        child.stdin.write(JSON.stringify(job) + "\n");
      });
    },
    kill() {
      child.stdin.end();
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
  };
}
