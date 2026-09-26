/**
 * The test-environment analogue of src/components.ts: the same component graph wired through the same main(), with
 * an in-memory config, a recording logger, a fake identity (x-test-user / x-test-operator headers) and fake
 * renderer/reviewer services, listening on a free loopback port. Every suite starts one with startTestServer().
 */
import { mkdtemp } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestMetricsComponent } from "@dcl/metrics";
import { createConfigComponent } from "@well-known-components/env-config-provider";
import { START_COMPONENT, STOP_COMPONENT, type ILoggerComponent } from "@well-known-components/interfaces";
import { digest, manifest, type CaptureRecord, type Renderer, type Reviewer } from "@dcl-regenesislabs/wearable-validator";
import { renderedFrame } from "../../wearable-validator/test/helpers/frames.js";
import type { ICatalystComponent } from "../src/adapters/catalyst.js";
import type { IIdentityComponent, Identify } from "../src/adapters/identity.js";
import type { IRendererComponent } from "../src/adapters/renderer.js";
import { liveReviewer, recordingReviewer, type IReviewerComponent } from "../src/adapters/reviewer.js";
import type { ISlackComponent } from "../src/adapters/slack.js";
import { createAppServer, createBaseComponents } from "../src/components.js";
import { metricDeclarations } from "../src/metrics.js";
import { main } from "../src/service.js";
import type { RunSink, TestComponents } from "../src/types.js";

export interface RecordedLine {
  level: "LOG" | "DEBUG" | "INFO" | "WARN" | "ERROR";
  logger: string;
  message: string;
  extra: Record<string, unknown>;
}

/** Every line at every level, debug included: what the host's log collector would see. Nothing is printed. */
export function recordingLogs(lines: RecordedLine[]): ILoggerComponent {
  const record = (level: RecordedLine["level"], logger: string) => (message: string | Error, extra?: Record<string, unknown>) =>
    void lines.push({ level, logger, message: message instanceof Error ? message.message : message, extra: extra ?? {} });
  return {
    getLogger: (name) => ({ log: record("LOG", name), debug: record("DEBUG", name), info: record("INFO", name), warn: record("WARN", name), error: record("ERROR", name) })
  };
}

/** Whoever the x-test-user header names, nobody without it; a "service:" owner is a read-only service, x-test-operator: 1 an operator. */
export const testIdentify: Identify = async (request) => {
  const owner = request.headers.get("x-test-user");
  if (!owner) return undefined;
  const service = owner.startsWith("service:");
  return { owner, kind: service ? "service" : "local", operator: request.headers.get("x-test-operator") === "1" || service, readOnly: service };
};

export interface ServiceCalls {
  /** Browsers opened (one per run that reached the renderer). */
  services: number;
  /** Views asked of each browser. */
  rendered: number[];
}

/** A renderer that answers every view with the same frame, at once, or once `gate` opens when one is given. */
export function fakeRenderer(calls: ServiceCalls, gate?: { open: Promise<void> }): IRendererComponent {
  const size = manifest.rendering.imageSizePx;
  const bytes = renderedFrame(size);
  return {
    available: true,
    kind: "chromium",
    forRun: async (run: RunSink) => {
      if (gate) await gate.open;
      calls.services++;
      const renderer: Renderer = {
        buildId: "fake-build",
        capture: async (_input, requests) => {
          calls.rendered.push(requests.length);
          const captures: CaptureRecord[] = [];
          for (const request of requests) {
            const capture = { request, bytes, sha256: await digest(bytes), width: size, height: size };
            await run.capture(capture);
            captures.push(capture);
          }
          return captures;
        },
        stop: async () => {}
      };
      return renderer;
    }
  };
}

/** A model that always agrees, wrapped the way the real component wraps pi: recorded in the run folder, announced on the stream. */
export function fakeReviewer(): IReviewerComponent {
  const model: Reviewer = {
    review: async (request) => ({
      ok: true,
      answer: { verdict: request.check === "thumbnail-honesty" ? "matches" : "ok", summary: "Same shirt.", reviewedCaptureIds: request.images.map((image) => image.id), findings: [] },
      metadata: { provider: "fake", model: "fixture", promptVersion: request.prompt.version, promptDigest: request.promptDigest }
    })
  };
  return { kind: "dry-run", forRun: (run) => liveReviewer(recordingReviewer(model, run.dir), run) };
}

