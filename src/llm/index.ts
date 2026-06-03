import { AnthropicClient } from "./anthropic.js";
import { OpenAIClient } from "./openai.js";
import type { LLMClient, Provider } from "./types.js";

export type { LLMClient, Provider } from "./types.js";

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
  if (p === "anthropic" || p === "openai") return p;
  throw new Error(
    `Unknown LLM provider "${value}". Use "anthropic" or "openai".`,
  );
}

/**
 * Resolve which provider to use: explicit --provider flag wins, then
 * LLM_PROVIDER env, then auto-detect from which credentials are present.
 * OpenAI-shaped config (key, base URL, or --base-url) implies "openai";
 * an Anthropic key alone implies native "anthropic".
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

  throw new Error(
    "No LLM provider configured. Set OPENAI_API_KEY (optionally with " +
      "OPENAI_BASE_URL for Gemini/Ollama/etc.) or ANTHROPIC_API_KEY, or pass " +
      "--provider/--base-url.",
  );
}

/** Build a configured LLM client from CLI overrides + environment. */
export function createLLMClient(
  overrides: LLMOverrides = {},
  env: Env = process.env,
): LLMClient {
  const provider = resolveProvider(overrides, env);

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
