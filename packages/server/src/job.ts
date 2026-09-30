/** The queue-driven review job's entry point: drains the work queue once and exits, so its task scales to zero. */
import { resolve } from "node:path";
import { composeConfigProviders, createConfigComponent, createDotEnvConfigComponent } from "@well-known-components/env-config-provider";
import { createBuilderComponent } from "./adapters/builder.js";
import { appLogger } from "./adapters/log-buffer.js";
import { createRendererComponent } from "./adapters/renderer.js";
import { createReviewerComponent } from "./adapters/reviewer.js";
import { createWorkQueueComponent } from "./adapters/work-queue.js";
import { createLogs, createMetrics } from "./components.js";
import { createReviewJob } from "./logic/review-job.js";

const config = composeConfigProviders(createConfigComponent(process.env), await createDotEnvConfigComponent({ path: [resolve(import.meta.dirname, "../.env.default")] }));
const logs = await createLogs(config, await createMetrics(config));
const log = appLogger(logs, "review-job");
const job = createReviewJob({
  logs,
  queue: await createWorkQueueComponent({ config }),
  builder: await createBuilderComponent({ config, logs }),
  renderer: await createRendererComponent({ config, logs }),
  reviewer: await createReviewerComponent({ config, logs })
});
// ECS stops a task with SIGTERM: the item in hand finishes, then the task exits and the rest wait for the next one
process.once("SIGTERM", () => job.stop());
const processed = await job.drain({
  maxRuntimeMs: ((await config.getNumber("MAX_RUNTIME_MINUTES")) ?? 55) * 60_000,
  emptyReceivesToExit: (await config.getNumber("EMPTY_RECEIVES_TO_EXIT")) ?? 2
});
log.info("review job done", { processed });
process.exit(0);
