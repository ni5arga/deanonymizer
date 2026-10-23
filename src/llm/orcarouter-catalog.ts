/**
 * OrcaRouter model discovery and capability filtering.
 *
 * The authoritative catalog is `GET {baseUrl}/models` on the configured
 * OrcaRouter origin (default `https://api.orcarouter.ai/v1`), optionally
 * narrowed with `?capability=<name>`. Model ids are preserved verbatim —
 * `vendor/model` namespaces are meaningful routing keys, never rewritten.
 *
 * Discovery is bounded: request timeout, accepted response size, item count,
 * id length, and accepted record shapes are all capped so a broken or hostile
 * catalog response cannot exhaust memory or advertise routes this CLI cannot
 * speak.
 */

/** OrcaRouter inference origin; authentication is a different origin entirely. */
export const ORCAROUTER_DEFAULT_BASE_URL = "https://api.orcarouter.ai/v1";
export const ORCAROUTER_DEFAULT_MODEL = "orcarouter/auto";
export const ORCAROUTER_CONSOLE_URL = "https://www.orcarouter.ai/console";

/** Endpoint types that can carry a Chat Completions request. */
const TEXT_ENDPOINT_TYPES = [
  "openai",
  "anthropic",
  "gemini",
  "openai-response",
] as const;

export type Capability =
  | "chat"
  | "multimodal"
  | "embedding"
  | "image"
  | "video"
  | "rerank";

export type InputModality = "text" | "image" | "audio" | "video" | "file";

/** One catalog entry, normalized across live discovery and the fallback seed. */
export interface OrcaRouterModel {
  /** Verbatim catalog id, e.g. `deepseek/deepseek-v4-pro`. */
  id: string;
  name?: string;
  /** Context window in tokens, when the catalog declares it. */
  contextLength?: number;
  maxCompletionTokens?: number;
  /** Declared input modalities; `undefined` means the catalog did not say. */
  inputModalities?: string[];
  outputModalities?: string[];
  /** Advertised wire protocols, e.g. `openai`, `anthropic`, `gemini`. */
  endpointTypes: string[];
  /** Parameters the model accepts, e.g. `reasoning`, `response_format`. */
  supportedParameters: string[];
  /** Verified reasoning-effort ladder, only where the source states it. */
  reasoningEfforts?: string[];
}

export interface ModelCatalog {
  models: OrcaRouterModel[];
  /** Where the list came from. Live results are authoritative on their own. */
  source: "live" | "fallback";
  /** True when live discovery failed and the verified seed is in use. */
  degraded: boolean;
  /** Safe, key-free explanation of why discovery was degraded. */
  degradedReason?: string;
}

interface RawModel {
  id?: unknown;
  name?: unknown;
  context_length?: unknown;
  max_completion_tokens?: unknown;
  architecture?: unknown;
  supported_endpoint_types?: unknown;
  supported_parameters?: unknown;
  top_provider?: unknown;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_MODELS = 500;
const MAX_ID_LENGTH = 200;
const MAX_LISTED_MODELS = 200;

/**
 * Small, verified outage fallback. Every entry was read from OrcaRouter's own
 * catalog (`GET /v1/models` on the public origin, 2026-10-23); the reasoning
 * ladder on `openai/gpt-5.5` is the documented `low|medium|high|xhigh` set.
 * `openai/gpt-5.5` declares no numeric context window in that catalog, so none
 * is invented here. This list is only ever used when live discovery fails, and
 * is never merged into a successful live result.
 */
export const VERIFIED_CHAT_FALLBACK: readonly OrcaRouterModel[] = Object.freeze(
  [
    Object.freeze({
      id: "openai/gpt-5.5",
      name: "OpenAI: GPT-5.5",
      maxCompletionTokens: 128_000,
      inputModalities: ["text", "image", "file"],
      endpointTypes: ["openai", "openai-response"],
      supportedParameters: ["reasoning", "response_format", "tools"],
      reasoningEfforts: ["low", "medium", "high", "xhigh"],
    }),
    Object.freeze({
      id: "anthropic/claude-opus-4.8",
      name: "Anthropic: Claude Opus 4.8",
      contextLength: 1_000_000,
      maxCompletionTokens: 128_000,
      inputModalities: ["text", "image", "file"],
      endpointTypes: ["openai", "anthropic", "openai-response"],
      supportedParameters: ["reasoning", "response_format", "tools"],
    }),
    Object.freeze({
      id: "google/gemini-3.5-flash",
      name: "Gemini 3.5 Flash",
      contextLength: 1_048_576,
      maxCompletionTokens: 65_536,
      inputModalities: ["text", "image", "video", "file", "audio"],
      endpointTypes: ["openai", "gemini"],
      supportedParameters: ["reasoning", "response_format", "tools"],
    }),
    Object.freeze({
      id: "deepseek/deepseek-v4-pro",
      name: "DeepSeek V4 Pro",
      contextLength: 1_048_576,
      inputModalities: ["text"],
      endpointTypes: ["openai", "openai-response"],
      supportedParameters: ["reasoning", "response_format", "tools"],
    }),
    Object.freeze({
      id: "orcarouter/auto",
      name: "OrcaRouter Auto",
      endpointTypes: ["openai", "openai-response", "anthropic", "gemini"],
      supportedParameters: [],
    }),
  ],
);

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter(
    (v): v is string => typeof v === "string" && v !== "",
  );
  return out.length ? out : undefined;
}

function asPositiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : undefined;
}

/** Normalize one raw catalog record; `undefined` means "not a usable model". */
export function parseModel(raw: unknown): OrcaRouterModel | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as RawModel;
  if (typeof r.id !== "string") return undefined;
  const id = r.id.trim();
  if (!id || id.length > MAX_ID_LENGTH) return undefined;

  const architecture =
    r.architecture && typeof r.architecture === "object"
      ? (r.architecture as {
          input_modalities?: unknown;
          output_modalities?: unknown;
        })
      : undefined;

  const topProvider =
    r.top_provider && typeof r.top_provider === "object"
      ? (r.top_provider as { context_length?: unknown })
      : undefined;

  const endpointTypes = asStringArray(r.supported_endpoint_types) ?? [];
  const supportedParameters = asStringArray(r.supported_parameters) ?? [];
  const inputModalities = asStringArray(architecture?.input_modalities);
  const outputModalities = asStringArray(architecture?.output_modalities);
  const contextLength =
    asPositiveInt(r.context_length) ??
    asPositiveInt(topProvider?.context_length);

  return {
    id,
    ...(typeof r.name === "string" && r.name ? { name: r.name } : {}),
    ...(contextLength ? { contextLength } : {}),
    ...(asPositiveInt(r.max_completion_tokens)
      ? { maxCompletionTokens: asPositiveInt(r.max_completion_tokens) }
      : {}),
    ...(inputModalities ? { inputModalities } : {}),
    ...(outputModalities ? { outputModalities } : {}),
    endpointTypes,
    supportedParameters,
  };
}

/** Extract, validate, dedupe, and cap the model array from a catalog payload. */
export function parseCatalogPayload(payload: unknown): OrcaRouterModel[] {
  const list = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object"
      ? (payload as { data?: unknown }).data
      : undefined;
  if (!Array.isArray(list)) {
    throw new Error("unexpected catalog shape (expected an array or { data })");
  }
  const seen = new Set<string>();
  const models: OrcaRouterModel[] = [];
  for (const raw of list.slice(0, MAX_MODELS)) {
    const model = parseModel(raw);
    if (!model || seen.has(model.id)) continue;
    seen.add(model.id);
    models.push(model);
  }
  return models;
}

function hasTextEndpoint(model: OrcaRouterModel): boolean {
  return model.endpointTypes.some((t) =>
    (TEXT_ENDPOINT_TYPES as readonly string[]).includes(t),
  );
}

/** True when a model can serve a text Chat Completions request. */
export function isChatModel(model: OrcaRouterModel): boolean {
  return hasTextEndpoint(model);
}

function hasEndpoint(model: OrcaRouterModel, names: string[]): boolean {
  return model.endpointTypes.some((t) => names.includes(t));
}

/**
 * Capability filter used by every model selector. Unsupported or undeclared
 * capabilities fail closed: a model is only offered when the catalog proves it
 * can serve the exact workload.
 */
export function filterByCapability(
  models: readonly OrcaRouterModel[],
  capability: Capability,
  requiredModality?: InputModality,
): OrcaRouterModel[] {
  switch (capability) {
    case "chat":
      return models.filter(isChatModel);
    case "multimodal": {
      if (!requiredModality || requiredModality === "text") {
        throw new Error(
          "multimodal filtering requires a non-text required modality",
        );
      }
      return models.filter(
        (m) =>
          isChatModel(m) &&
          Array.isArray(m.inputModalities) &&
          m.inputModalities.includes(requiredModality),
      );
    }
    case "embedding":
      return models.filter((m) => hasEndpoint(m, ["embeddings", "embedding"]));
    case "image":
      return models.filter((m) =>
        hasEndpoint(m, ["image-generation", "images"]),
      );
    case "video":
      return models.filter((m) => hasEndpoint(m, ["openai-video"]));
    case "rerank":
      return models.filter((m) => hasEndpoint(m, ["jina-rerank"]));
  }
}

