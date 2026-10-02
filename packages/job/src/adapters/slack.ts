/**
 * The curators' view of a validation, since the job keeps nothing after it exits: one message per collection in the
 * channel, edited to its verdict at the end, and one thread reply per item as soon as it is validated — every finding,
 * the model's summary, the thumbnail and the worn views. Slack never decides the job's outcome: every failure only logs.
 */
import type { IConfigComponent, ILoggerComponent } from "@well-known-components/interfaces";
import type { CaptureRecord } from "@dcl-regenesislabs/wearable-validator";
import { groupFindings } from "../logic/group-findings.js";
import type { CollectionResultBody, ItemResult } from "../logic/review-job.js";
import type { ReviewItem, ValidationRequest } from "../logic/review-request.js";

const API = "https://slack.com/api";
const TIMEOUT_MS = 15_000;
// Slack's own 429 comes with retry-after in seconds; one wait is honoured, never a long stall
const MAX_RETRY_WAIT_MS = 60_000;
// Block Kit limits (api.slack.com/reference/block-kit): a message over them is refused whole
const HEADER_MAX = 150;
const SECTION_MAX = 3000;
const MAX_BLOCKS = 50;
const ALT_TXT_MAX = 1000;

type Block = Record<string, unknown>;

export interface SlackMessage {
  /** The plain-text fallback notifications show. */
  text: string;
  blocks: Block[];
}

export interface ItemNotice {
  item: ReviewItem;
  result: ItemResult;
  thumbnail?: Uint8Array;
  captures: CaptureRecord[];
}

export interface ISlackComponent {
  readonly enabled: boolean;
  /** The collection's message, posted when the job takes it; its ts threads the item replies. Undefined when it was not posted. */
  collectionStarted(request: ValidationRequest): Promise<string | undefined>;
  itemValidated(ts: string, notice: ItemNotice): Promise<void>;
  /** Edits the collection's message to its verdict and one line per item. */
  collectionFinished(ts: string, request: ValidationRequest, body: CollectionResultBody, ms: number): Promise<void>;
}

export interface SlackComponents {
  config: IConfigComponent;
  logs: ILoggerComponent;
  /** Injectable so tests record the calls; defaults to the global fetch. */
  fetch?: typeof globalThis.fetch;
}

export const escapeMrkdwn = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Slack links bare URLs and domains on its own: in creator- or model-written text a zero-width space keeps them plain
export const inertMrkdwn = (text: string): string => escapeMrkdwn(text).replace(/:\/\//g, ":​//").replace(/\.(?=[a-z])/gi, ".​");

/** Cuts on code points, so an emoji at the edge is dropped whole rather than left as half a surrogate pair. */
const cut = (text: string, max: number): string => {
  if (text.length <= max) return text;
  let kept = "";
  for (const point of Array.from(text)) {
    if (kept.length + point.length > max - 1) break;
    kept += point;
  }
  return kept + "…";
};

const section = (text: string): Block => ({ type: "section", text: { type: "mrkdwn", text: cut(text, SECTION_MAX) } });

/** Lines packed into as few sections as fit Slack's limit; past `maxBlocks` the rest is counted, not dropped silently. */
function sections(lines: string[], maxBlocks: number): Block[] {
  const blocks: Block[] = [];
  let current = "";
  let shown = 0;
  for (const line of lines) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length <= SECTION_MAX - 20) {
      current = next;
      shown++;
      continue;
    }
    if (current) blocks.push(section(current));
    if (blocks.length >= maxBlocks - 1) break;
    current = cut(line, SECTION_MAX - 20);
    shown++;
  }
  if (current && blocks.length < maxBlocks) blocks.push(section(current));
  if (shown < lines.length) blocks.push(section(`_+${lines.length - shown} more_`));
  return blocks;
}

export const itemName = (item: ReviewItem): string => (typeof item.metadata.name === "string" && item.metadata.name.trim()) || item.itemId;

function itemVerdict(result: ItemResult): string {
  if (result.passed === true) return "✅ Passed";
  if (result.passed === false) return "❌ Failed";
  if (result.unsupported) return "🧑‍⚖️ No verdict: the validator cannot judge this kind of item — a curator decides";
  return result.error ? "💥 Could not be validated" : "⚠️ No verdict: a visual check was not answered";
}

function collectionVerdict(body: CollectionResultBody): string {
  if (body.verdict === "passed") return "✅ Passed — every item passed";
  if (body.verdict === "rejected") return "❌ Rejected — one or more items failed";
  return body.reason === "unsupported" ? "🧑‍⚖️ Needs a curator — some items cannot be judged automatically" : "⚠️ Error — some items have no verdict; sending it again may decide them";
}

const counts = (result: ItemResult): string => {
  const errors = result.findings.filter((finding) => finding.severity === "error").length;
  const warnings = result.findings.length - errors;
  return `${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}`;
};

