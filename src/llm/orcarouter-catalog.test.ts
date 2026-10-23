import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  catalogUrl,
  chatModels,
  discoverChatCatalog,
  fetchModels,
  filterByCapability,
  formatModelList,
  parseCatalogPayload,
  parseModel,
  resolveChatModel,
  VERIFIED_CHAT_FALLBACK,
  type OrcaRouterModel,
} from "./orcarouter-catalog.js";

const FIXTURES: OrcaRouterModel[] = [
  {
    id: "vendor/text",
    endpointTypes: ["openai"],
    supportedParameters: ["response_format"],
    inputModalities: ["text"],
  },
  {
    id: "vendor/vision",
    endpointTypes: ["openai", "anthropic"],
    supportedParameters: ["response_format", "reasoning"],
    inputModalities: ["text", "image"],
    outputModalities: ["text"],
  },
  {
    id: "vendor/undeclared",
    endpointTypes: ["openai-response"],
    supportedParameters: [],
  },
  {
    id: "vendor/embed",
    endpointTypes: ["embeddings"],
    supportedParameters: [],
  },
  {
    id: "vendor/imagegen",
    endpointTypes: ["image-generation"],
    supportedParameters: [],
  },
  {
    id: "vendor/video",
    endpointTypes: ["openai-video"],
    supportedParameters: [],
  },
  {
    id: "vendor/rerank",
    endpointTypes: ["jina-rerank"],
    supportedParameters: [],
  },
];

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("parseModel", () => {
  it("normalizes a rich catalog record", () => {
    const model = parseModel({
      id: "deepseek/deepseek-v4-pro",
      name: "DeepSeek V4 Pro",
      context_length: 1048576,
      max_completion_tokens: 384000,
      supported_endpoint_types: ["openai", "openai-response"],
      supported_parameters: ["reasoning", "response_format"],
      architecture: {
        input_modalities: ["text", "image"],
        output_modalities: ["text"],
      },
    });
    assert.ok(model);
    assert.equal(model.id, "deepseek/deepseek-v4-pro");
    assert.equal(model.contextLength, 1048576);
    assert.equal(model.maxCompletionTokens, 384000);
    assert.deepEqual(model.inputModalities, ["text", "image"]);
    assert.deepEqual(model.endpointTypes, ["openai", "openai-response"]);
  });

  it("keeps vendor/model namespaces verbatim", () => {
    const model = parseModel({ id: "orca/orcacyber-zero-1.5" });
    assert.equal(model?.id, "orca/orcacyber-zero-1.5");
  });

  it("falls back to top_provider.context_length", () => {
    const model = parseModel({
      id: "vendor/x",
      top_provider: { context_length: 128000 },
    });
    assert.equal(model?.contextLength, 128000);
  });

  it("rejects records without a usable id", () => {
    assert.equal(parseModel({}), undefined);
    assert.equal(parseModel({ id: "" }), undefined);
    assert.equal(parseModel({ id: 42 }), undefined);
    assert.equal(parseModel({ id: "x".repeat(201) }), undefined);
    assert.equal(parseModel(null), undefined);
    assert.equal(parseModel("nope"), undefined);
  });

  it("leaves undeclared modalities undefined rather than guessing", () => {
    const model = parseModel({ id: "orcarouter/auto" });
    assert.equal(model?.inputModalities, undefined);
    assert.deepEqual(model?.endpointTypes, []);
  });
});

describe("parseCatalogPayload", () => {
  it("accepts the OpenAI-style { data } envelope", () => {
    const models = parseCatalogPayload({
      data: [{ id: "a/one" }, { id: "b/two" }],
    });
    assert.deepEqual(
      models.map((m) => m.id),
      ["a/one", "b/two"],
    );
  });

  it("accepts a bare array and dedupes ids", () => {
    const models = parseCatalogPayload([
      { id: "a/one" },
      { id: "a/one" },
      { id: "b/two" },
    ]);
    assert.equal(models.length, 2);
  });

  it("rejects an unexpected envelope", () => {
    assert.throws(() => parseCatalogPayload({ models: [] }), /unexpected/);
    assert.throws(() => parseCatalogPayload(null), /unexpected/);
  });

  it("caps the number of accepted records", () => {
    const many = Array.from({ length: 600 }, (_, i) => ({ id: `v/m${i}` }));
    assert.equal(parseCatalogPayload(many).length, 500);
  });
});

