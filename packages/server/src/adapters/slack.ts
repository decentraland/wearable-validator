/** One Slack message per finished run in the curators' channel: thumbnail, verdict, whether a curator is needed, a button to the run. */
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

export interface ISlackComponent {
  readonly enabled: boolean;
  readonly channel?: string;
  /** Rejects with an actionable sentence when Slack refused the message; a missing thumbnail or a failed thread reply only logs. */
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

/** The Block Kit message for a run; pure, so its shape is tested without Slack. siteUrl "" makes the button link relative. */
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
  blocks.push({
    type: "actions",
    elements: [{ type: "button", style: "primary", text: { type: "plain_text", text: cut("Open run", BUTTON_MAX) }, url: `${siteUrl}/?run=${notice.id}`, action_id: "open-run" }]
  });
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
  if (!siteUrl) log.warn("SITE_URL is not set: the Open run button in Slack will carry a relative link");

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

  /** The three-step external upload; the file stays private to the app and is shown through slack_file in a block. */
  async function upload(filename: string, bytes: Uint8Array, alt: string): Promise<string> {
    const ticket = ensure("files.getUploadURLExternal", await call("files.getUploadURLExternal", new URLSearchParams({ filename, length: String(bytes.byteLength), alt_txt: cut(alt, ALT_TXT_MAX) })));
    const uploadUrl = ticket.upload_url;
    const fileId = ticket.file_id;
    if (typeof uploadUrl !== "string" || typeof fileId !== "string") throw new Error("Slack answered files.getUploadURLExternal without an upload_url and file_id.");
    // a fresh Uint8Array sits on a plain ArrayBuffer, which is what fetch's BodyInit accepts
    const body = new Uint8Array(bytes.byteLength);
    body.set(bytes);
    const put = await send(uploadUrl, { method: "POST", headers: { "content-type": "application/octet-stream" }, body });
    if (!put.ok) throw new Error(`Slack answered HTTP ${put.status} to the file upload.`);
    ensure("files.completeUploadExternal", await call("files.completeUploadExternal", { files: [{ id: fileId, title: alt }] }));
    return fileId;
  }

  async function post(notice: RunNotice, fileId: string | undefined): Promise<string> {
    const message = runMessage(notice, siteUrl, fileId);
    let answer = await call("chat.postMessage", { channel, text: message.text, unfurl_links: false, unfurl_media: false, blocks: message.blocks });
    // slack_file on a file that was never shared is not promised by the docs: the message matters more than its picture
    if (!answer.ok && answer.error === "invalid_blocks" && fileId) {
      log.warn("slack refused the thumbnail block: posting without it", { run: notice.id });
      const plain = runMessage(notice, siteUrl);
      answer = await call("chat.postMessage", { channel, text: plain.text, unfurl_links: false, unfurl_media: false, blocks: plain.blocks });
    }
    const ts = ensure("chat.postMessage", answer).ts;
    if (typeof ts !== "string") throw new Error("Slack answered chat.postMessage without a ts.");
    return ts;
  }

  async function reply(notice: RunNotice, ts: string): Promise<void> {
    const views = frontViews(notice.visual?.captures ?? []);
    if (views.length === 0) return;
    const name = displayName(notice);
    const blocks: Block[] = [];
    for (const view of views) {
      const id = await upload(`${view.request.id}.png`, view.bytes, `${name} worn, ${view.request.bodyShape}`);
      blocks.push({ type: "image", slack_file: { id }, alt_text: cut(`${name} worn, ${view.request.bodyShape}`, ALT_TEXT_MAX) });
    }
    ensure("chat.postMessage", await call("chat.postMessage", { channel, thread_ts: ts, text: "Rendered front views", unfurl_links: false, unfurl_media: false, blocks }));
  }

  return {
    enabled: true,
    channel,
    async notify(notice) {
      const thumbnail = await readFile(join(notice.dir, "thumbnail.png")).catch(() => undefined);
      let fileId: string | undefined;
      if (thumbnail) {
        fileId = await upload("thumbnail.png", new Uint8Array(thumbnail), `${displayName(notice)} thumbnail`).catch((error: unknown) => {
          log.warn("slack thumbnail upload failed: posting without it", { run: notice.id, reason: error instanceof Error ? error.message : String(error) });
          return undefined;
        });
      }
      const ts = await post(notice, fileId);
      log.info("slack notified", { run: notice.id, channel, ts });
      await reply(notice, ts).catch((error: unknown) => log.warn("slack thread reply failed", { run: notice.id, reason: error instanceof Error ? error.message : String(error) }));
    }
  };
}
