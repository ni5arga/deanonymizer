import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  describeOrcaRouterError,
  looksLikeOrcaRouterKey,
  OrcaRouterClient,
  redactSecrets,
  resolveOrcaRouterBaseUrl,
} from "./orcarouter.js";

type CreateFn = (req: unknown) => Promise<unknown>;

/** Swap the SDK's chat.completions.create for a stub and capture the request. */
function stub(
  client: OrcaRouterClient,
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

function makeClient(): OrcaRouterClient {
  return new OrcaRouterClient({
    apiKey: "sk-orca-test",
    model: "orcarouter/auto",
  });
}

describe("resolveOrcaRouterBaseUrl", () => {
  it("defaults to the public inference origin", () => {
    assert.equal(resolveOrcaRouterBaseUrl(), "https://api.orcarouter.ai/v1");
    assert.equal(
      resolveOrcaRouterBaseUrl("  "),
      "https://api.orcarouter.ai/v1",
    );
  });

  it("accepts an HTTPS self-hosted origin and trims trailing slashes", () => {
    assert.equal(
      resolveOrcaRouterBaseUrl("https://gateway.internal.example/v1/"),
      "https://gateway.internal.example/v1",
    );
  });

  it("allows plaintext HTTP only on loopback", () => {
    assert.equal(
      resolveOrcaRouterBaseUrl("http://127.0.0.1:8080/v1"),
      "http://127.0.0.1:8080/v1",
    );
    assert.equal(
      resolveOrcaRouterBaseUrl("http://localhost:8080/v1"),
      "http://localhost:8080/v1",
    );
    assert.throws(
      () => resolveOrcaRouterBaseUrl("http://api.orcarouter.ai/v1"),
      /non-loopback/,
    );
  });

  it("rejects credentials or query strings in the URL", () => {
    assert.throws(
      () => resolveOrcaRouterBaseUrl("https://user:pass@example.com/v1"),
      /must not contain credentials/,
    );
    assert.throws(
      () => resolveOrcaRouterBaseUrl("https://example.com/v1?key=x"),
      /query string/,
    );
  });

  it("rejects invalid or non-HTTP URLs", () => {
    assert.throws(() => resolveOrcaRouterBaseUrl("not a url"), /not a valid/);
    assert.throws(
      () => resolveOrcaRouterBaseUrl("ftp://example.com/v1"),
      /https/,
    );
  });
});

describe("OrcaRouterClient.complete", () => {
  it("carries its own provider identity and model", () => {
    const client = makeClient();
    assert.equal(client.label, "orcarouter");
    assert.equal(client.model, "orcarouter/auto");
    assert.equal(client.baseUrl, "https://api.orcarouter.ai/v1");
  });

  it("honors a self-hosted base URL", () => {
    const client = new OrcaRouterClient({
      apiKey: "sk-orca-test",
      baseUrl: "https://gateway.example/v1",
      model: "vendor/text",
    });
    assert.equal(client.baseUrl, "https://gateway.example/v1");
  });

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
    assert.equal(req.model, "orcarouter/auto");
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
});

describe("OrcaRouterClient error handling", () => {
  it("maps 401 to a terminal, actionable message without the key", async () => {
    const client = makeClient();
    stub(client, async () => {
      const error = Object.assign(new Error("bad key sk-orca-leakedvalue"), {
        status: 401,
      });
      throw error;
    });
    await assert.rejects(
      client.complete({ user: "go", maxTokens: 5 }),
      (e: Error) => {
        assert.match(e.message, /HTTP 401/);
        assert.match(e.message, /www\.orcarouter\.ai\/console/);
        assert.match(e.message, /update ORCAROUTER_API_KEY/);
        assert.ok(!e.message.includes("sk-orca-leakedvalue"));
        return true;
      },
    );
  });

  it("maps 403 and 429 to distinct guidance", () => {
    assert.match(
      describeOrcaRouterError(Object.assign(new Error("x"), { status: 403 })),
      /HTTP 403/,
    );
    assert.match(
      describeOrcaRouterError(Object.assign(new Error("x"), { status: 429 })),
      /rate-limited/,
    );
  });

  it("wraps network errors and redacts credential-shaped text", async () => {
    const client = makeClient();
    stub(client, async () => {
      throw new Error("ECONNREFUSED for sk-orca-leakedvalue");
    });
    await assert.rejects(
      client.complete({ user: "go", maxTokens: 5 }),
      (e: Error) => {
        assert.match(e.message, /orcarouter request failed: ECONNREFUSED/);
        assert.ok(!e.message.includes("leakedvalue"));
        return true;
      },
    );
  });

  it("throws on empty content rather than returning an empty string", async () => {
    const client = makeClient();
    stub(client, async () => ({
      choices: [{ message: { content: "" }, finish_reason: "length" }],
    }));
    await assert.rejects(client.complete({ user: "go", maxTokens: 5 }), {
      message: /orcarouter returned no content \(finish_reason: length\)/,
    });
  });

  it("throws when there are no choices at all", async () => {
    const client = makeClient();
    stub(client, async () => ({ choices: [] }));
    await assert.rejects(client.complete({ user: "go", maxTokens: 5 }), {
      message: /orcarouter returned no content/,
    });
  });
});

describe("credential helpers", () => {
  it("recognizes the documented key prefix without treating it as proof", () => {
    assert.equal(looksLikeOrcaRouterKey("sk-orca-abc123"), true);
    assert.equal(looksLikeOrcaRouterKey("sk-other"), false);
    assert.equal(looksLikeOrcaRouterKey(""), false);
  });

  it("redacts any credential-shaped token", () => {
    assert.equal(
      redactSecrets("failed with sk-orca-abc123/x_y"),
      "failed with sk-orca-[redacted]/x_y",
    );
  });
});
