import { resolve } from "node:path";
import { createMetricsComponent } from "@dcl/metrics";
import { createServerComponent, createStatusCheckComponent, instrumentHttpServerWithPromClientRegistry } from "@dcl/http-server";
import { composeConfigProviders, createConfigComponent, createDotEnvConfigComponent } from "@well-known-components/env-config-provider";
import type { IConfigComponent, ILoggerComponent } from "@well-known-components/interfaces";
import { createJsonLogComponent, createLogComponent } from "@well-known-components/logger";
import { manifest } from "@dcl-regenesislabs/wearable-validator";
import { createIdentityComponent } from "./adapters/identity.js";
import { appLogger, createLogBufferComponent } from "./adapters/log-buffer.js";
import { createRendererComponent } from "./adapters/renderer.js";
import { runSelfTest } from "./adapters/self-test.js";
import { createReviewerComponent } from "./adapters/reviewer.js";
import { createBuildInfoComponent } from "./adapters/build-info.js";
import { createCatalystComponent } from "./adapters/catalyst.js";
import { createSiteComponent } from "./adapters/site.js";
import { createSlackComponent } from "./adapters/slack.js";
import { isLoopback } from "./logic/hosts.js";
import { createQueueComponent } from "./logic/queue.js";
import { createRunStoreComponent } from "./logic/run-store.js";
import { createRunsComponent } from "./logic/runs.js";
import { metricDeclarations } from "./metrics.js";
import type { AppComponents, BaseComponents, GlobalContext } from "./types.js";

/** The Dockerfile still says PORT and HOST; they win over .env.default, the WKC names win over them. */
export function legacyNames(env: NodeJS.ProcessEnv): Partial<Record<string, string>> {
  return { HTTP_SERVER_PORT: env.HTTP_SERVER_PORT ?? env.PORT, HTTP_SERVER_HOST: env.HTTP_SERVER_HOST ?? env.HOST };
}

/** LOG_FORMAT=json: one JSON line per event so the host's collector ships them unchanged. */
export async function createLogs(config: IConfigComponent, metrics: Parameters<typeof createLogComponent>[0]["metrics"]): Promise<ILoggerComponent> {
  const json = (await config.getString("LOG_FORMAT")) === "json";
  return json ? createJsonLogComponent({ metrics, config }) : createLogComponent({ metrics, config });
}

/** @dcl/metrics hands its prom-client registry back untyped; /metrics is served from it, so its absence is a startup error. */
export async function createMetrics(config: IConfigComponent): Promise<AppComponents["metrics"]> {
  const metrics = await createMetricsComponent(metricDeclarations, { config });
  if (!metrics.registry) throw new Error("@dcl/metrics exposes no registry: /metrics cannot be served.");
  return { ...metrics, registry: metrics.registry };
}

export async function createAppServer(config: IConfigComponent, logs: ILoggerComponent): Promise<AppComponents["server"]> {
  return createServerComponent<GlobalContext>(
    { config, logs },
    {
      // a slow upload holds its buffers only this long; the body cap itself is the route's (MAX_UPLOAD_BYTES)
      requestTimeout: (await config.getNumber("UPLOAD_TIMEOUT_MS")) ?? 60000
    }
  );
}

export type ComponentOverrides = Partial<Pick<BaseComponents, "server" | "identity" | "renderer" | "reviewer" | "catalyst" | "slack">>;

export async function createBaseComponents(config: IConfigComponent, logs: ILoggerComponent, metrics: AppComponents["metrics"], overrides: ComponentOverrides = {}): Promise<Omit<AppComponents, "statusChecks">> {
  const server = overrides.server ?? (await createAppServer(config, logs));
  // /metrics lives on the server itself, ahead of the app router and its sign-in: without WKC_METRICS_BEARER_TOKEN it answers anyone
  const metricsOpen = !(await config.getString("WKC_METRICS_BEARER_TOKEN"));
  if (metricsOpen && !isLoopback(await config.requireString("HTTP_SERVER_HOST"))) {
    appLogger(logs, "server").warn("/metrics is off: set WKC_METRICS_BEARER_TOKEN to serve it on a non-loopback host");
  } else {
    await instrumentHttpServerWithPromClientRegistry({ server, config, metrics, registry: metrics.registry });
  }
  const logBuffer = createLogBufferComponent({ logs });
  const identity = overrides.identity ?? (await createIdentityComponent({ config, logs: logBuffer }));
  const renderer = overrides.renderer ?? (await createRendererComponent({ config, logs: logBuffer }));
  const reviewer = overrides.reviewer ?? (await createReviewerComponent({ config, logs: logBuffer }));
  const catalyst = overrides.catalyst ?? (await createCatalystComponent({ config, logs: logBuffer }));
  const runStore = await createRunStoreComponent({ config, logs: logBuffer });
  const queue = createQueueComponent({
    maxConcurrent: (await config.getNumber("MAX_CONCURRENT_RUNS")) ?? 1,
    maxWaiting: (await config.getNumber("MAX_WAITING_RUNS")) ?? 20,
    maxActivePerOwner: (await config.getNumber("MAX_ACTIVE_RUNS_PER_OWNER")) ?? 3
  });
  const slack = overrides.slack ?? (await createSlackComponent({ config, logs: logBuffer }));
  const runs = await createRunsComponent({ config, logs: logBuffer, metrics, runStore, queue, renderer, reviewer, catalyst, notifier: slack });
  const site = await createSiteComponent({ config, logs: logBuffer });
  const buildInfo = await createBuildInfoComponent();

  appLogger(logBuffer, "server").info("run server configured", {
    host: await config.requireString("HTTP_SERVER_HOST"),
    port: await config.requireNumber("HTTP_SERVER_PORT"),
    renderer: renderer.available ? (renderer.kind === "native" ? "native render server" : "local Unity build") : "none",
    reviewer: reviewer.kind,
    model: reviewer.model,
    catalyst: catalyst.peer,
    identity: identity.kind,
    concurrentRuns: queue.maxConcurrent,
    slack: slack.enabled ? slack.channel : "off",
    rules: manifest.version,
    version: buildInfo.version,
    commit: buildInfo.commit,
    builtAt: buildInfo.builtAt ?? "checkout",
    artifacts: runStore.root,
    site: site.root ?? "not built (run npm run build -w wearable-validator-web, or use the Vite dev server)"
  });

  // the port is already open: a slow probe must not delay the health check, and its answer is in the log either way
  // the self-test probes Chromium's WebGPU; the native render server draws with OpenGL and reports its own start
  if (renderer.available && renderer.kind === "chromium" && (await config.getString("RENDERER_SELF_TEST")) !== "0") void runSelfTest({ logs: logBuffer }).catch(() => {});

  return { config, logs: logBuffer, logBuffer, server, metrics, identity, renderer, reviewer, catalyst, runStore, queue, runs, site, slack, buildInfo };
}

export async function initComponents(): Promise<AppComponents> {
  const config = composeConfigProviders(
    createConfigComponent(legacyNames(process.env)),
    await createDotEnvConfigComponent({ path: [resolve(import.meta.dirname, "../.env.default")] })
  );
  const metrics = await createMetrics(config);
  const logs = await createLogs(config, metrics);
  const base = await createBaseComponents(config, logs, metrics);
  const statusChecks = await createStatusCheckComponent({ server: base.server, config });
  return { ...base, statusChecks };
}
