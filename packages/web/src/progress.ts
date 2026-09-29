/**
 * Progress models with no React in them, so node tests cover them: the code-check stepper over the library's
 * ProgressEvents, and the visual-review stepper over the run server's SSE events. Every step is `{ label, state,
 * detail }` — the server's free-text stage strings never reach the screen.
 */
import { checks as checkRegistry, type CheckResult, type Finding, type Group, type ProgressEvent, type Result } from "@dcl-regenesislabs/wearable-validator";
import type { CaptureEvent, CheckRow, QueuePosition, ReviewEvent, RunEvent, WireResult } from "./api.js";
import { waitText } from "./run-list.js";

export const GROUP_LABELS: Record<Group, string> = {
  files: "Files & metadata",
  model: "3D model",
  emote: "Animation",
  content: "Content",
  rendering: "Rendering"
};
/** The groups the browser runs, in registry order. */
export const CODE_GROUPS: Group[] = ["files", "model", "emote", "content"];
/** Every group the results page lists, the visual one last. */
export const GROUP_ORDER: Group[] = [...CODE_GROUPS, "rendering"];

export type StepState = "todo" | "active" | "done" | "warning" | "skipped" | "failed";

export interface Step {
  key: string;
  label: string;
  state: StepState;
  detail?: string;
}

export const STATE_WORD: Record<StepState, string> = {
  done: "done",
  warning: "needs attention",
  active: "in progress",
  todo: "not started",
  skipped: "not applicable",
  failed: "failed"
};

/** What the stepper's live region says: it changes only when a step changes state, so per-check and per-view counters stay silent. */
export function stepAnnouncement(steps: Step[]): string {
  const active = steps.find((step) => step.state === "active");
  if (active) return `${active.label} ${STATE_WORD.active}`;
  const last = [...steps].reverse().find((step) => step.state !== "todo");
  return last ? `${last.label} ${STATE_WORD[last.state]}` : "";
}