/** The collection's message: in progress while the job works, then the verdict and one line per item. */
export function collectionMessage(request: ValidationRequest, finished?: { body: CollectionResultBody; ms: number }): SlackMessage {
  const title = `Collection ${request.collectionId}`;
  const blocks: Block[] = [{ type: "header", text: { type: "plain_text", text: cut(title, HEADER_MAX) } }];
  const context = [`validation ${request.validationId}`, `${request.items.length} item${request.items.length === 1 ? "" : "s"}`];
  if (!finished) {
    blocks.push(section(`*Verdict* ⏳ Validating ${request.items.length} item${request.items.length === 1 ? "" : "s"} — each item's result arrives in this thread`));
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: cut(context.join(" · "), SECTION_MAX) }] });
    return { text: `${title} — validating`, blocks };
  }
  const { body, ms } = finished;
  const verdict = collectionVerdict(body);
  blocks.push(section(`*Verdict* ${verdict}`));
  const names = new Map(request.items.map((item) => [item.itemId, itemName(item)]));
  const lines = body.items.map((result) => `• *${inertMrkdwn(names.get(result.itemId) ?? result.itemId)}* — ${itemVerdict(result)} · ${counts(result)}`);
  blocks.push(...sections(lines, MAX_BLOCKS - 4));
  context.push(`rules v${body.rulesVersion}`, `${Math.round(ms / 1000)} s`);
  blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: cut(context.join(" · "), SECTION_MAX) }] });
  return { text: `${title} — ${verdict}`, blocks };
}

/** One item's reply: its verdict, what the model saw, and every finding, the ones both body shapes share told once. */
export function itemMessage(item: ReviewItem, result: ItemResult): SlackMessage {
  const name = itemName(item);
  const blocks: Block[] = [{ type: "header", text: { type: "plain_text", text: cut(name, HEADER_MAX) } }];
  const facts = [`*Verdict* ${itemVerdict(result)}`, `*Findings* ${counts(result)}`];
  if (result.error) facts.push(`*Why* ${inertMrkdwn(result.error)}`);
  blocks.push(section(facts.join("\n")));
  if (result.visualSummary) blocks.push(section(`*What the model saw*\n${result.visualSummary.split("\n").map((line) => `• ${inertMrkdwn(line)}`).join("\n")}`));
  const grouped = groupFindings(result.findings);
  const ordered = [...grouped.filter(({ finding }) => finding.severity === "error"), ...grouped.filter(({ finding }) => finding.severity !== "error")];
  const lines = ordered.map(({ finding, message, shapes, count }) => {
    const mark = finding.severity === "error" ? "❌" : "⚠️";
    const tail = shapes.length ? ` _(${escapeMrkdwn(shapes.join(", "))})_` : count > 1 ? ` _(×${count})_` : "";
    return `${mark} *${escapeMrkdwn(finding.check)}* (${escapeMrkdwn(finding.rule)}) — ${inertMrkdwn(message)}${tail}`;
  });
  blocks.push(...sections(lines, MAX_BLOCKS - blocks.length - 1));
  blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: cut(`item ${item.itemId} · content ${item.contentHash}`, SECTION_MAX) }] });
  return { text: `${name} — ${itemVerdict(result)}`, blocks };
}

/** One worn front view per body shape: the plain pose for a wearable, the middle of the clip for an emote; never a green-skin stress frame. */
export function frontViews(captures: CaptureRecord[]): CaptureRecord[] {
  const front = captures.filter(({ request }) => request.view === "avatar" && request.azimuthDegrees === 0 && !request.skin);
  const distance = (capture: CaptureRecord): number => (capture.request.timeFraction === undefined ? 0 : Math.abs(capture.request.timeFraction - 0.5));
  const best = new Map<string, CaptureRecord>();
  for (const capture of front) {
    const current = best.get(capture.request.bodyShape);
    if (!current || distance(capture) < distance(current)) best.set(capture.request.bodyShape, capture);
  }
  return [...best.values()];
}

export function slackError(method: string, code: string): Error {
  switch (code) {
    case "not_in_channel": return new Error("Invite the Slack app to the channel (/invite @app) or grant chat:write.public.");
    case "channel_not_found": return new Error("SLACK_CHANNEL is not a channel id the app can see.");
    case "invalid_auth":
    case "not_authed":
    case "token_expired": return new Error("SLACK_BOT_TOKEN is not a valid bot token.");
    case "missing_scope": return new Error("The Slack app needs the chat:write and files:write scopes.");
    default: return new Error(`Slack answered ${code} to ${method}.`);
  }
}

interface SlackAnswer {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function createSlackComponent(components: SlackComponents): Promise<ISlackComponent> {
  const { config, logs } = components;
  const fetchImpl = components.fetch ?? globalThis.fetch;
  const log = logs.getLogger("slack");
  const token = await config.getString("SLACK_BOT_TOKEN");
  const channel = await config.getString("SLACK_CHANNEL");
  if (!token) {
    log.info("slack notifications disabled: set SLACK_BOT_TOKEN and SLACK_CHANNEL to post every validated collection to a channel");
    return { enabled: false, collectionStarted: async () => undefined, itemValidated: async () => {}, collectionFinished: async () => {} };
  }
  if (!channel) throw new Error("SLACK_CHANNEL must be the id of the channel (C…) the validations go to when SLACK_BOT_TOKEN is set.");
  const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

