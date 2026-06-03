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
  private readonly client: Anthropic;

  constructor(config: { apiKey: string; model: string }) {
    this.client = new Anthropic({ apiKey: config.apiKey });
    this.model = config.model;
  }

  async complete(params: LLMCompleteParams): Promise<string> {
    const resp = await this.client.messages.create({
      model: this.model,
      max_tokens: params.maxTokens,
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
    return textFromResponse(resp);
  }
}
