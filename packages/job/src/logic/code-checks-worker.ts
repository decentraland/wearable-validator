import { parentPort, workerData } from "node:worker_threads";
import { validate, type Input } from "@dcl-regenesislabs/wearable-validator";

const port = parentPort;
if (!port) throw new Error("code-checks-worker.ts runs only as a worker thread: use runCodeChecks().");
const result = await validate(workerData as Input, { onProgress: (progress) => port.postMessage({ progress }) });
port.postMessage({ result });
