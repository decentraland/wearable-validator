import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { configurePayload, createPiReviewer, reviewMessages } from "./ai.js";
import { manifest } from "../manifest/index.js";
import type { ReviewRequest } from "../types.js";
import { pngBytes } from "#test/helpers/synthetic.js";

const request: ReviewRequest = {
  check: "thumbnail-honesty",
  prompt: {
    version: 1,
    system: "Review the images.",
    instructions: "Return JSON.",
    schema: { type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"], additionalProperties: false }
  },
  promptDigest: "test",
  images: [{ id: "thumbnail", label: "Thumbnail", bytes: pngBytes(32, 32), mimeType: "image/png" }]
};

function streamResponse(text: string, stopReason = "end_turn"): Response {
  const events = [
    {
      type: "message_start",
      message: {
        id: "test",
        type: "message",
        role: "assistant",
        content: [],
        model: "claude-sonnet-4-5-20250929",
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 0 }
      }
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 25 } },
    { type: "message_stop" }
  ];
  return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" }
  });
}

async function oauthCredentials(): Promise<InMemoryCredentialStore> {
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("anthropic", async () => ({
    type: "oauth",
    access: "sk-ant-oat-test-only",
    refresh: "test",
    expires: Date.now() + 3600000
  }));
  return credentials;
}

