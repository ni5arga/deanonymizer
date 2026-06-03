import { AnthropicClient } from "./anthropic.js";
import { OpenAIClient } from "./openai.js";
import type { LLMClient, Provider } from "./types.js";

export type { LLMClient, Provider } from "./types.js";

const ANTHROPIC_DEFAULT_MODEL = "claude-haiku-4-5";

/**
 * Known provider presets. Each maps a friendly --provider name to the
 * base URL, default model, and fallback models for the OpenAI-compatible
 * client. Anthropic uses its native SDK and is handled separately.
 */
interface ProviderPreset {
  baseUrl?: string;
  defaultModel: string;
  fallbackModels: string[];
}

const PROVIDER_PRESETS: Record<string, ProviderPreset> = {
  openai: {
    defaultModel: "gpt-4o-mini",
    fallbackModels: ["gpt-4o"],
  },
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "google/gemini-2.0-flash-exp:free",
    fallbackModels: ["meta-llama/llama-3.3-70b-instruct:free"],
  },
  gemini: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
    defaultModel: "gemini-2.0-flash",
    fallbackModels: ["gemini-1.5-flash"],
  },
  ollama: {
    baseUrl: "http://localhost:11434/v1",
    defaultModel: "llama3",
    fallbackModels: ["mistral"],
  },
  groq: {
    baseUrl: "https://api.groq.com/openai/v1",
    defaultModel: "llama-3.3-70b-versatile",
    fallbackModels: ["gemma2-9b-it"],
  },
  together: {
    baseUrl: "https://api.together.xyz/v1",
    defaultModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    fallbackModels: [],
  },
  nvidia: {
    baseUrl: "https://integrate.api.nvidia.com/v1",
    defaultModel: "meta/llama-3.3-70b-instruct",
    fallbackModels: ["nvidia/llama-3.1-nemotron-70b-instruct"],
  },
  mistral: {
    baseUrl: "https://api.mistral.ai/v1",
    defaultModel: "mistral-small-latest",
    fallbackModels: ["open-mistral-nemo"],
  },
};

/** Per-run overrides supplied via CLI flags; each falls back to env. */
export interface LLMOverrides {
  provider?: string;
  baseUrl?: string;
  model?: string;
}

type Env = Record<string, string | undefined>;

const KNOWN_PROVIDERS = new Set([
  "anthropic",
  "openai",
  "openrouter",
  "gemini",
  "ollama",
  "groq",
  "together",
  "nvidia",
  "mistral",
]);

function normalizeProvider(value: string): Provider {
  const p = value.trim().toLowerCase();
  if (KNOWN_PROVIDERS.has(p)) return p as Provider;
  throw new Error(
    `Unknown LLM provider "${value}". Supported: ${[...KNOWN_PROVIDERS].join(", ")}.`,
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
      "--provider/--base-url.\n\n" +
      "Supported providers: " +
      [...KNOWN_PROVIDERS].join(", "),
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

  // All non-anthropic providers go through the OpenAI-compatible client.
  const preset = PROVIDER_PRESETS[provider];

  // Base URL priority: CLI flag → env → provider preset → undefined (plain OpenAI)
  const baseUrl = overrides.baseUrl ?? env.OPENAI_BASE_URL ?? preset?.baseUrl;

  // Local servers (e.g. Ollama) accept any non-empty key; only require a real
  // key when talking to a hosted endpoint without an explicit base URL.
  const apiKey = env.OPENAI_API_KEY ?? "";
  if (!apiKey && !baseUrl) {
    throw new Error(
      "OpenAI provider selected but neither OPENAI_API_KEY nor " +
        "OPENAI_BASE_URL/--base-url is set.",
    );
  }

  const model =
    overrides.model ??
    env.OPENAI_MODEL ??
    preset?.defaultModel ??
    "gpt-4o-mini";
  const fallbackModels = preset?.fallbackModels ?? [];

  return new OpenAIClient({
    apiKey: apiKey || "not-needed",
    baseUrl,
    model,
    fallbackModels,
  });
}
