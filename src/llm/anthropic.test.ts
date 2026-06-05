import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AnthropicClient } from "./anthropic.js";

type CreateFn = (req: unknown) => Promise<unknown>;

/** Swap the SDK's messages.create for a stub and capture the request. */
function stub(
  client: AnthropicClient,
  impl: CreateFn,
): { lastRequest: () => unknown } {
  let lastRequest: unknown;
  const sdk = (
    client as unknown as { client: { messages: { create: CreateFn } } }
  ).client;
  sdk.messages.create = (req: unknown) => {
    lastRequest = req;
    return impl(req);
  };
  return { lastRequest: () => lastRequest };
}

function makeClient(): AnthropicClient {
  return new AnthropicClient({ apiKey: "test-key", model: "claude-haiku-4-5" });
}

describe("AnthropicClient.complete", () => {
  it("returns text from the response", async () => {
    const client = makeClient();
    stub(client, async () => ({
      content: [{ type: "text", text: "hello" }],
    }));
    assert.equal(await client.complete({ user: "hi", maxTokens: 10 }), "hello");
  });

  it("attaches cache_control to the system prompt", async () => {
    const client = makeClient();
    const captured = stub(client, async () => ({
      content: [{ type: "text", text: "ok" }],
    }));
    await client.complete({ system: "be terse", user: "go", maxTokens: 5 });
    const req = captured.lastRequest() as {
      system: Array<{ cache_control: { type: string } }>;
    };
    assert.deepEqual(req.system[0].cache_control, { type: "ephemeral" });
  });

  it("sends no system field when system is omitted", async () => {
    const client = makeClient();
    const captured = stub(client, async () => ({
      content: [{ type: "text", text: "ok" }],
    }));
    await client.complete({ user: "go", maxTokens: 5 });
    const req = captured.lastRequest() as { system?: unknown };
    assert.equal(req.system, undefined);
  });

  it("wraps SDK errors with a labeled message", async () => {
    const client = makeClient();
    stub(client, async () => {
      throw new Error("network failure");
    });
    await assert.rejects(client.complete({ user: "go", maxTokens: 5 }), {
      message: /anthropic request failed: network failure/,
    });
  });

  it("throws when there is no text content in the response", async () => {
    const client = makeClient();
    stub(client, async () => ({ content: [] }));
    await assert.rejects(client.complete({ user: "go", maxTokens: 5 }), {
      message: /anthropic returned no content/,
    });
  });
});