export interface TestServerOptions {
  /** Configuration on top of the test defaults (ARTIFACTS_DIR, MAX_UPLOAD_BYTES, MAX_WAITING_RUNS …). HTTP_SERVER_HOST here only drives identity and the Host check: the socket always binds loopback. */
  env?: Record<string, string>;
  identity?: IIdentityComponent;
  renderer?: IRendererComponent;
  reviewer?: IReviewerComponent;
  /** A catalyst over a fake fetch (test/helpers/entity.ts catalystFetch); without one a reference run would reach the real peer. */
  catalyst?: ICatalystComponent;
  /** A Slack component over a recording fetch; without one the notifier is off (no SLACK_BOT_TOKEN in the test env). */
  slack?: ISlackComponent;
}

export interface TestServer {
  base: string;
  components: TestComponents;
  /** Where run folders land: a fresh temporary folder unless env.ARTIFACTS_DIR says otherwise. */
  artifacts: string;
  lines: RecordedLine[];
  /** The Prometheus text of every metric, to assert on counters. */
  metricsText(): Promise<string>;
  stop(): Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

type Startable = { [START_COMPONENT]?: () => Promise<void> | void; start?: () => Promise<void> | void; [STOP_COMPONENT]?: () => Promise<void> | void; stop?: () => Promise<void> | void };

const startable = (component: unknown): Startable => (component && typeof component === "object" ? (component as Startable) : {});

/** Builds the components and runs main() over them, like Lifecycle.run does without its signal handlers and exit. */
export async function startTestServer(options: TestServerOptions = {}): Promise<TestServer> {
  const port = await freePort();
  const artifacts = options.env?.ARTIFACTS_DIR ?? (await mkdtemp(join(tmpdir(), "run-server-")));
  // the fake renderer says it can render, and the startup self-test would then launch a real Chromium behind every suite
  const env = { HTTP_SERVER_HOST: "127.0.0.1", MAX_CONCURRENT_RUNS: "1", RENDERER_SELF_TEST: "0", ...options.env, HTTP_SERVER_PORT: String(port), ARTIFACTS_DIR: artifacts };
  const config = createConfigComponent(env);
  const lines: RecordedLine[] = [];
  const logs = recordingLogs(lines);
  const metrics = createTestMetricsComponent(metricDeclarations);
  // the socket binds loopback whatever env.HTTP_SERVER_HOST says (a non-loopback bind would prompt the macOS firewall)
  const server = await createAppServer(createConfigComponent({ ...env, HTTP_SERVER_HOST: "127.0.0.1" }), logs);
  const base = `http://127.0.0.1:${port}`;
  const components: TestComponents = {
    ...(await createBaseComponents(config, logs, metrics, {
      server,
      identity: options.identity ?? { identify: testIdentify, kind: "test" },
      renderer: options.renderer ?? fakeRenderer({ services: 0, rendered: [] }),
      reviewer: options.reviewer ?? fakeReviewer(),
      ...(options.catalyst ? { catalyst: options.catalyst } : {}),
      ...(options.slack ? { slack: options.slack } : {})
    })),
    localFetch: { fetch: (url, init) => fetch(new URL(String(url), base), init) }
  };

  const entries = Object.entries(components);
  const startComponents = async () => {
    for (const [, component] of entries) {
      const it = startable(component);
      await (it[START_COMPONENT] ?? it.start)?.call(component);
    }
  };
  const stop = async () => {
    for (const [, component] of entries.slice().reverse()) {
      const it = startable(component);
      await (it[STOP_COMPONENT] ?? it.stop)?.call(component);
    }
  };
  await main({ components, startComponents, stop, beforeStopComponents: () => {} });
  return { base, components, artifacts, lines, metricsText: () => metrics.registry.metrics(), stop };
}
