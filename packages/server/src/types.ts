import type { IFetchComponent, IHttpServerComponent } from "@dcl/core-commons";
import type { IBaseComponent, IConfigComponent, ILoggerComponent, IMetricsComponent } from "@well-known-components/interfaces";
import type { CaptureRecord, ItemType, Result } from "@dcl-regenesislabs/wearable-validator";
import type { IIdentityComponent } from "./adapters/identity.js";
import type { ILogBufferComponent } from "./adapters/log-buffer.js";
import type { IRendererComponent } from "./adapters/renderer.js";
import type { IReviewerComponent } from "./adapters/reviewer.js";
import type { IBuildInfoComponent } from "./adapters/build-info.js";
import type { ICatalystComponent } from "./adapters/catalyst.js";
import type { ISiteComponent } from "./adapters/site.js";
import type { ISlackComponent } from "./adapters/slack.js";
import type { IQueueComponent } from "./logic/queue.js";
import type { IRunStoreComponent } from "./logic/run-store.js";
import type { IRunsComponent } from "./logic/runs.js";
import type { metricDeclarations } from "./metrics.js";

export type GlobalContext = {
  components: BaseComponents;
};

export type BaseComponents = {
  config: IConfigComponent;
  logs: ILoggerComponent;
  logBuffer: ILogBufferComponent;
  server: IHttpServerComponent<GlobalContext>;
  metrics: IMetricsComponent<keyof typeof metricDeclarations> & { registry: IMetricsComponent.Registry };
  identity: IIdentityComponent;
  renderer: IRendererComponent;
  reviewer: IReviewerComponent;
  catalyst: ICatalystComponent;
  runStore: IRunStoreComponent;
  queue: IQueueComponent;
  runs: IRunsComponent;
  site: ISiteComponent;
  slack: ISlackComponent;
  buildInfo: IBuildInfoComponent;
};

export type AppComponents = BaseComponents & {
  statusChecks: IBaseComponent;
};

export type TestComponents = BaseComponents & {
  localFetch: IFetchComponent;
};

export type HandlerContextWithPath<ComponentNames extends keyof AppComponents, Path extends string = string> = IHttpServerComponent.PathAwareContext<
  IHttpServerComponent.DefaultContext<{ components: Pick<AppComponents, ComponentNames> }>,
  Path
>;

export type Context<Path extends string = string> = IHttpServerComponent.PathAwareContext<GlobalContext, Path>;

export interface Identity {
  owner: string;
  kind: "local" | "access" | "service";
  /** Sees every run, the stats and the log: everyone Cloudflare Access lets in, service tokens (the Slack bot) and local runs. */
  operator: boolean;
  /** Service identities read everything and change nothing: they never start or cancel a run. */
  readOnly: boolean;
}

export type RunEventType = "check" | "gate" | "stage" | "queue" | "capture" | "review" | "done" | "error";

export interface RunEvent {
  id: number;
  type: RunEventType;
  data: unknown;
}

export interface RunSink {
  id: string;
  dir: string;
  emit(type: RunEventType, data: unknown): void;
  capture(capture: CaptureRecord): Promise<void>;
}

/** One of the caller's runs, as GET /api/runs lists them; `owner` only when an operator asked for everyone's. */
export interface RunSummary {
  id: string;
  name: string;
  startedAt: number;
  done: boolean;
  passed: boolean | null;
  queued: boolean;
  owner?: string;
}

/** position 0 means running. */
export interface QueuePosition {
  position: number;
  ahead: number;
  running: number;
  averageRunMs: number | null;
  etaMs: number | null;
}

export interface QueueEntry {
  position: number;
  mine: boolean;
  /** Only your own items are named; another curator's item is just "an item". */
  id?: string;
  name?: string;
  since: number;
}

export interface QueueState {
  running: QueueEntry[];
  waiting: QueueEntry[];
  averageRunMs: number | null;
  maxConcurrentRuns: number;
}

/** How a run ended: the label runs_finished_total counts, minus "cancelled" (a cancelled run tells nobody). */
export type RunOutcome = "passed" | "failed" | "no-verdict" | "gate" | "error";

/** What a curator must do next, computed from the code gate and the visual review (logic/decision.ts). */
export interface CuratorDecision {
  /** ready: nothing found, a curator glances at the views; review: something needs a curator's judgement; blocked: the creator must fix errors first. */
  state: "ready" | "review" | "blocked";
  /** Short phrases in the order they were found: "2 warnings", "thumbnail-honesty: mismatch", "file-size: The item totals 4.03 MB; the limit for an emote is 3 MB". */
  reasons: string[];
}

/** The item as its metadata names it; only what NormalizedItem has. */
export interface RunItem {
  name?: string;
  category?: string;
  itemType: ItemType;
  rarity?: string;
}

/** Everything a notification (Slack today) needs about a run that just concluded; built once in conclude(). */
export interface RunNotice {
  id: string;
  owner: string;
  name: string;
  dir: string;
  startedAt: number;
  beganAt?: number;
  finishedAt: number;
  outcome: RunOutcome;
  passed: boolean | null;
  decision: CuratorDecision;
  gate?: Result;
  visual?: Result;
  item?: RunItem;
  error?: string;
  /** Relative "/api/runs/<id>/input.zip", present when the upload is still in the run folder. */
  zipUrl?: string;
  /** The URN the item was fetched under when the run started from a marketplace reference instead of an upload. */
  reference?: string;
}
