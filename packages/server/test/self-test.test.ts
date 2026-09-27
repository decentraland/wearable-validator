import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RENDER_DEPENDENCIES, runSelfTest } from "../src/adapters/self-test.js";
import { startTestServer } from "./components.js";

const recorder = () => {
  const lines: { level: string; message: string; extra: Record<string, unknown> }[] = [];
  const logger = {
    log: () => {},
    debug: () => {},
    info: (message: string, extra: Record<string, unknown> = {}) => lines.push({ level: "INFO", message, extra }),
    warn: (message: string, extra: Record<string, unknown> = {}) => lines.push({ level: "WARN", message, extra }),
    error: (message: string | Error, extra: Record<string, unknown> = {}) => lines.push({ level: "ERROR", message: String(message), extra })
  };
  return { lines, logs: { getLogger: () => logger } };
};

describe("startup self-test", () => {
  it("names the hosts a render needs", () => {
    assert.ok(RENDER_DEPENDENCIES.some((url) => url.startsWith("https://peer.decentraland.org/")), "the content servers the avatar comes from");
  });

  it("passes when the render server draws and every dependency answers", async () => {
    const server = await startTestServer();
    const log = recorder();
    try {
      const result = await runSelfTest(log, {
        dependencies: [`${server.base}/api/health`],
        probe: async () => ({ ok: true, ms: 10 })
      });
      assert.equal(result.ok, true);
      assert.equal(result.reachability[0].status, 200);
      assert.ok(log.lines.some((line) => line.level === "INFO" && line.message.includes("self-test passed")));
      assert.ok(!log.lines.some((line) => line.level === "ERROR"));
    } finally {
      await server.stop();
    }
  });

  it("says which side failed: a blocked dependency and a render server that cannot draw are different lines", async () => {
    const log = recorder();
    const result = await runSelfTest(log, {
      timeoutMs: 2000,
      dependencies: ["http://127.0.0.1:1/blocked"],
      probe: async () => ({ ok: false, error: "The render server exited (1).", ms: 20 })
    });
    assert.equal(result.ok, false);
    assert.equal(result.reachability[0].status, null);
    const errors = log.lines.filter((line) => line.level === "ERROR").map((line) => line.message);
    assert.ok(errors.some((message) => message.includes("dependency unreachable")), "the network side");
    assert.ok(errors.some((message) => message.includes("self-test failed")), "the render server side");
  });
});
