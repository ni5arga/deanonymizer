import Anthropic from "@anthropic-ai/sdk";
import type { LLMClient, LLMCompleteParams } from "./types.js";

function textFromResponse(resp: Anthropic.Messages.Message): string {
  return resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/**
 * Native Anthropic backend. Keeps the ephemeral prompt cache on the system
 * prompt — the repeated auditor instructions across chunks are the main thing
 * worth caching, and this is the reason we retain the native SDK rather than
 * routing Anthropic through its OpenAI-compatible endpoint.
 */
export class AnthropicClient implements LLMClient {
  readonly label = "anthropic";
  readonly model: string;
  /**
   * Claude 5 models may think before answering when no thinking setting is
   * sent, and that thinking counts against max_tokens and takes time. The
   * analysis asks for 1-4K tokens of JSON, so give every call room to think
   * first and enough time to finish.
   */
  readonly requestTimeoutMs = 300_000;
  private static readonly MIN_MAX_TOKENS = 16_000;
  private readonly client: Anthropic;

  constructor(config: { apiKey: string; model: string }) {
    this.client = new Anthropic({ apiKey: config.apiKey });
    this.model = config.model;
  }

  async complete(params: LLMCompleteParams): Promise<string> {
    let resp: Anthropic.Messages.Message;
    try {
      resp = await this.client.messages.create({
        model: this.model,
        max_tokens: Math.max(params.maxTokens, AnthropicClient.MIN_MAX_TOKENS),
        ...(params.system
          ? {
              system: [
                {
                  type: "text" as const,
                  text: params.system,
                  cache_control: { type: "ephemeral" as const },
                },
              ],
            }
          : {}),
        messages: [{ role: "user", content: params.user }],
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`${this.label} request failed: ${msg}`);
    }
    const text = textFromResponse(resp);
    if (!text) {
      const kinds = resp.content.map((b) => b.type).join(", ") || "none";
      if (resp.stop_reason === "refusal") {
        const details = (
          resp as { stop_details?: { category?: string | null } | null }
        ).stop_details;
        throw new Error(
          `${this.label} declined the request (stop_reason: refusal; category: ${details?.category ?? "none given"})`,
        );
      }
      throw new Error(
        `${this.label} returned no text (stop_reason: ${resp.stop_reason}; content blocks: ${kinds})`,
      );
    }
    return text;
  }
}
