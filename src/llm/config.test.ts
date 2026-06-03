import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLLMClient, resolveProvider } from "./index.js";

describe("resolveProvider", () => {
  it("honors an explicit --provider flag over env", () => {
    const env = { ANTHROPIC_API_KEY: "sk-ant", OPENAI_API_KEY: "sk-oai" };
    assert.equal(resolveProvider({ provider: "anthropic" }, env), "anthropic");
    assert.equal(resolveProvider({ provider: "openai" }, env), "openai");
  });

  it("honors LLM_PROVIDER env when no flag is given", () => {
    const env = { LLM_PROVIDER: "openai", ANTHROPIC_API_KEY: "sk-ant" };
    assert.equal(resolveProvider({}, env), "openai");
  });

  it("auto-detects openai from OPENAI_API_KEY", () => {
    assert.equal(resolveProvider({}, { OPENAI_API_KEY: "sk-oai" }), "openai");
  });

  it("auto-detects openai from a --base-url even without keys", () => {
    assert.equal(
      resolveProvider({ baseUrl: "http://localhost:11434/v1" }, {}),
      "openai",
    );
  });

  it("auto-detects anthropic from ANTHROPIC_API_KEY alone (back-compat)", () => {
    assert.equal(
      resolveProvider({}, { ANTHROPIC_API_KEY: "sk-ant" }),
      "anthropic",
    );
  });

  it("throws on an unknown provider name", () => {
    assert.throws(() => resolveProvider({ provider: "gemini" }, {}), /Unknown/);
  });

  it("throws when nothing is configured", () => {
    assert.throws(() => resolveProvider({}, {}), /No LLM provider configured/);
  });
});

describe("createLLMClient", () => {
  it("builds a native anthropic client with the configured model", () => {
    const client = createLLMClient(
      {},
      { ANTHROPIC_API_KEY: "sk-ant", ANTHROPIC_MODEL: "claude-sonnet-4-6" },
    );
    assert.equal(client.label, "anthropic");
    assert.equal(client.model, "claude-sonnet-4-6");
  });

  it("defaults the anthropic model when unset", () => {
    const client = createLLMClient({}, { ANTHROPIC_API_KEY: "sk-ant" });
    assert.equal(client.model, "claude-haiku-4-5");
  });

  it("builds an openai client honoring base url + model overrides", () => {
    const client = createLLMClient(
      { baseUrl: "http://localhost:11434/v1", model: "llama3" },
      {},
    );
    assert.equal(client.model, "llama3");
    assert.match(client.label, /openai \(base: http:\/\/localhost:11434\/v1\)/);
  });

  it("throws when openai is selected without key or base url", () => {
    assert.throws(
      () => createLLMClient({ provider: "openai" }, {}),
      /neither OPENAI_API_KEY/,
    );
  });

  it("throws when LLM_PROVIDER=openai is set but no key/base url", () => {
    assert.throws(
      () => createLLMClient({}, { LLM_PROVIDER: "openai" }),
      /neither OPENAI_API_KEY/,
    );
  });
});
