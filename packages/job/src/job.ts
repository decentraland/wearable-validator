/**
 * The validation job: drains the work queue of collections published in the Builder, validates every item, posts
 * one result per collection back to the Builder, and exits once the queue is empty, so its task scales to zero.
 */
import { resolve } from "node:path";
import { composeConfigProviders, createConfigComponent, createDotEnvConfigComponent } from "@well-known-components/env-config-provider";
import { createJsonLogComponent, createLogComponent } from "@well-known-components/logger";
import { createBuilderComponent } from "./adapters/builder.js";
import { createRendererComponent } from "./adapters/renderer.js";
import { createReviewer } from "./adapters/reviewer.js";
import { createSlackComponent } from "./adapters/slack.js";
import { createWorkQueueComponent } from "./adapters/work-queue.js";
import { createReviewJob } from "./logic/review-job.js";

const config = composeConfigProviders(createConfigComponent(process.env), await createDotEnvConfigComponent({ path: [resolve(import.meta.dirname, "../.env.default")] }));
// LOG_FORMAT=json: one JSON line per event, so the host's collector ships them unchanged
const logs = (await config.getString("LOG_FORMAT")) === "json" ? await createJsonLogComponent({ config }) : await createLogComponent({ config });
const job = createReviewJob({
  logs,
  queue: await createWorkQueueComponent({ config }),
  builder: await createBuilderComponent({ config, logs }),
  renderer: await createRendererComponent({ config, logs }),
  reviewer: await createReviewer({ config, logs }),
  slack: await createSlackComponent({ config, logs })
});
// ECS stops a task with SIGTERM: the collection in hand finishes, then the task exits and the rest wait for the next one
process.once("SIGTERM", () => job.stop());
await job.drain({
  maxRuntimeMs: ((await config.getNumber("MAX_RUNTIME_MINUTES")) ?? 55) * 60_000,
  emptyReceivesToExit: (await config.getNumber("EMPTY_RECEIVES_TO_EXIT")) ?? 2
});
process.exit(0);
