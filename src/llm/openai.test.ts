import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OpenAIClient } from "./openai.js";

type CreateFn = (req: unknown) => Promise<unknown>;

/** Swap the SDK's chat.completions.create for a stub and capture the request. */
function stub(
  client: OpenAIClient,
  impl: CreateFn,
): { lastRequest: () => unknown } {
  let lastRequest: unknown;
  const sdk = (
    client as unknown as {
      client: { chat: { completions: { create: CreateFn } } };
    }
  ).client;
  sdk.chat.completions.create = (req: unknown) => {
    lastRequest = req;
    return impl(req);
  };
  return { lastRequest: () => lastRequest };
}

function makeClient(): OpenAIClient {
  return new OpenAIClient({
    apiKey: "test-key",
    baseUrl: "http://localhost:11434/v1",
    model: "llama3",
  });
}

describe("OpenAIClient.complete", () => {
  it("returns the assistant message content", async () => {
    const client = makeClient();
    stub(client, async () => ({
      choices: [{ message: { content: "hello" }, finish_reason: "stop" }],
    }));
    assert.equal(await client.complete({ user: "hi", maxTokens: 10 }), "hello");
  });

  it("sends a system message and json response_format when requested", async () => {
    const client = makeClient();
    const captured = stub(client, async () => ({
      choices: [{ message: { content: "{}" } }],
    }));
    await client.complete({
      system: "be terse",
      user: "go",
      maxTokens: 5,
      json: true,
    });
    const req = captured.lastRequest() as {
      messages: Array<{ role: string; content: string }>;
      response_format?: { type: string };
      max_tokens: number;
      model: string;
    };
    assert.deepEqual(req.messages[0], { role: "system", content: "be terse" });
    assert.deepEqual(req.messages[1], { role: "user", content: "go" });
    assert.deepEqual(req.response_format, { type: "json_object" });
    assert.equal(req.max_tokens, 5);
    assert.equal(req.model, "llama3");
  });

  it("omits response_format when json is not requested", async () => {
    const client = makeClient();
    const captured = stub(client, async () => ({
      choices: [{ message: { content: "x" } }],
    }));
    await client.complete({ user: "go", maxTokens: 5 });
    const req = captured.lastRequest() as { response_format?: unknown };
    assert.equal(req.response_format, undefined);
  });

  it("wraps SDK errors with a labeled message", async () => {
    const client = makeClient();
    stub(client, async () => {
      throw new Error("ECONNREFUSED");
    });
    await assert.rejects(client.complete({ user: "go", maxTokens: 5 }), {
      message: /openai \(base: .*\) request failed: ECONNREFUSED/,
    });
  });

  it("throws on empty content rather than returning an empty string", async () => {
    const client = makeClient();
    stub(client, async () => ({
      choices: [{ message: { content: "" }, finish_reason: "length" }],
    }));
    await assert.rejects(client.complete({ user: "go", maxTokens: 5 }), {
      message: /returned no content \(finish_reason: length\)/,
    });
  });

  it("throws when there are no choices at all", async () => {
    const client = makeClient();
    stub(client, async () => ({ choices: [] }));
    await assert.rejects(client.complete({ user: "go", maxTokens: 5 }), {
      message: /returned no content/,
    });
  });
});
