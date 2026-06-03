import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

export type LLMProviderKind = "anthropic" | "openai";

export function detectProvider(): LLMProviderKind {
  const val = process.env.LLM_PROVIDER?.toLowerCase();
  if (val === "openai") return "openai";
  return "anthropic";
}

export interface LLMCreateParams {
  model: string;
  max_tokens: number;
  system?: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
}

export interface LLMResponse {
  content: string;
}

export interface LLMClient {
  send(params: LLMCreateParams): Promise<LLMResponse>;
}

class AnthropicAdapter implements LLMClient {
  constructor(private client: Anthropic) {}

  async send(params: LLMCreateParams): Promise<LLMResponse> {
    const system = params.system
      ? [
          {
            type: "text" as const,
            text: params.system,
            cache_control: { type: "ephemeral" as const },
          },
        ]
      : undefined;

    const resp = await this.client.messages.create({
      model: params.model,
      max_tokens: params.max_tokens,
      system,
      messages: params.messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
    });

    const text = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    return { content: text };
  }
}

class OpenAIAdapter implements LLMClient {
  constructor(private client: OpenAI) {}

  async send(params: LLMCreateParams): Promise<LLMResponse> {
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];

    if (params.system) {
      messages.push({ role: "system", content: params.system });
    }

    for (const m of params.messages) {
      if (m.role === "user") {
        messages.push({ role: "user", content: m.content });
      } else {
        messages.push({ role: "assistant", content: m.content });
      }
    }

    const resp = await this.client.chat.completions.create({
      model: params.model,
      max_tokens: params.max_tokens,
      messages,
    });

    return { content: resp.choices[0]?.message?.content ?? "" };
  }
}

export function resolveModel(provider: LLMProviderKind): string {
  if (provider === "openai") {
    return process.env.OPENAI_MODEL ?? "gpt-4o-mini";
  }
  return process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5";
}

export function resolveApiKey(provider: LLMProviderKind): string | undefined {
  if (provider === "openai") {
    return process.env.OPENAI_API_KEY;
  }
  return process.env.ANTHROPIC_API_KEY;
}

export function createLLMClient(
  provider: LLMProviderKind,
  apiKey: string,
): LLMClient {
  if (provider === "openai") {
    const baseURL = process.env.OPENAI_BASE_URL || undefined;
    const opts: Record<string, unknown> = { apiKey };
    if (baseURL) opts.baseURL = baseURL;
    return new OpenAIAdapter(new OpenAI(opts as any));
  }

  return new AnthropicAdapter(new Anthropic({ apiKey }));
}
