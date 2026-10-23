import OpenAI from "openai";
import type {
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";
import {
  ORCAROUTER_CONSOLE_URL,
  ORCAROUTER_DEFAULT_BASE_URL,
} from "./orcarouter-catalog.js";
import type { LLMClient, LLMCompleteParams } from "./types.js";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * Validate and normalize the inference origin. The public default is
 * `https://api.orcarouter.ai/v1`; self-hosted deployments may override it.
 * Non-loopback origins must be HTTPS, and credentials must never ride in a
 * URL, so userinfo/query/fragment are rejected.
 */
export function resolveOrcaRouterBaseUrl(raw?: string): string {
  const value = (raw ?? "").trim() || ORCAROUTER_DEFAULT_BASE_URL;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      `OrcaRouter base URL "${value}" is not a valid URL. Expected something like ${ORCAROUTER_DEFAULT_BASE_URL}.`,
    );
  }

  if (url.username || url.password) {
    throw new Error(
      "OrcaRouter base URL must not contain credentials. Use ORCAROUTER_API_KEY instead.",
    );
  }
  if (url.search || url.hash) {
    throw new Error(
      "OrcaRouter base URL must not contain a query string or fragment.",
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(
      `OrcaRouter base URL must use https:// (or http:// on loopback), got "${url.protocol}".`,
    );
  }
  if (url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(
      `Refusing plaintext HTTP to non-loopback host "${url.hostname}". Use https:// or a loopback address for local development.`,
    );
  }

  return url.toString().replace(/\/+$/, "");
}

/** True when the value has OrcaRouter's documented key prefix. */
export function looksLikeOrcaRouterKey(value: string): boolean {
  return /^sk-orca-[A-Za-z0-9_-]+$/.test(value.trim());
}

/** Strip any credential-shaped token from a message headed for a log. */
export function redactSecrets(message: string): string {
  return message.replace(/sk-orca-[A-Za-z0-9_-]+/g, "sk-orca-[redacted]");
}

interface ApiErrorLike {
  status?: unknown;
  message?: unknown;
}

/**
 * Terminal, user-actionable mapping of an OrcaRouter failure. A 401 means the
 * durable key was rejected or revoked — there is no refresh grant to run, so
 * the CLI tells the user to issue a new key instead of retrying.
 */
export function describeOrcaRouterError(error: unknown): string {
  const status =
    error && typeof error === "object"
      ? (error as ApiErrorLike).status
      : undefined;
  const httpStatus = typeof status === "number" ? status : undefined;

  if (httpStatus === 401) {
    return (
      "OrcaRouter rejected the API key (HTTP 401). The key may be invalid or revoked; " +
      `create a new key at ${ORCAROUTER_CONSOLE_URL} and update ORCAROUTER_API_KEY.`
    );
  }
  if (httpStatus === 403) {
    return "OrcaRouter denied this request (HTTP 403). Check that the key is allowed to use this model.";
  }
  if (httpStatus === 429) {
    return "OrcaRouter rate-limited this request (HTTP 429). Wait and retry, or check your plan limits.";
  }

  const message = redactSecrets(
    error instanceof Error ? error.message : String(error),
  );
  return `orcarouter request failed${httpStatus ? ` (HTTP ${httpStatus})` : ""}: ${message}`;
}

/**
 * OrcaRouter backend. OrcaRouter exposes an OpenAI-compatible wire format at
 * `https://api.orcarouter.ai/v1`, so this reuses the OpenAI SDK while keeping
 * its own identity, configuration, and error semantics — a named provider, not
 * a generic "any endpoint" passthrough.
 *
 * Retries are disabled: a rejected durable key is a terminal reauthentication
 * requirement, and silent SDK retries would turn a 401 into a retry loop.
 */
export class OrcaRouterClient implements LLMClient {
  readonly label = "orcarouter";
  readonly model: string;
  readonly baseUrl: string;
  private readonly client: OpenAI;

  constructor(config: { apiKey: string; baseUrl?: string; model: string }) {
    this.baseUrl = resolveOrcaRouterBaseUrl(config.baseUrl);
    this.model = config.model;
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: this.baseUrl,
      maxRetries: 0,
    });
  }

  async complete(params: LLMCompleteParams): Promise<string> {
    const messages: ChatCompletionMessageParam[] = [];
    if (params.system) {
      messages.push({ role: "system", content: params.system });
    }
    messages.push({ role: "user", content: params.user });

    const request: ChatCompletionCreateParamsNonStreaming = {
      model: this.model,
      max_tokens: params.maxTokens,
      messages,
      ...(params.json ? { response_format: { type: "json_object" } } : {}),
    };

    let resp;
    try {
      resp = await this.client.chat.completions.create(request);
    } catch (error) {
      throw new Error(describeOrcaRouterError(error));
    }

    const choice = resp.choices[0];
    const content = choice?.message?.content;
    if (!content) {
      throw new Error(
        `orcarouter returned no content` +
          (choice?.finish_reason
            ? ` (finish_reason: ${choice.finish_reason})`
            : ""),
      );
    }
    return content;
  }
}
