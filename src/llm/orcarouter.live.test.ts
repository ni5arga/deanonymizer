import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  discoverChatCatalog,
  isChatModel,
  ORCAROUTER_DEFAULT_BASE_URL,
  resolveChatModel,
} from "./orcarouter-catalog.js";
import { OrcaRouterClient, looksLikeOrcaRouterKey } from "./orcarouter.js";

/**
 * Live checks against the real OrcaRouter service. They run only when
 * ORCAROUTER_API_KEY holds an `sk-orca-…` key, and they exercise exactly the
 * provider paths this CLI uses — catalog discovery and the chat client — not a
 * standalone curl.
 */
const apiKey = process.env.ORCAROUTER_API_KEY?.trim() ?? "";
const skip = !looksLikeOrcaRouterKey(apiKey);

describe("OrcaRouter live discovery", () => {
  it(
    "reads the live chat catalog from the inference origin",
    { skip, timeout: 60_000 },
    async () => {
      const catalog = await discoverChatCatalog({
        baseUrl: ORCAROUTER_DEFAULT_BASE_URL,
        apiKey,
        timeoutMs: 30_000,
      });

      assert.equal(catalog.source, "live");
      assert.equal(catalog.degraded, false);
      assert.ok(catalog.models.length > 0, "expected at least one chat model");
      assert.ok(
        catalog.models.length <= 500,
        "catalog must stay within the item cap",
      );

      // Ids keep their vendor namespace exactly as served.
      for (const model of catalog.models) {
        assert.equal(model.id, model.id.trim());
        assert.ok(model.id.length > 0 && model.id.length <= 200);
      }
      assert.ok(catalog.models.some((m) => m.id.includes("/")));

      // Every offered model can speak a text endpoint the CLI can use.
      for (const model of catalog.models) {
        assert.ok(isChatModel(model), `${model.id} is not chat-capable`);
      }

      // Selection goes through the same resolver the CLI uses.
      const resolved = resolveChatModel(catalog);
      assert.ok(catalog.models.some((m) => m.id === resolved.model.id));
    },
  );

  it(
    "completes a real chat request through OrcaRouterClient",
    { skip, timeout: 120_000 },
    async () => {
      const catalog = await discoverChatCatalog({
        baseUrl: ORCAROUTER_DEFAULT_BASE_URL,
        apiKey,
        timeoutMs: 30_000,
      });
      assert.equal(catalog.degraded, false);

      // Model access is granted per API key, so a catalog entry can still
      // answer 403 model_access_denied. Try the resolver's default first, then
      // up to five models that declare concrete capabilities; at least one
      // must complete through the real client.
      const { model } = resolveChatModel(catalog);
      const candidates = [
        model.id,
        ...catalog.models
          .filter((m) => m.id !== model.id && m.inputModalities?.length)
          .map((m) => m.id),
      ].slice(0, 6);

      let lastError: unknown;
      for (const candidate of candidates) {
        const client = new OrcaRouterClient({ apiKey, model: candidate });
        try {
          const text = await client.complete({
            system: "You are a terse assistant.",
            user: "Reply with exactly one word: orca",
            maxTokens: 128,
          });
          assert.equal(typeof text, "string");
          assert.ok(text.trim().length > 0, "expected non-empty completion");
          return;
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError ?? new Error("no chat model accepted the request");
    },
  );
});
