/**
 * End to end, on a laptop: a real SQS queue (ElasticMQ in Docker), a stand-in Builder that serves the item's files by
 * hash and checks the webhook's signature, and the review job itself, rendering on the native render server.
 *
 *   npm run job:poc -w wearable-validator-server -- [shop item URL or URN]
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { CreateQueueCommand, SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { catalystFor, fetchCatalystItem, parseItemReference } from "@dcl-regenesislabs/wearable-validator";
import { SIGNATURE_HEADER, signature, TIMESTAMP_HEADER } from "../adapters/builder.js";
import type { ReviewResultBody } from "../logic/review-job.js";
import { REVIEW_EVENT } from "../logic/review-request.js";

const QUEUE_PORT = 9324;
const SECRET = "poc-secret";
const ITEM_ID = "11111111-2222-4333-8444-555555555555";
const COLLECTION_ID = "99999999-8888-4777-8666-555555555555";
const reference = process.argv[2] ?? "https://decentraland.zone/shop/item/0x8351cbb631c06b476a6a96acc43aba7a7e087053/1";

const step = (text: string): void => console.log(`\n▸ ${text}`);
const run = (command: string, args: string[]): Promise<number> => new Promise((resolve) => spawn(command, args, { stdio: "ignore" }).on("exit", (code) => resolve(code ?? 1)));

step(`Fetching ${reference} to stand in for a Builder item`);
const candidates = parseItemReference(reference) ?? [reference];
const item = await fetchCatalystItem(candidates, { peer: catalystFor(candidates[0]) });
const byHash = new Map(item.content.map(({ file, hash }) => [hash, item.files.get(file)]));
const itemType = "emoteDataADR74" in (item.metadata as object) ? "emote" : "wearable";
console.log(`  ${item.name} (${itemType}), ${item.files.size} files`);

step("Starting the stand-in Builder: storage by hash, and the webhook");
let resolveResult: (result: ReviewResultBody) => void = () => {};
const received = new Promise<ReviewResultBody>((resolve) => (resolveResult = resolve));
const builder = createServer((req, res) => {
  const stored = /^\/v1\/storage\/contents\/([A-Za-z0-9]+)$/.exec(req.url ?? "");
  if (req.method === "GET" && stored) {
    const bytes = byHash.get(stored[1]);
    res.writeHead(bytes ? 200 : 404).end(bytes);
    return;
  }
  if (req.method === "POST" && req.url === `/v1/items/${ITEM_ID}/validation`) {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk)).on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const expected = signature(SECRET, String(req.headers[TIMESTAMP_HEADER]), body);
      const valid = req.headers[SIGNATURE_HEADER] === expected;
      console.log(`  webhook called, signature ${valid ? "valid" : "INVALID"}`);
      res.writeHead(valid ? 204 : 401).end();
      if (valid) resolveResult(JSON.parse(body) as ReviewResultBody);
    });
    return;
  }
  res.writeHead(404).end();
});
await new Promise<void>((resolve) => builder.listen(0, "127.0.0.1", resolve));
const builderUrl = `http://127.0.0.1:${(builder.address() as AddressInfo).port}/v1`;

step("Starting an SQS queue (ElasticMQ in Docker)");
await run("docker", ["rm", "-f", "review-job-poc-sqs"]);
if ((await run("docker", ["run", "-d", "--name", "review-job-poc-sqs", "-p", `${QUEUE_PORT}:9324`, "softwaremill/elasticmq-native:1.6.11"])) !== 0) throw new Error("Could not start ElasticMQ: is Docker running?");
// ElasticMQ answers queue URLs on localhost: the same host here keeps the SDK from warning about a mismatch
const endpoint = `http://localhost:${QUEUE_PORT}`;
const sqs = new SQSClient({ endpoint, region: "us-east-1", credentials: { accessKeyId: "x", secretAccessKey: "x" } });
let queueUrl = "";
for (let attempt = 0; !queueUrl; attempt++) {
  try {
    queueUrl = (await sqs.send(new CreateQueueCommand({ QueueName: "wearable-validator-work" }))).QueueUrl ?? "";
  } catch (error) {
    if (attempt > 30) throw error;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

step("Publishing the Builder's review request, wrapped as SNS delivers it");
const event = {
  ...REVIEW_EVENT,
  key: ITEM_ID,
  timestamp: Date.now(),
  metadata: { itemId: ITEM_ID, collectionId: COLLECTION_ID, contentHash: item.id, itemType, entityMetadata: item.metadata, contents: Object.fromEntries(item.content.map(({ file, hash }) => [file, hash])) }
};
await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify({ Type: "Notification", Message: JSON.stringify(event) }) }));

step("Running the review job (it drains the queue and exits)");
const started = Date.now();
const job = spawn("npx", ["tsx", fileURLToPath(new URL("../job.ts", import.meta.url))], {
  stdio: "inherit",
  env: { ...process.env, WORK_QUEUE_URL: queueUrl, AWS_ENDPOINT_URL_SQS: endpoint, AWS_REGION: "us-east-1", AWS_ACCESS_KEY_ID: "x", AWS_SECRET_ACCESS_KEY: "x", BUILDER_API_URL: builderUrl, BUILDER_WEBHOOK_SECRET: SECRET, EMPTY_RECEIVES_TO_EXIT: "1" }
});
const exitCode = await new Promise<number>((resolve) => job.on("exit", (code) => resolve(code ?? 1)));
const result = await Promise.race([received, new Promise<undefined>((resolve) => setTimeout(resolve, 1000))]);

builder.close();
await run("docker", ["rm", "-f", "review-job-poc-sqs"]);
if (!result) {
  console.log(`\n✗ The job exited (${exitCode}) without posting a result.`);
  process.exit(1);
}
step(`The Builder received the result after ${Math.round((Date.now() - started) / 1000)} s`);
console.log(`  passed: ${result.passed} · decision: ${result.decision.state}${result.decision.reasons.length ? ` (${result.decision.reasons.join("; ")})` : ""}`);
console.log(`  ${result.summary.errors} errors, ${result.summary.warnings} warnings, rules v${result.rulesVersion}`);
for (const row of result.checks.filter((entry) => entry.group === "rendering")) console.log(`  ${row.check}: ${row.status}${row.skipReason ? ` (${row.skipReason})` : ""}`);
