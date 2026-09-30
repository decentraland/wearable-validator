/**
 * End to end, on a laptop: a real SQS queue (ElasticMQ in Docker), a stand-in Builder that serves the items' files by
 * hash and checks the callback's signature, and the review job itself, rendering on the native render server. The
 * collection is a published one from decentraland.zone, standing in for one published in the Builder.
 *
 *   npm run poc -w wearable-validator-job -- [collection contract address] [how many items, default 3]
 */
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { CreateQueueCommand, SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { fetchCatalystItem, TESTNET_CATALYST, type CatalystItem } from "@dcl-regenesislabs/wearable-validator";
import { SIGNATURE_HEADER, signature, TIMESTAMP_HEADER } from "../adapters/builder.js";
import type { CollectionResultBody } from "../logic/review-job.js";
import { REVIEW_EVENT } from "../logic/review-request.js";

const QUEUE_PORT = 9324;
const SECRET = "poc-secret";
const COLLECTION_ID = "99999999-8888-4777-8666-555555555555";
const VALIDATION_ID = "44444444-5555-4666-8777-888888888888";
const contract = (process.argv[2] ?? "0x8351cbb631c06b476a6a96acc43aba7a7e087053").toLowerCase();
const limit = Number(process.argv[3] ?? 3);

const step = (text: string): void => console.log(`\n▸ ${text}`);
const run = (command: string, args: string[]): Promise<number> => new Promise((resolve) => spawn(command, args, { stdio: "ignore" }).on("exit", (code) => resolve(code ?? 1)));
const uuid = (n: number): string => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;

step(`Reading collection ${contract} from decentraland.zone to stand in for a Builder collection`);
const listed = (await (await fetch(`https://marketplace-api.decentraland.zone/v1/items?contractAddress=${contract}&first=${limit}`)).json()) as { data: { urn: string }[] };
const items: CatalystItem[] = [];
for (const { urn } of listed.data.slice(0, limit)) items.push(await fetchCatalystItem([urn], { peer: TESTNET_CATALYST }));
if (items.length === 0) throw new Error(`No published items found for ${contract} on decentraland.zone.`);
const byHash = new Map(items.flatMap((item) => item.content.map(({ file, hash }) => [hash, item.files.get(file)] as const)));
const reviewItems = items.map((item, n) => ({ itemId: uuid(n + 1), contentHash: item.id, metadata: item.metadata, contents: Object.fromEntries(item.content.map(({ file, hash }) => [file, hash])) }));
for (const [n, item] of items.entries()) console.log(`  ${reviewItems[n].itemId}  ${item.name} (${item.files.size} files)`);

step("Starting the stand-in Builder: storage by hash, and the callback");
const readBody = (req: IncomingMessage): Promise<string> => new Promise((resolve) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk)).on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
});
const signedByValidator = (req: IncomingMessage, body: string): boolean => req.headers[SIGNATURE_HEADER] === signature(SECRET, String(req.headers[TIMESTAMP_HEADER]), body);
let resolveResult: (result: CollectionResultBody) => void = () => {};
const received = new Promise<CollectionResultBody>((resolve) => (resolveResult = resolve));
const builder = createServer((req, res) => {
  const path = new URL(req.url ?? "/", "http://builder").pathname;
  const stored = /^\/v1\/storage\/contents\/([A-Za-z0-9]+)$/.exec(path);
  if (req.method === "GET" && stored) {
    const bytes = byHash.get(stored[1]);
    res.writeHead(bytes ? 200 : 404).end(bytes);
  } else if (req.method === "POST" && path === `/v1/collections/${COLLECTION_ID}/validation-result`) {
    void readBody(req).then((body) => {
      const valid = signedByValidator(req, body);
      console.log(`  callback called, signature ${valid ? "valid" : "INVALID"}`);
      res.writeHead(valid ? 204 : 401).end();
      if (valid) resolveResult(JSON.parse(body) as CollectionResultBody);
    });
  } else {
    res.writeHead(404).end();
  }
});
await new Promise<void>((resolve) => builder.listen(0, "127.0.0.1", resolve));
const builderUrl = `http://127.0.0.1:${(builder.address() as AddressInfo).port}`;

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

step("Publishing the Builder's validation request for the collection, wrapped as SNS delivers it");
const event = { ...REVIEW_EVENT, key: COLLECTION_ID, timestamp: Date.now(), metadata: { validationId: VALIDATION_ID, collectionId: COLLECTION_ID, items: reviewItems } };
await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify({ Type: "Notification", Message: JSON.stringify(event) }) }));

step("Running the review job (it drains the queue and exits)");
const started = Date.now();
const job = spawn("npx", ["tsx", fileURLToPath(new URL("../job.ts", import.meta.url))], {
  stdio: "inherit",
  env: { ...process.env, WORK_QUEUE_URL: queueUrl, AWS_ENDPOINT_URL_SQS: endpoint, AWS_REGION: "us-east-1", AWS_ACCESS_KEY_ID: "x", AWS_SECRET_ACCESS_KEY: "x", BUILDER_CONTENT_URL: builderUrl, BUILDER_CALLBACK_URL: builderUrl, BUILDER_CALLBACK_SECRET: SECRET, EMPTY_RECEIVES_TO_EXIT: "1" }
});
const exitCode = await new Promise<number>((resolve) => job.on("exit", (code) => resolve(code ?? 1)));
const result = await Promise.race([received, new Promise<undefined>((resolve) => setTimeout(resolve, 1000))]);

builder.close();
await run("docker", ["rm", "-f", "review-job-poc-sqs"]);
if (!result) {
  console.log(`\n✗ The job exited (${exitCode}) without posting a result.`);
  process.exit(1);
}
step(`The Builder received the result after ${Math.round((Date.now() - started) / 1000)} s: verdict ${result.verdict}${result.reason ? ` (${result.reason})` : ""}, rules v${result.rulesVersion}`);
for (const item of result.items) {
  const name = items[reviewItems.findIndex((entry) => entry.itemId === item.itemId)]?.name ?? item.itemId;
  const errors = item.findings.filter((finding) => finding.severity === "error");
  console.log(`  ${name}: passed ${item.passed}${item.error ? ` · ${item.error}` : ""}`);
  for (const finding of errors.slice(0, 3)) console.log(`    ${finding.rule} ${finding.check}${finding.bodyShape ? ` (${finding.bodyShape})` : ""}: ${finding.message.slice(0, 120)}`);
  if (item.visualSummary) console.log(`    ${item.visualSummary.split("\n")[0].slice(0, 140)}`);
}