describe("filterByCapability", () => {
  it("offers text chat models and hides non-text workloads", () => {
    const ids = filterByCapability(FIXTURES, "chat").map((m) => m.id);
    assert.deepEqual(ids, [
      "vendor/text",
      "vendor/vision",
      "vendor/undeclared",
    ]);
    assert.ok(!ids.includes("vendor/embed"));
    assert.ok(!ids.includes("vendor/imagegen"));
    assert.ok(!ids.includes("vendor/video"));
    assert.ok(!ids.includes("vendor/rerank"));
  });

  it("keeps a model that advertises both text and image endpoints", () => {
    const mixed: OrcaRouterModel = {
      id: "vendor/mixed",
      endpointTypes: ["openai", "image-generation"],
      supportedParameters: [],
    };
    assert.deepEqual(
      chatModels([mixed]).map((m) => m.id),
      ["vendor/mixed"],
    );
  });

  it("fails closed for image input when a chat model does not declare it", () => {
    const ids = filterByCapability(FIXTURES, "multimodal", "image").map(
      (m) => m.id,
    );
    assert.deepEqual(ids, ["vendor/vision"]);
  });

  it("fails closed for undeclared modalities on every non-text modality", () => {
    // Only the vision fixture declares image input; nothing declares audio or
    // video, and undeclared models are never offered for those workloads.
    assert.deepEqual(
      filterByCapability(FIXTURES, "multimodal", "image").map((m) => m.id),
      ["vendor/vision"],
    );
    for (const modality of ["audio", "video"] as const) {
      assert.deepEqual(
        filterByCapability(FIXTURES, "multimodal", modality),
        [],
      );
    }
  });

  it("requires an explicit non-text modality", () => {
    assert.throws(
      () => filterByCapability(FIXTURES, "multimodal"),
      /requires a non-text/,
    );
    assert.throws(
      () => filterByCapability(FIXTURES, "multimodal", "text"),
      /requires a non-text/,
    );
  });

  it("selects embedding, image, video, and rerank models strictly", () => {
    assert.deepEqual(
      filterByCapability(FIXTURES, "embedding").map((m) => m.id),
      ["vendor/embed"],
    );
    assert.deepEqual(
      filterByCapability(FIXTURES, "image").map((m) => m.id),
      ["vendor/imagegen"],
    );
    assert.deepEqual(
      filterByCapability(FIXTURES, "video").map((m) => m.id),
      ["vendor/video"],
    );
    assert.deepEqual(
      filterByCapability(FIXTURES, "rerank").map((m) => m.id),
      ["vendor/rerank"],
    );
  });
});

describe("catalogUrl", () => {
  it("builds the models URL on the configured inference origin", () => {
    assert.equal(
      catalogUrl("https://api.orcarouter.ai/v1"),
      "https://api.orcarouter.ai/v1/models",
    );
    assert.equal(
      catalogUrl("https://api.orcarouter.ai/v1/", "chat"),
      "https://api.orcarouter.ai/v1/models?capability=chat",
    );
  });
});

