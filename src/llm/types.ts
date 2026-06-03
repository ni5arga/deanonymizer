/** Provider-agnostic LLM abstraction used by the analysis stage. */

export type Provider = "anthropic" | "openai";

/** A single completion request, normalized across providers. */
export interface LLMCompleteParams {
  /** Optional system prompt. Native Anthropic caches this; OpenAI sends it as a system message. */
  system?: string;
  /** The user-turn content. */
  user: string;
  /** Upper bound on generated tokens. */
  maxTokens: number;
  /** Request a JSON object response where the provider supports it. */
  json?: boolean;
}

/**
 * Minimal text-completion surface. Implementations hide provider-specific
 * request/response shapes and return the assistant's text directly.
 */
export interface LLMClient {
  /** Human-readable provider id, e.g. "anthropic" or "openai (base: …)". */
  readonly label: string;
  /** The resolved model name in use. */
  readonly model: string;
  complete(params: LLMCompleteParams): Promise<string>;
}