export const checkTitle = (check: string): string => checkRegistry[check]?.title ?? check;
export const isVisual = (check: string): boolean => checkRegistry[check]?.group === "rendering";
const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? "" : "s"}`;

/**
 * One step per code group in registry order. Checks that do not apply never emit an event, so a group with none by
 * the time a later group starts (or the run ends) is "not applicable" — counts are shown as done, never n/N.
 */
export function codeSteps(events: ProgressEvent[], finished = false): Step[] {
  const running = new Map<Group, string>();
  const done = new Map<Group, number>();
  let current: Group | null = null;
  for (const event of events) {
    if (event.type === "check-started") {
      running.set(event.group, event.check);
      current = event.group;
    } else done.set(event.result.group, (done.get(event.result.group) ?? 0) + 1);
  }
  const currentIndex = current ? CODE_GROUPS.indexOf(current) : -1;
  return CODE_GROUPS.map((group, index) => {
    const label = GROUP_LABELS[group];
    const finishedCount = done.get(group) ?? 0;
    const check = running.get(group);
    if (check === undefined) {
      return finished || index < currentIndex ? { key: group, label, state: "skipped", detail: "Not applicable" } : { key: group, label, state: "todo" };
    }
    if (group === current && !finished) {
      return { key: group, label, state: "active", detail: finishedCount > 0 ? `Checking ${checkTitle(check)} · ${finishedCount} done` : `Checking ${checkTitle(check)}` };
    }
    return { key: group, label, state: "done", detail: count(finishedCount, "check") };
  });
}

// ── the visual review ────────────────────────────────────────────────────────

/** The server's events plus the three the browser adds: the upload (or reference) it sends and the cancel it asks for. */
export type VisualEvent =
  | RunEvent
  | { type: "upload-started"; reference?: boolean }
  | { type: "upload-finished"; id: string }
  | { type: "cancel-requested" };

export type VisualPhase = "idle" | "uploading" | "gate" | "queued" | "rendering" | "reviewing" | "done" | "failed" | "cancelled";

export type ReviewRequest = Extract<ReviewEvent, { phase: "request" }>;
export type ReviewAnswer = Extract<ReviewEvent, { phase: "answer" }>;
export interface Review {
  request?: ReviewRequest;
  answer?: ReviewAnswer;
}

export interface VisualState {
  phase: VisualPhase;
  id?: string;
  /** The run started from a published item's reference: the server fetches it instead of taking an upload. */
  reference: boolean;
  /** The URN or URL a reference run was started from, once its done event says it. */
  itemReference?: string;
  /** Files fetched so far, from the server's fetch stages. */
  fetched?: { done?: number; total?: number };
  /** The server's own code run, once the gate event lands (or the done event of a finished run carries it). */
  gate?: Result;
  gateChecks: number;
  gateCurrent?: string;
  queue?: QueuePosition;
  waited: boolean;
  /** Planned capture count from the render stage; unknown on older servers until the photos arrive. */
  views?: number;
  bodyShapes?: string[];
  captures: CaptureEvent[];
  reviews: Record<string, Review>;
  /** Checks the model was asked about, in order. */
  asked: string[];
  rows: Map<string, CheckRow>;
  result?: WireResult;
  /** The run ended without a visual result: the code gate stopped it, or an old run has none saved. */
  skipped: boolean;
  message?: string;
  /** The kept upload, once the run is done; absent on runs older than the server that keeps it. */
  zipUrl?: string;
  cancelling: boolean;
  /** Where a failed or cancelled run was when it stopped. */
  stoppedDuring?: VisualPhase;
}

export const EMPTY_VISUAL: VisualState = { phase: "idle", reference: false, gateChecks: 0, waited: false, captures: [], reviews: {}, asked: [], rows: new Map(), skipped: false, cancelling: false };

export function reduceVisual(state: VisualState, event: VisualEvent): VisualState {
  switch (event.type) {
    case "upload-started":
      return { ...EMPTY_VISUAL, phase: "uploading", reference: event.reference === true };
    case "upload-finished":
      // a reference run is still fetching the item after the server accepted it
      return { ...state, phase: state.reference ? "uploading" : "gate", id: event.id };
    case "cancel-requested":
      return { ...state, cancelling: true };
    case "check": {
      const data = event.data;
      if (data.type === "check-started") {
        if (data.group === "rendering") return state;
        const phase = state.phase === "idle" || state.phase === "uploading" ? "gate" : state.phase;
        return { ...state, phase, gateCurrent: data.check };
      }
      if (data.result.group !== "rendering") return { ...state, gateChecks: state.gateChecks + 1 };
      const rows = new Map(state.rows);
      rows.set(data.result.check, { ...data.result, findings: data.findings });
      return { ...state, rows };
    }
    case "gate":
      return { ...state, phase: "gate", gate: event.data.result, gateCurrent: undefined };
    case "queue":
      return event.data.position === 0 ? { ...state, phase: "rendering", queue: event.data } : { ...state, phase: "queued", waited: true, queue: event.data };
    case "stage":
      if (event.data.kind === "fetch") {
        const before = state.phase === "idle" || state.phase === "uploading" || state.phase === "gate";
        return { ...state, phase: before ? "uploading" : state.phase, reference: true, fetched: { done: event.data.done, total: event.data.total } };
      }
      return {
        ...state,
        phase: state.phase === "reviewing" ? state.phase : "rendering",
        // the server says 0 when it could not plan the recipe: an unknown count, not zero views
        ...(event.data.views ? { views: event.data.views } : {}),
        ...(event.data.bodyShapes ? { bodyShapes: event.data.bodyShapes } : {})
      };
    case "capture": {
      const captures = state.captures.filter((capture) => capture.id !== event.data.id);
      return { ...state, phase: state.phase === "reviewing" ? state.phase : "rendering", captures: [...captures, event.data] };
    }
    case "review": {
      const current = state.reviews[event.data.check] ?? {};
      const reviews = { ...state.reviews, [event.data.check]: event.data.phase === "request" ? { ...current, request: event.data } : { ...current, answer: event.data } };
      const asked = state.asked.includes(event.data.check) ? state.asked : [...state.asked, event.data.check];
      return { ...state, phase: "reviewing", reviews, asked };
    }
    case "done": {
      // a finished run loaded from disk replays only this event, so its photos arrive inside the result
      const known = new Set(state.captures.map((capture) => capture.id));
      const replayed = (event.data.result?.captures ?? [])
        .filter(({ request }) => !known.has(request.id))
        .map(({ request, sha256, url }): CaptureEvent => ({ id: request.id, request, sha256, url }));
      return {
        ...state,
        phase: "done",
        reference: event.data.reference !== undefined || state.reference,
        itemReference: event.data.reference ?? state.itemReference,
        captures: [...state.captures, ...replayed],
        gate: event.data.gate ?? state.gate,
        result: event.data.result,
        skipped: event.data.skipped === true,
        message: event.data.message,
        zipUrl: event.data.zipUrl
      };
    }
    case "error":
      return { ...state, phase: state.cancelling ? "cancelled" : "failed", stoppedDuring: state.phase, message: event.data.message, zipUrl: event.data.zipUrl };
  }
}

/** Everything of a code result but the captures: the browser's own run, the server's gate, or a done event's result. */
export type CodeResult = Omit<Result, "captures">;

/** The code checks of a run: the saved gate, or the code result a run stopped at the gate ends with. Undefined when nothing was kept. */
export function codeResultOf(state: VisualState): CodeResult | undefined {
  if (state.gate) return state.gate;
  return state.skipped && state.result ? state.result : undefined;
}

/** The category a gate finding names, when any does; History has no metadata to read it from. */
export function categoryOf(result: CodeResult | null | undefined): string | undefined {
  return itemContextOf(result).category;
}

/** What the gate findings say about the item — its category and hidden slots — so History shows the same limits Validate does. */
export function itemContextOf(result: CodeResult | null | undefined): { category?: string; hides?: string[] } {
  const context: { category?: string; hides?: string[] } = {};
  for (const finding of result?.findings ?? []) {
    const { category, hides } = finding.data ?? {};
    if (context.category === undefined && typeof category === "string" && category) context.category = category;
    if (context.hides === undefined && Array.isArray(hides) && hides.every((slot) => typeof slot === "string")) context.hides = hides;
  }
  return context;
}

/** The Rendering group has something to show: rows, photos, or a renderer at work. */
export const renderingGroupShown = (state: VisualState): boolean =>
  visualRows(state).length > 0 || state.captures.length > 0 || state.phase === "rendering" || state.phase === "reviewing";

/** The rendering-group rows of a run; a run that stopped at the code gate carries the code result, which is not shown here. */
export function visualRows(state: VisualState): CheckRow[] {
  if (state.result) {
    const findings = state.result.findings;
    return state.result.checks.filter((row) => isVisual(row.check)).map((row) => ({ ...row, findings: findings.filter((finding) => finding.check === row.check) }));
  }
  return [...state.rows.values()].filter((row) => isVisual(row.check));
}

export function visualFindings(state: VisualState): Finding[] {
  return visualRows(state).flatMap((row) => row.findings);
}

/** The verdict of rendering rows alone: every row passed or warned → true, any failed → false, otherwise unknown. */
export function visualVerdict(rows: CheckResult[]): boolean | null {
  if (rows.length === 0) return null;
  if (rows.some((row) => row.status === "failed")) return false;
  return rows.every((row) => row.status === "passed" || row.status === "warning") ? true : null;
}

export function verdictWord(passed: boolean | null): string {
  if (passed === null) return "No verdict";
  return passed ? "Passed" : "Needs attention";
}

export type Verdict = "passed" | "failed" | "incomplete";

/** The stamp over the results: code and visual rows together — "passed" only when every row passed or warned. */
export function combinedVerdict(code: Pick<Result, "passed">, visual: CheckResult[]): Verdict {
  if (code.passed === null) return "incomplete";
  if (code.passed === false) return "failed";
  if (visual.some((row) => row.status === "failed")) return "failed";
  if (visual.some((row) => row.status === "skipped" || row.status === "errored")) return "incomplete";
  return "passed";
}

/**
 * The model calls a run makes: the server's AI checks, minus the one that does not apply to this item type. The two
 * quality checks are the only type-specific AI checks (visual-quality for wearables, emote-quality for emotes).
 */
export function expectedReviews(aiChecks: string[], itemType: "wearable" | "emote" | null): number {
  if (!itemType) return aiChecks.length;
  return aiChecks.filter((check) => (itemType === "emote" ? check !== "visual-quality" : check !== "emote-quality")).length;
}

/** What the gate's code result says the item is; null until it lands. */
export function itemTypeOf(state: VisualState): "wearable" | "emote" | null {
  const rows = state.gate?.checks ?? state.result?.checks;
  if (!rows || rows.length === 0) return null;
  return rows.some((row) => row.group === "emote") ? "emote" : "wearable";
}

/** Step index each phase is at; done sits past the last step so every step reads as done. */
const PHASE_RANK: Record<VisualPhase, number> = { idle: -1, uploading: 0, gate: 1, queued: 2, rendering: 3, reviewing: 4, done: 6, failed: -1, cancelled: -1 };
const STEP_KEYS = ["upload", "gate", "queue", "render", "review", "verdict"] as const;
const STEP_LABELS: Record<(typeof STEP_KEYS)[number], string> = {
  upload: "Uploading",
  gate: "Code checks re-run on the server",
  queue: "In line",
  render: "Rendering",
  review: "Asking the model",
  verdict: "Verdict"
};
/** The first step of a reference run: the server fetches the item instead of taking an upload. */
const FETCH_LABEL = "Fetching from the catalyst";

/** The six steps of a visual review, from the reduced state. `aiChecks` are the server's model-backed checks. */
export function visualStepsOf(state: VisualState, aiChecks: string[]): Step[] {
  const halted = state.phase === "failed" || state.phase === "cancelled";
  // a run refused before any event (stoppedDuring "idle") fails at the first step
  const at = halted ? Math.max(0, PHASE_RANK[state.stoppedDuring ?? "uploading"]) : PHASE_RANK[state.phase];
  const stateAt = (rank: number): StepState => (halted && rank === at ? "failed" : rank < at ? "done" : rank === at ? "active" : "todo");
  const rows = visualRows(state);
  const askedCount = state.asked.length || rows.filter((row) => row.review).length;
  const answered = Object.values(state.reviews).filter((review) => review.answer?.ok).length || rows.filter((row) => row.review && row.status !== "errored").length;
  const expected = Math.max(expectedReviews(aiChecks, itemTypeOf(state)), askedCount);
  const current = state.asked.at(-1);
  const stoppedMessage = halted ? state.message ?? (state.phase === "cancelled" ? "The run was cancelled." : "The run failed.") : undefined;

  const gate: Step = { key: "gate", label: STEP_LABELS.gate, state: stateAt(1) };
  if (gate.state === "active") gate.detail = state.gateCurrent ? `Checking ${checkTitle(state.gateCurrent)}${state.gateChecks > 0 ? ` · ${state.gateChecks} done` : ""}` : "Starting";
  else if (gate.state === "done") {
    // a green check beside "did not pass" reads as a contradiction: the item went on only because the creator asked
    if (state.gate?.passed === false) {
      gate.state = "warning";
      gate.detail = `Did not pass · ${count(state.gate.summary.errors, "error")} · rendered anyway`;
    } else gate.detail = state.gate ? (state.gate.passed === true ? "Passed" : count(state.gateChecks, "check")) : state.gateChecks > 0 ? count(state.gateChecks, "check") : undefined;
  }

  const queue: Step = { key: "queue", label: STEP_LABELS.queue, state: stateAt(2) };
  if (queue.state === "active" && state.queue) {
    const eta = waitText(state.queue.etaMs);
    queue.detail = `${state.queue.ahead === 0 ? "Next up" : `${state.queue.ahead} ahead`}${eta ? ` · ${eta}` : ""}`;
  } else if (queue.state === "done" && !state.waited) queue.detail = "No wait";

  const render: Step = { key: "render", label: STEP_LABELS.render, state: stateAt(3) };
  const shot = state.captures.length;
  if (render.state === "active") render.detail = shot === 0 && state.views === undefined ? "Starting the renderer" : state.views !== undefined ? `${shot}/${state.views} views` : count(shot, "view");
  else if (render.state === "done") render.detail = count(shot, "view");

  const review: Step = { key: "review", label: STEP_LABELS.review, state: stateAt(4) };
  if (review.state === "active" && current) review.detail = `${checkTitle(current)} (${state.asked.length}/${expected})`;
  else if (review.state === "done") review.detail = answered > 0 ? count(answered, "answer") : askedCount > 0 ? `${count(askedCount, "check")} asked · no answer` : "Model not asked";

  const verdict: Step = { key: "verdict", label: STEP_LABELS.verdict, state: stateAt(5) };
  if (verdict.state === "done") {
    const passed = visualVerdict(rows);
    verdict.detail = verdictWord(passed);
    if (passed !== true) verdict.state = "warning";
  }

  const upload: Step = { key: "upload", label: state.reference ? FETCH_LABEL : STEP_LABELS.upload, state: stateAt(0) };
  const { done: fetchedDone, total: fetchedTotal } = state.fetched ?? {};
  if (upload.state === "active" && fetchedTotal !== undefined) upload.detail = `${fetchedDone ?? 0}/${fetchedTotal} files`;
  else if (upload.state === "done" && state.reference && fetchedTotal !== undefined) upload.detail = count(fetchedTotal, "file");

  const steps: Step[] = [upload, gate, queue, render, review, verdict];
  if (halted) {
    const failed = steps.find((step) => step.state === "failed");
    if (failed) failed.detail = stoppedMessage;
  }
  if (state.phase === "done" && state.skipped) {
    // stopped at the code gate (the result is the code run), or an old run with nothing saved
    if (state.result) {
      gate.state = "failed";
      gate.detail = state.message ?? "The code checks did not pass, so nothing was rendered.";
      for (const step of [queue, render, review, verdict]) {
        step.state = "todo";
        delete step.detail;
      }
    } else {
      // nothing saved says what ran: only the upload (the zip exists) is known
      for (const step of [gate, queue, render, review]) {
        step.state = "skipped";
        delete step.detail;
      }
      verdict.state = "failed";
      verdict.detail = state.message ?? "This run finished without a saved result.";
    }
  }
  return steps;
}

/** The stepper straight from an event list — what the tests feed. */
export function visualSteps(events: VisualEvent[], aiChecks: string[]): Step[] {
  return visualStepsOf(events.reduce(reduceVisual, EMPTY_VISUAL), aiChecks);
}

export const isRunning = (phase: VisualPhase): boolean => phase !== "idle" && phase !== "done" && phase !== "failed" && phase !== "cancelled";
