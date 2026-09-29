/** One Slack message per finished run in the curators' channel: verdict, whether a curator is needed, a button to the run, the thumbnail; the thumbnail and worn views in its thread. */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { IConfigComponent, ILoggerComponent } from "@well-known-components/interfaces";
import { manifest, type CaptureRecord, type Finding } from "@dcl-regenesislabs/wearable-validator";
import type { RunNotice } from "../types.js";
import { appLogger } from "./log-buffer.js";

const API = "https://slack.com/api";
const TIMEOUT_MS = 15_000;
// Slack's own 429 comes with retry-after in seconds; one wait is honoured, never a long stall in a fire-and-forget path
const MAX_RETRY_WAIT_MS = 60_000;
// Block Kit limits (api.slack.com/reference/block-kit): a message over them is refused whole
const HEADER_MAX = 150;
const SECTION_MAX = 3000;
const BUTTON_MAX = 75;
const ALT_TEXT_MAX = 2000;
const ALT_TXT_MAX = 1000;
const MAX_FINDINGS = 5;
// a file shared a moment ago may still be processing when the message is edited to show it
const THUMBNAIL_RETRY_MS = 3000;

export interface ISlackComponent {
  readonly enabled: boolean;
  readonly channel?: string;
  /** Rejects with an actionable sentence when Slack refused the message; images that could not be shared only log. */
  notify(notice: RunNotice): Promise<void>;
}

export interface SlackComponents {
  config: IConfigComponent;
  logs: ILoggerComponent;
  /** Injectable so tests record the calls; defaults to the global fetch. */
  fetch?: typeof globalThis.fetch;
}

type Block = Record<string, unknown>;

