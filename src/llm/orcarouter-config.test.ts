import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLLMClient, resolveProvider } from "./index.js";
import { OrcaRouterClient } from "./orcarouter.js";

describe("resolveProvider — OrcaRouter", () => {
  it("honors an explicit --provider orcarouter flag", () => {
    assert.equal(
      resolveProvider({ provider: "orcarouter" }, { OPENAI_API_KEY: "sk-oai" }),
      "orcarouter",
    );
  });

  it("honors LLM_PROVIDER=orcarouter", () => {
    assert.equal(
      resolveProvider({}, { LLM_PROVIDER: "orcarouter" }),
      "orcarouter",
    );
  });

  it("auto-detects orcarouter from ORCAROUTER_API_KEY alone", () => {
    assert.equal(
      resolveProvider({}, { ORCAROUTER_API_KEY: "sk-orca-test" }),
      "orcarouter",
    );
  });

  it("keeps existing OpenAI and Anthropic precedence unchanged", () => {
    const env = {
      OPENAI_API_KEY: "sk-oai",
      ANTHROPIC_API_KEY: "sk-ant",
      ORCAROUTER_API_KEY: "sk-orca-test",
    };
    assert.equal(resolveProvider({}, env), "openai");
    assert.equal(
      resolveProvider({}, { ...env, OPENAI_API_KEY: undefined }),
      "anthropic",
    );
  });

  it("rejects a --base-url-only config as openai, not orcarouter", () => {
    assert.equal(
      resolveProvider(
        { baseUrl: "http://localhost:11434/v1" },
        { ORCAROUTER_API_KEY: "sk-orca-test" },
      ),
      "openai",
    );
  });

  it("names orcarouter in the unknown-provider error", () => {
    assert.throws(
      () => resolveProvider({ provider: "gemini" }, {}),
      (e: Error) => {
        assert.match(e.message, /Unknown LLM provider/);
        assert.match(e.message, /orcarouter/);
        return true;
      },
    );
  });

  it("names ORCAROUTER_API_KEY in the no-provider error", () => {
    assert.throws(() => resolveProvider({}, {}), /ORCAROUTER_API_KEY/);
  });
});

describe("createLLMClient — OrcaRouter", () => {
  it("builds a named OrcaRouter client with the default model", () => {
    const client = createLLMClient(
      { provider: "orcarouter" },
      { ORCAROUTER_API_KEY: "sk-orca-test" },
    );
    assert.ok(client instanceof OrcaRouterClient);
    assert.equal(client.label, "orcarouter");
    assert.equal(client.model, "orcarouter/auto");
  });

  it("honors ORCAROUTER_MODEL and --model overrides", () => {
    const fromEnv = createLLMClient(
      { provider: "orcarouter" },
      {
        ORCAROUTER_API_KEY: "sk-orca-test",
        ORCAROUTER_MODEL: "deepseek/deepseek-v4-pro",
      },
    );
    assert.equal(fromEnv.model, "deepseek/deepseek-v4-pro");

    const fromFlag = createLLMClient(
      { provider: "orcarouter", model: "vendor/text" },
      {
        ORCAROUTER_API_KEY: "sk-orca-test",
        ORCAROUTER_MODEL: "deepseek/deepseek-v4-pro",
      },
    );
    assert.equal(fromFlag.model, "vendor/text");
  });

  it("honors ORCAROUTER_BASE_URL and a --base-url override", () => {
    const fromEnv = createLLMClient(
      { provider: "orcarouter" },
      {
        ORCAROUTER_API_KEY: "sk-orca-test",
        ORCAROUTER_BASE_URL: "https://gateway.example/v1",
      },
    ) as OrcaRouterClient;
    assert.equal(fromEnv.baseUrl, "https://gateway.example/v1");

    const fromFlag = createLLMClient(
      { provider: "orcarouter", baseUrl: "http://127.0.0.1:9999/v1" },
      { ORCAROUTER_API_KEY: "sk-orca-test" },
    ) as OrcaRouterClient;
    assert.equal(fromFlag.baseUrl, "http://127.0.0.1:9999/v1");
  });

  it("fails with an actionable message when the key is missing", () => {
    assert.throws(
      () => createLLMClient({ provider: "orcarouter" }, {}),
      (e: Error) => {
        assert.match(e.message, /ORCAROUTER_API_KEY is not set/);
        assert.match(e.message, /www\.orcarouter\.ai\/console/);
        return true;
      },
    );
  });

  it("never echoes the key in a configuration error", () => {
    assert.throws(
      () =>
        createLLMClient(
          {
            provider: "orcarouter",
            baseUrl: "http://api.orcarouter.ai/v1",
          },
          { ORCAROUTER_API_KEY: "sk-orca-secretvalue" },
        ),
      (e: Error) => {
        assert.match(e.message, /non-loopback/);
        assert.ok(!e.message.includes("secretvalue"));
        return true;
      },
    );
  });
});
