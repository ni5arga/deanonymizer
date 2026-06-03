import OpenAI from "openai";
import type {
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";
import type { LLMClient, LLMCompleteParams } from "./types.js";
import pc from "picocolors";

/** HTTP status codes worth retrying with a different model. */
const RETRYABLE_CODES = new Set([429, 500, 502, 503, 504]);

function isRetryableError(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    if (
      msg.includes("rate limit") ||
      msg.includes("timeout") ||
      msg.includes("econnrefused") ||
      msg.includes("econnreset") ||
      msg.includes("aborted")
    )
      return true;
  }
  // OpenAI SDK attaches `status` on API errors.
  const status = (error as { status?: number })?.status;
  if (status && RETRYABLE_CODES.has(status)) return true;
  return false;
}

/**
 * OpenAI-compatible backend. By configuring `baseURL` this also drives Gemini
 * (generativelanguage…/openai/), Ollama (localhost:11434/v1), Groq, Together,
 * NVIDIA NIM, OpenRouter, Mistral, and any other Chat Completions-compatible
 * endpoint.
 *
 * When `fallbackModels` are configured, a retryable failure (504, 429, empty
 * choices, etc.) on the primary model triggers an automatic retry with the
 * next fallback before the error propagates.
 */
export class OpenAIClient implements LLMClient {
  readonly label: string;
  readonly model: string;
  private readonly fallbackModels: string[];
  private activeModel: string;
  private readonly client: OpenAI;

  constructor(config: {
    apiKey: string;
    baseUrl?: string;
    model: string;
    fallbackModels?: string[];
  }) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
    });
    this.model = config.model;
    this.activeModel = config.model;
    this.fallbackModels = config.fallbackModels ?? [];
    this.label = config.baseUrl ? `openai (base: ${config.baseUrl})` : "openai";
  }

  async complete(params: LLMCompleteParams): Promise<string> {
    const modelsToTry = [
      this.activeModel,
      ...this.fallbackModels.filter((m) => m !== this.activeModel),
    ];

    let lastError: unknown;
    for (const model of modelsToTry) {
      try {
        return await this.tryComplete(params, model);
      } catch (error) {
        lastError = error;
        if (
          isRetryableError(error) &&
          model !== modelsToTry[modelsToTry.length - 1]
        ) {
          const nextModel = modelsToTry[modelsToTry.indexOf(model) + 1];
          if (nextModel) {
            process.stderr.write(
              pc.yellow(
                `  ⚠ Model "${model}" failed, falling back to "${nextModel}"\n`,
              ),
            );
            this.activeModel = nextModel;
            continue;
          }
        }
        throw error;
      }
    }
    throw lastError;
  }

  private async tryComplete(
    params: LLMCompleteParams,
    model: string,
  ): Promise<string> {
    const messages: ChatCompletionMessageParam[] = [];
    if (params.system)
      messages.push({ role: "system", content: params.system });
    messages.push({ role: "user", content: params.user });

    const request: ChatCompletionCreateParamsNonStreaming = {
      model,
      max_tokens: params.maxTokens,
      messages,
      ...(params.json ? { response_format: { type: "json_object" } } : {}),
    };

    let resp;
    try {
      resp = await this.client.chat.completions.create(request);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw Object.assign(
        new Error(`${this.label} request failed: ${message}`),
        { status: (error as { status?: number })?.status },
      );
    }

    if (!resp.choices || resp.choices.length === 0) {
      const respStr = JSON.stringify(resp);
      throw Object.assign(
        new Error(
          `${this.label} returned no choices or an error payload: ${respStr}`,
        ),
        { status: 502 },
      );
    }

    const choice = resp.choices[0];
    const content = choice?.message?.content;
    if (!content) {
      // Empty/refused/truncated responses would otherwise flow into the
      // JSON-repair path as "" and silently degrade. Throwing lets the
      // caller's retry/compressed path kick in instead.
      throw new Error(
        `${this.label} returned no content` +
          (choice?.finish_reason
            ? ` (finish_reason: ${choice.finish_reason})`
            : ""),
      );
    }
    return content;
  }
}