describe("fetchModels", () => {
  it("sends Bearer auth to the public catalog origin", async () => {
    let seen: { url?: string; auth?: string } = {};
    const models = await fetchModels({
      baseUrl: "https://api.orcarouter.ai/v1",
      apiKey: "sk-orca-test",
      capability: "chat",
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        seen = {
          url: String(input),
          auth: new Headers(init?.headers).get("authorization") ?? undefined,
        };
        return jsonResponse({ data: [{ id: "orcarouter/auto" }] });
      }) as typeof fetch,
    });
    assert.equal(
      seen.url,
      "https://api.orcarouter.ai/v1/models?capability=chat",
    );
    assert.equal(seen.auth, "Bearer sk-orca-test");
    assert.deepEqual(
      models.map((m) => m.id),
      ["orcarouter/auto"],
    );
  });

  it("rejects non-2xx responses", async () => {
    await assert.rejects(
      fetchModels({
        baseUrl: "https://api.orcarouter.ai/v1",
        apiKey: "sk-orca-test",
        fetchImpl: (async () =>
          jsonResponse({ error: "nope" }, 500)) as typeof fetch,
      }),
      /HTTP 500/,
    );
  });

  it("rejects oversized responses before parsing", async () => {
    await assert.rejects(
      fetchModels({
        baseUrl: "https://api.orcarouter.ai/v1",
        apiKey: "sk-orca-test",
        fetchImpl: (async () =>
          new Response("{}", {
            status: 200,
            headers: { "content-length": String(3 * 1024 * 1024) },
          })) as typeof fetch,
      }),
      /size limit/,
    );
  });

  it("rejects invalid JSON", async () => {
    await assert.rejects(
      fetchModels({
        baseUrl: "https://api.orcarouter.ai/v1",
        apiKey: "sk-orca-test",
        fetchImpl: (async () =>
          new Response("not json", { status: 200 })) as typeof fetch,
      }),
      /not valid JSON/,
    );
  });
});

describe("discoverChatCatalog", () => {
  it("uses the live catalog as authoritative when it succeeds", async () => {
    const catalog = await discoverChatCatalog({
      baseUrl: "https://api.orcarouter.ai/v1",
      apiKey: "sk-orca-test",
      fetchImpl: (async () =>
        jsonResponse({
          data: [
            {
              id: "deepseek/deepseek-v4-pro",
              context_length: 1048576,
              supported_endpoint_types: ["openai"],
              architecture: { input_modalities: ["text"] },
            },
            {
              id: "vendor/imagegen",
              supported_endpoint_types: ["image-generation"],
            },
          ],
        })) as typeof fetch,
    });
    assert.equal(catalog.source, "live");
    assert.equal(catalog.degraded, false);
    assert.deepEqual(
      catalog.models.map((m) => m.id),
      ["deepseek/deepseek-v4-pro"],
    );
    assert.equal(catalog.models[0].contextLength, 1048576);
    // Live results are authoritative: no seed entries are merged in.
    assert.ok(!catalog.models.some((m) => m.id === "openai/gpt-5.5"));
  });

  it("falls back to the verified seed on an HTTP failure", async () => {
    const catalog = await discoverChatCatalog({
      baseUrl: "https://api.orcarouter.ai/v1",
      apiKey: "sk-orca-test",
      fetchImpl: (async () =>
        jsonResponse({ error: "down" }, 503)) as typeof fetch,
    });
    assert.equal(catalog.source, "fallback");
    assert.equal(catalog.degraded, true);
    assert.match(catalog.degradedReason ?? "", /HTTP 503/);
    assert.deepEqual(
      catalog.models.map((m) => m.id),
      VERIFIED_CHAT_FALLBACK.map((m) => m.id),
    );
  });

  it("falls back when the live catalog has no chat models", async () => {
    const catalog = await discoverChatCatalog({
      baseUrl: "https://api.orcarouter.ai/v1",
      apiKey: "sk-orca-test",
      fetchImpl: (async () =>
        jsonResponse({
          data: [
            { id: "vendor/embed", supported_endpoint_types: ["embeddings"] },
          ],
        })) as typeof fetch,
    });
    assert.equal(catalog.source, "fallback");
    assert.match(catalog.degradedReason ?? "", /no chat-capable/);
  });

  it("falls back on a network error", async () => {
    const catalog = await discoverChatCatalog({
      baseUrl: "https://api.orcarouter.ai/v1",
      apiKey: "sk-orca-test",
      fetchImpl: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
    });
    assert.equal(catalog.degraded, true);
    assert.match(catalog.degradedReason ?? "", /fetch failed/);
  });

  it("never leaks a credential into the degraded reason", async () => {
    const catalog = await discoverChatCatalog({
      baseUrl: "https://api.orcarouter.ai/v1",
      apiKey: "sk-orca-supersecretvalue",
      fetchImpl: (async () => {
        throw new Error("request failed for sk-orca-supersecretvalue");
      }) as typeof fetch,
    });
    assert.equal(catalog.degraded, true);
    assert.ok(!(catalog.degradedReason ?? "").includes("supersecretvalue"));
    assert.match(catalog.degradedReason ?? "", /sk-orca-\[redacted\]/);
  });

  it("keeps verified fallback metadata, including GPT-5.5's reasoning ladder", async () => {
    const catalog = await discoverChatCatalog({
      baseUrl: "https://api.orcarouter.ai/v1",
      apiKey: "sk-orca-test",
      fetchImpl: (async () => {
        throw new Error("offline");
      }) as typeof fetch,
    });
    const gpt = catalog.models.find((m) => m.id === "openai/gpt-5.5");
    assert.ok(gpt);
    assert.deepEqual(gpt.reasoningEfforts, ["low", "medium", "high", "xhigh"]);
    assert.deepEqual(gpt.inputModalities, ["text", "image", "file"]);
    const claude = catalog.models.find(
      (m) => m.id === "anthropic/claude-opus-4.8",
    );
    assert.equal(claude?.contextLength, 1_000_000);
    const gemini = catalog.models.find(
      (m) => m.id === "google/gemini-3.5-flash",
    );
    assert.equal(gemini?.contextLength, 1_048_576);
    assert.ok(gemini?.inputModalities?.includes("video"));
    const deepseek = catalog.models.find(
      (m) => m.id === "deepseek/deepseek-v4-pro",
    );
    assert.equal(deepseek?.contextLength, 1_048_576);
  });
});