export const escapeMrkdwn = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Slack links bare URLs and domains on its own: in creator- or model-written text a zero-width space keeps them plain
export const inertMrkdwn = (text: string): string => escapeMrkdwn(text).replace(/:\/\//g, ":\u200b//").replace(/\.(?=[a-z])/gi, ".\u200b");

/** Cuts on code points, so an emoji at the edge is dropped whole rather than left as half a surrogate pair. */
const cut = (text: string, max: number): string => {
  if (text.length <= max) return text;
  const points = Array.from(text);
  let kept = "";
  for (const point of points) {
    if (kept.length + point.length > max - 1) break;
    kept += point;
  }
  return kept + "…";
};

export const displayName = (notice: RunNotice): string => notice.item?.name?.trim() || notice.name.replace(/\.zip$/i, "");

function verdictLine(notice: RunNotice): string {
  switch (notice.outcome) {
    case "passed": return "✅ Passed";
    case "failed": return "❌ Failed";
    case "no-verdict": return "⚠️ No verdict";
    case "gate": return "❌ Failed the code checks";
    case "error": return "💥 The run failed";
  }
}

function approvalLine(notice: RunNotice): string {
  const reasons = notice.decision.reasons.join(", ");
  switch (notice.decision.state) {
    // text painted on a texture can talk the model into "ok": a clean review never stands in for a curator's look
    case "ready": return "✅ Nothing found — look at the views before approving";
    case "review": return `👀 Needs a curator: ${reasons}`;
    case "blocked": return `⛔ Blocked: ${reasons}`;
  }
}

/** The marketplace page of a collections-v2 URN (chain, contract, item id); undefined for any other URN shape. */
export function marketplaceUrl(urn: string): string | undefined {
  const match = /^urn:decentraland:(matic|ethereum|amoy):collections-v2:(0x[0-9a-f]{40}):(\d+)$/i.exec(urn);
  if (!match) return undefined;
  // amoy items are listed on decentraland.zone, the test network's marketplace
  const host = match[1].toLowerCase() === "amoy" ? "decentraland.zone" : "decentraland.org";
  return `https://${host}/marketplace/contracts/${match[2].toLowerCase()}/items/${match[3]}`;
}

function itemLine(notice: RunNotice): string {
  const parts = notice.item ? [notice.item.category, notice.item.itemType, notice.item.rarity].filter((part): part is string => Boolean(part)) : [];
  const line = `${inertMrkdwn(displayName(notice))}${parts.length ? ` (${escapeMrkdwn(parts.join(" · "))})` : ""}`;
  if (!notice.reference) return line;
  const url = marketplaceUrl(notice.reference);
  return `${line} · from the marketplace ${url ? `<${url}|${escapeMrkdwn(notice.reference)}>` : `\`${escapeMrkdwn(notice.reference)}\``}`;
}

/** Errors before warnings, gate before visual, the same finding once however many body shapes repeat it; at most
 * MAX_FINDINGS bullet lines within one section's limit. */
function findingsSection(notice: RunNotice): Block | undefined {
  const unique = new Map<string, { finding: Finding; times: number }>();
  for (const finding of [...(notice.gate?.findings ?? []), ...(notice.visual?.findings ?? [])]) {
    const key = `${finding.check}\n${finding.severity}\n${finding.message}`;
    const seen = unique.get(key);
    if (seen) seen.times++;
    else unique.set(key, { finding, times: 1 });
  }
  const all = [...unique.values()];
  if (all.length === 0) return undefined;
  const ordered = [...all.filter(({ finding }) => finding.severity === "error"), ...all.filter(({ finding }) => finding.severity !== "error")];
  const bullet = ({ finding, times }: { finding: Finding; times: number }): string =>
    `• *${escapeMrkdwn(finding.check)}* — ${inertMrkdwn(finding.message)}${times > 1 ? ` _(×${times})_` : ""}`;
  const lines: string[] = [];
  let shown = 0;
  for (const entry of ordered.slice(0, MAX_FINDINGS)) {
    const line = bullet(entry);
    // leave room for the "+N more" line whatever gets cut
    if ([...lines, line].join("\n").length > SECTION_MAX - 20) break;
    lines.push(line);
    shown++;
  }
  if (shown === 0) lines.push(cut(bullet(ordered[0]), SECTION_MAX - 20));
  const rest = all.length - Math.max(shown, 1);
  if (rest > 0) lines.push(`_+${rest} more_`);
  return { type: "section", text: { type: "mrkdwn", text: lines.join("\n") } };
}

function contextLine(notice: RunNotice): string {
  const pieces = [`run ${notice.id}`, `rules v${manifest.version}`];
  if (notice.beganAt !== undefined) pieces.push(`rendered in ${Math.round((notice.finishedAt - notice.beganAt) / 1000)} s`);
  const costs = (notice.visual?.checks ?? []).map((row) => row.review?.usage?.cost).filter((cost): cost is number => typeof cost === "number");
  if (costs.length) pieces.push(`$${costs.reduce((sum, cost) => sum + cost, 0).toFixed(4)}`);
  return pieces.join(" · ");
}

export interface RunMessage {
  /** The plain-text fallback notifications show. */
  text: string;
  blocks: Block[];
}

/** The Block Kit message for a run; pure, so its shape is tested without Slack. siteUrl "" leaves out the button: Slack refuses a relative link. */
export function runMessage(notice: RunNotice, siteUrl: string, fileId?: string): RunMessage {
  const name = displayName(notice);
  const verdict = verdictLine(notice);
  const approval = approvalLine(notice);
  const blocks: Block[] = [
    { type: "header", text: { type: "plain_text", text: cut(name, HEADER_MAX) } },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: cut([`*Sent by* ${escapeMrkdwn(notice.owner)}`, `*Item* ${itemLine(notice)}`, `*Verdict* ${verdict}`, `*Approval* ${inertMrkdwn(approval)}`].join("\n"), SECTION_MAX)
      }
    }
  ];
  if (fileId) blocks.push({ type: "image", slack_file: { id: fileId }, alt_text: cut(`${name} thumbnail`, ALT_TEXT_MAX) });
  const findings = findingsSection(notice);
  if (findings) blocks.push(findings);
  if (siteUrl) {
    blocks.push({
      type: "actions",
      elements: [{ type: "button", style: "primary", text: { type: "plain_text", text: cut("Open run", BUTTON_MAX) }, url: `${siteUrl}/?run=${notice.id}`, action_id: "open-run" }]
    });
  }
  blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: cut(contextLine(notice), SECTION_MAX) }] });
  return { text: `${inertMrkdwn(name)} — ${escapeMrkdwn(verdict)} — ${inertMrkdwn(approval)} (sent by ${escapeMrkdwn(notice.owner)})`, blocks };
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
  const log = appLogger(logs, "slack");
  const token = await config.getString("SLACK_BOT_TOKEN");
  const channel = await config.getString("SLACK_CHANNEL");
  const siteUrl = ((await config.getString("SITE_URL")) ?? "").replace(/\/+$/, "");
  if (!token) {
    log.info("slack notifications disabled: set SLACK_BOT_TOKEN and SLACK_CHANNEL to post every finished run to a channel");
    return { enabled: false, notify: async () => {} };
  }
  if (!channel) throw new Error("SLACK_CHANNEL must be the id of the channel (C…) the run notifications go to when SLACK_BOT_TOKEN is set.");
  if (!siteUrl) log.warn("SITE_URL is not set: Slack messages go out without the Open run button");

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
    return answer as SlackAnswer;
  }

  const ensure = (method: string, answer: SlackAnswer): SlackAnswer => {
    if (!answer.ok) throw slackError(method, answer.error ?? "an unknown error");
    return answer;
  };

  /** The first two steps of Slack's external upload: the file exists, not yet shared anywhere. */
  async function upload(filename: string, bytes: Uint8Array, alt: string): Promise<{ id: string; title: string }> {
    const ticket = ensure("files.getUploadURLExternal", await call("files.getUploadURLExternal", new URLSearchParams({ filename, length: String(bytes.byteLength), alt_txt: cut(alt, ALT_TXT_MAX) })));
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

  async function post(notice: RunNotice): Promise<string> {
    const message = runMessage(notice, siteUrl);
    const ts = ensure("chat.postMessage", await call("chat.postMessage", { channel, text: message.text, unfurl_links: false, unfurl_media: false, blocks: message.blocks })).ts;
    if (typeof ts !== "string") throw new Error("Slack answered chat.postMessage without a ts.");
    return ts;
  }

  /** The thumbnail and the worn front views, shared into the message's thread; the thumbnail's file id when it went up. */
  async function shareImages(notice: RunNotice, ts: string): Promise<string | undefined> {
    const name = displayName(notice);
    const files: { id: string; title: string }[] = [];
    const thumbnail = await readFile(join(notice.dir, "thumbnail.png")).catch(() => undefined);
    const thumbnailFile = thumbnail ? await upload("thumbnail.png", new Uint8Array(thumbnail), `${name} thumbnail`) : undefined;
    if (thumbnailFile) files.push(thumbnailFile);
    for (const view of frontViews(notice.visual?.captures ?? [])) files.push(await upload(`${view.request.id}.png`, view.bytes, `${name} worn, ${view.request.bodyShape}`));
    if (files.length === 0) return undefined;
    // an image block only shows a file shared where the message is: completing the upload into the thread shares them all
    ensure("files.completeUploadExternal", await call("files.completeUploadExternal", { files, channel_id: channel, thread_ts: ts, initial_comment: "Thumbnail and rendered front views" }));
    return thumbnailFile?.id;
  }

  /** Puts the shared thumbnail in the message itself; Slack may still be processing it, so one retry after a pause. */
  async function addThumbnail(notice: RunNotice, ts: string, fileId: string): Promise<void> {
    const message = runMessage(notice, siteUrl, fileId);
    for (let attempt = 0; ; attempt++) {
      const answer = await call("chat.update", { channel, ts, text: message.text, blocks: message.blocks });
      if (answer.ok || attempt > 0 || answer.error !== "invalid_blocks") return void ensure("chat.update", answer);
      await sleep(THUMBNAIL_RETRY_MS);
    }
  }

  return {
    enabled: true,
    channel,
    async notify(notice) {
      const ts = await post(notice);
      log.info("slack notified", { run: notice.id, channel, ts });
      const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));
      const thumbnail = await shareImages(notice, ts).catch((error: unknown) => {
        log.warn("slack images failed", { run: notice.id, reason: reason(error) });
        return undefined;
      });
      if (thumbnail) await addThumbnail(notice, ts, thumbnail).catch((error: unknown) => log.warn("slack kept the thumbnail in the thread only", { run: notice.id, reason: reason(error) }));
    }
  };
}
