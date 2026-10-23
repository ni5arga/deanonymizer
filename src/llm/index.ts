import { AnthropicClient } from "./anthropic.js";
import { ClaudeCodeClient } from "./claude-code.js";
import { OpenAIClient } from "./openai.js";
import {
  ORCAROUTER_CONSOLE_URL,
  ORCAROUTER_DEFAULT_MODEL,
} from "./orcarouter-catalog.js";
import { OrcaRouterClient } from "./orcarouter.js";
import type { LLMClient, Provider } from "./types.js";

export type { LLMClient, Provider } from "./types.js";
export {
  discoverChatCatalog,
  formatModelList,
  ORCAROUTER_DEFAULT_MODEL,
  resolveChatModel,
} from "./orcarouter-catalog.js";
export type { ModelCatalog, OrcaRouterModel } from "./orcarouter-catalog.js";

const ANTHROPIC_DEFAULT_MODEL = "claude-haiku-4-5";
const OPENAI_DEFAULT_MODEL = "gpt-4o-mini";

/** Per-run overrides supplied via CLI flags; each falls back to env. */
export interface LLMOverrides {
  provider?: string;
  baseUrl?: string;
  model?: string;
}

type Env = Record<string, string | undefined>;

function normalizeProvider(value: string): Provider {
  const p = value.trim().toLowerCase();
  if (p === "anthropic" || p === "openai" || p === "claude-code") return p;
  if (p === "orcarouter") return "orcarouter";
  throw new Error(
    `Unknown LLM provider "${value}". Use "anthropic", "openai", "orcarouter", or "claude-code".`,
  );
}

/**
 * Resolve which provider to use: explicit --provider flag wins, then
 * LLM_PROVIDER env, then auto-detect from which credentials are present.
 * OpenAI-shaped config (key, base URL, or --base-url) implies "openai";
 * an Anthropic key alone implies native "anthropic"; an OrcaRouter key alone
 * implies "orcarouter". Existing OpenAI/Anthropic precedence is unchanged, so
 * a machine with several keys set keeps its current default until the user
 * asks for OrcaRouter explicitly.
 */
export function resolveProvider(
  overrides: LLMOverrides,
  env: Env = process.env,
): Provider {
  const explicit = overrides.provider ?? env.LLM_PROVIDER;
  if (explicit) return normalizeProvider(explicit);

  if (overrides.baseUrl || env.OPENAI_API_KEY || env.OPENAI_BASE_URL) {
    return "openai";
  }
  if (env.ANTHROPIC_API_KEY) return "anthropic";
  if (env.ORCAROUTER_API_KEY) return "orcarouter";

  throw new Error(
    "No LLM provider configured. Set OPENAI_API_KEY (optionally with " +
      "OPENAI_BASE_URL for Gemini/Ollama/etc.), ANTHROPIC_API_KEY, or " +
      "ORCAROUTER_API_KEY, or pass --provider/--base-url. Pass --provider " +
      "claude-code to route through the Claude Code CLI without an API key.",
  );
}

/** Build a configured LLM client from CLI overrides + environment. */
export function createLLMClient(
  overrides: LLMOverrides = {},
  env: Env = process.env,
): LLMClient {
  const provider = resolveProvider(overrides, env);

  if (provider === "claude-code") {
    return new ClaudeCodeClient({
      bin: env.CLAUDE_CODE_BIN,
      model: overrides.model ?? env.CLAUDE_CODE_MODEL,
    });
  }

  if (provider === "anthropic") {
    const apiKey = env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error(
        "ANTHROPIC_API_KEY is not set. export ANTHROPIC_API_KEY=sk-ant-... and retry.",
      );
    }
    const model =
      overrides.model ?? env.ANTHROPIC_MODEL ?? ANTHROPIC_DEFAULT_MODEL;
    return new AnthropicClient({ apiKey, model });
  }

  if (provider === "orcarouter") {
    const apiKey = env.ORCAROUTER_API_KEY;
    if (!apiKey) {
      throw new Error(
        "ORCAROUTER_API_KEY is not set. Create a key at " +
          `${ORCAROUTER_CONSOLE_URL} and export ORCAROUTER_API_KEY=sk-orca-... then retry.`,
      );
    }
    // ORCAROUTER_BASE_URL points the provider at a self-hosted OrcaRouter
    // origin; --base-url is honored only because --provider was explicit, so
    // it cannot silently reroute an OpenAI-configured run here.
    const baseUrl = overrides.baseUrl ?? env.ORCAROUTER_BASE_URL;
    const model =
      overrides.model ?? env.ORCAROUTER_MODEL ?? ORCAROUTER_DEFAULT_MODEL;
    return new OrcaRouterClient({ apiKey, baseUrl, model });
  }

  const baseUrl = overrides.baseUrl ?? env.OPENAI_BASE_URL;
  // Local servers (e.g. Ollama) accept any non-empty key; only require a real
  // key when talking to a hosted endpoint without an explicit base URL.
  const apiKey = env.OPENAI_API_KEY ?? "";
  if (!apiKey && !baseUrl) {
    throw new Error(
      "OpenAI provider selected but neither OPENAI_API_KEY nor " +
        "OPENAI_BASE_URL/--base-url is set.",
    );
  }
  const model = overrides.model ?? env.OPENAI_MODEL ?? OPENAI_DEFAULT_MODEL;
  return new OpenAIClient({ apiKey: apiKey || "not-needed", baseUrl, model });
}
