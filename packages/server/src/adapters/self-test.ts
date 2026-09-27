/**
 * Can this host render at all? A run that hangs looks the same whether the render server cannot draw or the content
 * servers refuse this network, so the server answers both questions at startup instead of leaving it to guesswork.
 * Previous hop: components.ts, once the port is open. Next hop: the operator log and GET /api/health.
 */
import type { RenderServerProbe } from "@dcl-regenesislabs/wearable-validator/native";
import type { ILoggerComponent } from "@well-known-components/interfaces";
import { appLogger } from "./log-buffer.js";

export interface ReachabilityResult {
  url: string;
  status: number | null;
  ms: number;
  error?: string;
}

export interface SelfTestResult {
  render: RenderServerProbe;
  reachability: ReachabilityResult[];
  ok: boolean;
}

/** The hosts a render needs: the content servers the render server loads the avatar and its wearables from. */
export const RENDER_DEPENDENCIES = ["https://peer.decentraland.org/content/status", "https://peer.decentraland.org/lambdas/status"];

async function reach(url: string, timeoutMs: number): Promise<ReachabilityResult> {
  const started = Date.now();
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });
    return { url, status: response.status, ms: Date.now() - started };
  } catch (error) {
    return { url, status: null, ms: Date.now() - started, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function runSelfTest(
  components: { logs: ILoggerComponent },
  options: { probe: (timeoutMs: number) => Promise<RenderServerProbe>; timeoutMs?: number; dependencies?: string[] }
): Promise<SelfTestResult> {
  const log = appLogger(components.logs, "self-test");
  const timeoutMs = options.timeoutMs ?? 60000;
  const reachability = await Promise.all((options.dependencies ?? RENDER_DEPENDENCIES).map((url) => reach(url, Math.min(timeoutMs, 15000))));
  for (const result of reachability) {
    const fields = { url: result.url, status: result.status ?? "none", ms: result.ms, error: result.error };
    if (result.status && result.status < 400) log.info("dependency reachable", fields);
    else log.error("dependency unreachable: the render server will fail to load avatars and items", fields);
  }
  const render = await options.probe(timeoutMs);
  if (render.ok) log.info("renderer self-test passed: the render server draws here", { ms: render.ms });
  else log.error("renderer self-test failed: every render will fail", { ms: render.ms, error: render.error });
  return { render, reachability, ok: render.ok && reachability.every((result) => result.status !== null && result.status < 400) };
}