/** Chat models offered to the analysis entry point. */
export function chatModels(
  models: readonly OrcaRouterModel[],
): OrcaRouterModel[] {
  return filterByCapability(models, "chat");
}

/** Pick the default model from a filtered list, preferring `orcarouter/auto`. */
export function defaultChatModel(
  models: readonly OrcaRouterModel[],
): OrcaRouterModel | undefined {
  return (
    models.find((m) => m.id === ORCAROUTER_DEFAULT_MODEL) ??
    models[0] ??
    undefined
  );
}

export interface CatalogFetchOptions {
  baseUrl: string;
  apiKey: string;
  capability?: Capability;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** Build the catalog URL on the configured OrcaRouter inference origin. */
export function catalogUrl(baseUrl: string, capability?: Capability): string {
  const url = new URL(`${baseUrl.replace(/\/+$/, "")}/models`);
  if (capability) url.searchParams.set("capability", capability);
  return url.toString();
}

/**
 * Fetch the live catalog. Any transport, HTTP, size, or shape problem throws;
 * the caller decides whether to fall back.
 */
export async function fetchModels(
  options: CatalogFetchOptions,
): Promise<OrcaRouterModel[]> {
  const {
    baseUrl,
    apiKey,
    capability,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl = fetch,
  } = options;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();

  try {
    const response = await fetchImpl(catalogUrl(baseUrl, capability), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`catalog request failed with HTTP ${response.status}`);
    }

    const declared = Number(response.headers?.get?.("content-length") ?? 0);
    if (declared > MAX_RESPONSE_BYTES) {
      throw new Error("catalog response exceeds the size limit");
    }

    const body = await response.text();
    if (body.length > MAX_RESPONSE_BYTES) {
      throw new Error("catalog response exceeds the size limit");
    }

    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      throw new Error("catalog response was not valid JSON");
    }
    return parseCatalogPayload(payload);
  } finally {
    clearTimeout(timer);
  }
}

function withoutKey(message: string): string {
  // Never let a credential reach a log, error, or crash report.
  return message.replace(/sk-orca-[A-Za-z0-9_-]+/g, "sk-orca-[redacted]");
}

export interface DiscoverOptions extends CatalogFetchOptions {
  /** Injectable clock/cache removed; this CLI is one-shot per process. */
  timeoutMs?: number;
}

/**
 * Discover the authoritative chat catalog, falling back to the verified seed
 * when discovery fails or returns no usable chat models. A degraded result
 * contains the seed only — never a mixture of live and seed entries.
 */
export async function discoverChatCatalog(
  options: DiscoverOptions,
): Promise<ModelCatalog> {
  try {
    const raw = await fetchModels({ ...options, capability: "chat" });
    const models = chatModels(raw);
    if (!models.length) {
      throw new Error("catalog returned no chat-capable models");
    }
    return { models, source: "live", degraded: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      models: [...VERIFIED_CHAT_FALLBACK],
      source: "fallback",
      degraded: true,
      degradedReason: withoutKey(message),
    };
  }
}

export interface ResolvedChatModel {
  model: OrcaRouterModel;
  catalog: ModelCatalog;
}

/**
 * Resolve the model for an analysis run against the catalog. When the catalog
 * is authoritative the requested id must be present; when discovery is
 * degraded only verified fallback ids are accepted. No free-form model ids.
 */
export function resolveChatModel(
  catalog: ModelCatalog,
  requested?: string,
): ResolvedChatModel {
  const models = chatModels(catalog.models);
  if (!models.length) {
    throw new Error("OrcaRouter returned no chat-capable models.");
  }

  const wanted = requested?.trim();
  if (wanted) {
    const match = models.find((m) => m.id === wanted);
    if (match) return { model: match, catalog };
    throw new Error(
      `OrcaRouter model "${wanted}" is not in the current chat catalog. ` +
        `Available (${models.length}): ${formatModelList(models)}. ` +
        "Run `audit --provider orcarouter --list-models` to see the full list.",
    );
  }

  const fallback = defaultChatModel(models);
  if (!fallback) {
    throw new Error("OrcaRouter returned no chat-capable models.");
  }
  return { model: fallback, catalog };
}

/** Human-readable, bounded list of model ids for CLI output and errors. */
export function formatModelList(models: readonly OrcaRouterModel[]): string {
  const shown = models.slice(0, MAX_LISTED_MODELS).map((m) => m.id);
  if (models.length > shown.length) {
    shown.push(`… and ${models.length - shown.length} more`);
  }
  return shown.join(", ");
}