  async function send(url: string, init: RequestInit, retried = false): Promise<Response> {
    const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.status === 429 && !retried) {
      const seconds = Number(res.headers.get("retry-after") ?? "1");
      await sleep(Math.min(Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 1000, MAX_RETRY_WAIT_MS));
      return send(url, init, true);
    }
    return res;
  }

  /** One Web API method; JSON unless a URLSearchParams body is given (the file upload handshake is form-encoded). */
  async function call(method: string, body: Record<string, unknown> | URLSearchParams): Promise<SlackAnswer> {
    const form = body instanceof URLSearchParams;
    const res = await send(`${API}/${method}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": form ? "application/x-www-form-urlencoded" : "application/json; charset=utf-8" },
      body: form ? body.toString() : JSON.stringify(body)
    });
    if (!res.ok) throw new Error(`Slack answered HTTP ${res.status} to ${method}.`);
    const answer: unknown = await res.json();
    if (!answer || typeof answer !== "object" || typeof (answer as SlackAnswer).ok !== "boolean") throw new Error(`Slack answered something that is not a Web API result to ${method}.`);
    const result = answer as SlackAnswer;
    if (!result.ok) throw slackError(method, result.error ?? "an unknown error");
    return result;
  }

  /** The first two steps of Slack's external upload: the file exists, not yet shared anywhere. */
  async function upload(filename: string, bytes: Uint8Array, alt: string): Promise<{ id: string; title: string }> {
    const ticket = await call("files.getUploadURLExternal", new URLSearchParams({ filename, length: String(bytes.byteLength), alt_txt: cut(alt, ALT_TXT_MAX) }));
    const uploadUrl = ticket.upload_url;
    const fileId = ticket.file_id;
    if (typeof uploadUrl !== "string" || typeof fileId !== "string") throw new Error("Slack answered files.getUploadURLExternal without an upload_url and file_id.");
    // a fresh Uint8Array sits on a plain ArrayBuffer, which is what fetch's BodyInit accepts
    const body = new Uint8Array(bytes.byteLength);
    body.set(bytes);
    const put = await send(uploadUrl, { method: "POST", headers: { "content-type": "application/octet-stream" }, body });
    if (!put.ok) throw new Error(`Slack answered HTTP ${put.status} to the file upload.`);
    return { id: fileId, title: alt };
  }

  /** The thumbnail and the worn front views, shared into the thread: the one way Slack shows a file an app uploaded. */
  async function shareImages(ts: string, { item, thumbnail, captures }: ItemNotice): Promise<void> {
    const name = itemName(item);
    const files: { id: string; title: string }[] = [];
    if (thumbnail) files.push(await upload("thumbnail.png", thumbnail, `${name} thumbnail`));
    for (const view of frontViews(captures)) files.push(await upload(`${view.request.id}.png`, view.bytes, `${name} worn, ${view.request.bodyShape}`));
    if (files.length === 0) return;
    await call("files.completeUploadExternal", { files, channel_id: channel, thread_ts: ts, initial_comment: `${name}: thumbnail and rendered views` });
  }

  return {
    enabled: true,
    async collectionStarted(request) {
      try {
        const message = collectionMessage(request);
        const ts = (await call("chat.postMessage", { channel, text: message.text, unfurl_links: false, unfurl_media: false, blocks: message.blocks })).ts;
        if (typeof ts !== "string") throw new Error("Slack answered chat.postMessage without a ts.");
        log.info("slack collection posted", { validation: request.validationId, ts });
        return ts;
      } catch (error) {
        log.warn("slack collection message failed: no thread for this collection", { validation: request.validationId, reason: reason(error) });
        return undefined;
      }
    },
    async itemValidated(ts, notice) {
      try {
        const message = itemMessage(notice.item, notice.result);
        await call("chat.postMessage", { channel, thread_ts: ts, text: message.text, unfurl_links: false, unfurl_media: false, blocks: message.blocks });
      } catch (error) {
        log.warn("slack item reply failed", { item: notice.item.itemId, reason: reason(error) });
        return;
      }
      await shareImages(ts, notice).catch((error: unknown) => log.warn("slack item images failed", { item: notice.item.itemId, reason: reason(error) }));
    },
    async collectionFinished(ts, request, body, ms) {
      try {
        const message = collectionMessage(request, { body, ms });
        await call("chat.update", { channel, ts, text: message.text, blocks: message.blocks });
      } catch (error) {
        log.warn("slack collection verdict failed", { validation: request.validationId, reason: reason(error) });
      }
    }
  };
}