describe("ai", () => {
  it("sends one OAuth request with no tools and a JSON schema, and keeps model/token provenance", async () => {
    const credentials = await oauthCredentials();
    let calls = 0;
    const transport: typeof fetch = async (_url, options) => {
      calls++;
      assert.equal(new Headers(options?.headers).get("authorization"), "Bearer sk-ant-oat-test-only");
      assert.equal(new Headers(options?.headers).has("x-api-key"), false);
      const body = JSON.parse(String(options?.body));
      assert.equal(body.tools, undefined);
      assert.equal(body.tool_choice, undefined);
      assert.deepEqual(body.output_config.format.schema, request.prompt.schema);
      assert.equal(body.messages[0].content.at(-1).text, request.prompt.instructions);
      return streamResponse('{"verdict":"matches"}');
    };
    const reviewer = createPiReviewer({ credentials, fetch: transport });
    const result = await reviewer.review(request);
    assert.equal(calls, 1);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.answer, { verdict: "matches" });
    assert.equal(result.metadata.provider, "anthropic");
    assert.equal(result.metadata.model, manifest.ai.model);
    assert.equal(result.metadata.promptVersion, 1);
    assert.equal(result.metadata.promptDigest, "test");
    assert.equal(result.metadata.stopReason, "end_turn");
    assert.equal(result.metadata.usage?.input, 100);
    assert.equal(result.metadata.usage?.output, 25);
    assert.equal(result.metadata.answer, '{"verdict":"matches"}');
    assert.equal(result.metadata.images?.length, 1);
    assert.equal(result.metadata.images?.[0].id, "thumbnail");
    assert.match(result.metadata.images?.[0].sha256 ?? "", /^[0-9a-f]{64}$/);
  });

  it("puts the image id and label before each image and the instructions last", () => {
    const context = reviewMessages(request);
    assert.equal(context.tools, undefined);
    assert.equal(context.systemPrompt, request.prompt.system);
    const content = context.messages[0].content;
    assert.ok(Array.isArray(content));
    assert.deepEqual(content.map((block) => block.type), ["text", "image", "text"]);
    assert.equal(content[0].type === "text" && content[0].text, "Image ID: thumbnail\nThumbnail");
    assert.equal(content[2].type === "text" && content[2].text, request.prompt.instructions);
  });

  it("resolves ok:false for missing or API-key credentials without any network access", async () => {
    const credentials = new InMemoryCredentialStore();
    const reviewer = createPiReviewer({
      credentials,
      fetch: async () => {
        assert.fail("No network call expected");
      }
    });
    const missing = await reviewer.review(request);
    assert.equal(missing.ok, false);
    if (missing.ok) return;
    assert.match(missing.reason, /OAuth session/);
    assert.equal(missing.metadata.model, manifest.ai.model);
    assert.equal(missing.metadata.usage, undefined);
    await credentials.modify("anthropic", async () => ({ type: "api_key", key: "dummy-never-use" }));
    const apiKey = await reviewer.review(request);
    assert.equal(apiKey.ok, false);
    if (apiKey.ok) return;
    assert.match(apiKey.reason, /API-key credentials are not supported/);
  });

  it("resolves ok:false when the images exceed the budget, before any fetch", async () => {
    const credentials = await oauthCredentials();
    const reviewer = createPiReviewer({
      credentials,
      fetch: async () => {
        assert.fail("No network call expected");
      }
    });
    const images = Array.from({ length: manifest.ai.maxImages + 1 }, (_, i) => ({ ...request.images[0], id: `image-${i}` }));
    const result = await reviewer.review({ ...request, images });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.reason, /budget/);
  });

  it("sends code as text with no images under the rule's own budget, which a code request over the shared budget needs", async () => {
    const credentials = await oauthCredentials();
    const code = "x".repeat(manifest.ai.maxInputTokens * manifest.ai.textCharactersPerToken);
    const texts = [{ id: "male/bin/game.js", label: "The bundle.", text: code }];
    let sent: { messages: { content: { type: string; text?: string }[] }[] } | undefined;
    const reviewer = createPiReviewer({ credentials, fetch: async (_url, options) => ((sent = JSON.parse(String(options?.body))), streamResponse('{"verdict":"ok"}')) });
    const shared = await reviewer.review({ ...request, images: [], texts });
    assert.equal(shared.ok, false, "the shared budget is for images");
    assert.equal(sent, undefined);
    const own = await reviewer.review({ ...request, images: [], texts, maxInputTokens: manifest.smartWearableCode.maxInputTokens });
    assert.equal(own.ok, true);
    assert.deepEqual(sent?.messages[0].content.map((block) => block.type), ["text", "text"]);
    assert.ok(sent?.messages[0].content[0].text?.startsWith("File ID: male/bin/game.js\nThe bundle.\n<file>\n"));
    assert.equal(own.metadata.texts?.[0].id, "male/bin/game.js");
  });

  it("resolves ok:false for truncation and non-JSON after exactly one call, keeping usage", async () => {
    const credentials = await oauthCredentials();
    for (const [text, stop, pattern] of [
      ["{}", "max_tokens", /longer than the model itself can produce/],
      ["I cannot review this.", "end_turn", /valid JSON/]
    ] as const) {
      let calls = 0;
      const reviewer = createPiReviewer({
        credentials,
        fetch: async () => {
          calls++;
          return streamResponse(text, stop);
        }
      });
      const result = await reviewer.review(request);
      assert.equal(calls, 1);
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.match(result.reason, pattern);
      assert.equal(result.metadata.stopReason, stop);
      assert.equal(result.metadata.usage?.input, 100);
      assert.equal(result.metadata.answer, text);
    }
  });

  it("rejects only when the caller's signal is aborted", async () => {
    const credentials = await oauthCredentials();
    const reviewer = createPiReviewer({
      credentials,
      fetch: async () => {
        assert.fail("No network call expected");
      }
    });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(reviewer.review(request, controller.signal));
  });

  it("optional caching marks the last image only, after stripping every other breakpoint", () => {
    const payload = {
      messages: [
        {
          content: [
            { type: "image", source: {} },
            { type: "image", source: {} },
            { type: "text", text: "rule", cache_control: { type: "ephemeral" } }
          ]
        }
      ]
    };
    configurePayload(payload, request.prompt.schema, true);
    assert.deepEqual(Reflect.get(payload, "output_config"), { format: { type: "json_schema", schema: request.prompt.schema } });
    assert.equal(Reflect.get(payload.messages[0].content[0], "cache_control"), undefined);
    assert.deepEqual(Reflect.get(payload.messages[0].content[1], "cache_control"), { type: "ephemeral" });
    assert.equal(Reflect.get(payload.messages[0].content[2], "cache_control"), undefined);
    const uncached = { messages: [{ content: [{ type: "image", source: {} }] }] };
    configurePayload(uncached, request.prompt.schema, false);
    assert.equal(Reflect.get(uncached.messages[0].content[0], "cache_control"), undefined);
  });
});