describe("resolveChatModel", () => {
  const liveCatalog = {
    models: FIXTURES,
    source: "live" as const,
    degraded: false,
  };

  it("prefers orcarouter/auto as the default", () => {
    const withAuto: OrcaRouterModel = {
      id: "orcarouter/auto",
      endpointTypes: ["openai"],
      supportedParameters: [],
    };
    const resolved = resolveChatModel(
      { ...liveCatalog, models: [FIXTURES[0], withAuto] },
      undefined,
    );
    assert.equal(resolved.model.id, "orcarouter/auto");
  });

  it("accepts an id that exists in the catalog", () => {
    assert.equal(
      resolveChatModel(liveCatalog, "vendor/vision").model.id,
      "vendor/vision",
    );
  });

  it("rejects a free-form id and lists the compatible options", () => {
    assert.throws(
      () => resolveChatModel(liveCatalog, "made/up-model"),
      (error: Error) => {
        assert.match(error.message, /not in the current chat catalog/);
        assert.match(error.message, /--list-models/);
        assert.match(error.message, /vendor\/text/);
        return true;
      },
    );
  });

  it("accepts only verified fallback ids while degraded", () => {
    const degraded = {
      models: [...VERIFIED_CHAT_FALLBACK],
      source: "fallback" as const,
      degraded: true,
      degradedReason: "offline",
    };
    assert.equal(
      resolveChatModel(degraded, "openai/gpt-5.5").model.id,
      "openai/gpt-5.5",
    );
    assert.throws(
      () => resolveChatModel(degraded, "deepseek/deepseek-v4-flash"),
      /not in the current chat catalog/,
    );
  });

  it("reports an empty catalog clearly", () => {
    assert.throws(
      () => resolveChatModel({ models: [], source: "live", degraded: false }),
      /no chat-capable models/,
    );
  });
});

describe("formatModelList", () => {
  it("bounds long lists", () => {
    const models: OrcaRouterModel[] = Array.from({ length: 205 }, (_, i) => ({
      id: `v/m${i}`,
      endpointTypes: ["openai"],
      supportedParameters: [],
    }));
    const text = formatModelList(models);
    assert.match(text, /and 5 more/);
  });
});
