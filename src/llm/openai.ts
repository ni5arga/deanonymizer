import OpenAI from "openai";
import type {
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";
import type { LLMClient, LLMCompleteParams } from "./types.js";

/**
 * OpenAI-compatible backend. By configuring `baseURL` this also drives Gemini
 * (generativelanguage…/openai/), Ollama (localhost:11434/v1), Groq, Together,
 * and any other Chat Completions-compatible endpoint. No prompt caching —
 * `response_format: json_object` is requested when supported, and the caller's
 * JSON-repair path still runs as a safety net for endpoints that ignore it.
 */
export class OpenAIClient implements LLMClient {
  readonly label: string;
  readonly model: string;
  private readonly client: OpenAI;

  constructor(config: { apiKey: string; baseUrl?: string; model: string }) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
    });
    this.model = config.model;
    this.label = config.baseUrl ? `openai (base: ${config.baseUrl})` : "openai";
  }

  async complete(params: LLMCompleteParams): Promise<string> {
    const messages: ChatCompletionMessageParam[] = [];
    if (params.system)
      messages.push({ role: "system", content: params.system });
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
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${this.label} request failed: ${message}`);
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
