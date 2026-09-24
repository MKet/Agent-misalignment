// ─── Types ────────────────────────────────────────────────────────────────────

export interface OpenRouterConfig {
  apiKey: string;
  baseUrl?: string;
}

export interface InferenceRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
  seed?: number | null;
  maxTokens?: number;
  topP?: number;
  /** Caps how hard the model reasons before responding — leaves the tool call itself unbounded */
  reasoningEffort?: 'low' | 'medium' | 'high';
  /** Explicit reasoning token budget. Must be well under maxTokens or the model can burn its whole budget thinking and never emit the tool call. */
  reasoningMaxTokens?: number;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required: string[];
    };
  };
}

export interface OpenRouterToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface OpenRouterChoice {
  message: {
    role: string;
    content: string | null;
    tool_calls?: OpenRouterToolCall[];
    /** Chain-of-thought reasoning trace (returned when include_reasoning is true) */
    reasoning?: string | null;
  };
  finish_reason: string;
  index: number;
}

export interface OpenRouterUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface OpenRouterResponse {
  id: string;
  model: string;
  choices: OpenRouterChoice[];
  usage: OpenRouterUsage;
  created: number;
}

// ─── Client ───────────────────────────────────────────────────────────────────

/**
 * Thin HTTP wrapper around the OpenRouter chat completions endpoint.
 * Stateless — one instance can be reused across many episodes.
 */
export class OpenRouterClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(config: OpenRouterConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? 'https://openrouter.ai/api/v1';
  }

  async complete(request: InferenceRequest): Promise<OpenRouterResponse> {
    const maxTokens = request.maxTokens ?? 4096;

    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages,
      temperature: request.temperature ?? 0.7,
      max_tokens: maxTokens,
    };

    if (request.seed != null) {
      body.seed = request.seed;
    }

    if (request.topP != null) {
      body.top_p = request.topP;
    }

    if (request.reasoningEffort || request.reasoningMaxTokens != null) {
      // Reasoning tokens are drawn from the same max_tokens budget as the eventual
      // tool call — cap reasoning specifically, but always leave the tool call room to land.
      if (request.reasoningMaxTokens != null) {
        const HEADROOM = 256; // min tokens reserved for the tool call/response after thinking
        if (request.reasoningMaxTokens > maxTokens - HEADROOM) {
          throw new Error(
            `reasoningMaxTokens (${request.reasoningMaxTokens}) leaves less than ${HEADROOM} tokens of headroom under maxTokens (${maxTokens}) for model ${request.model} — the model could exhaust its budget thinking and never emit a tool call. Raise maxTokens or lower reasoningMaxTokens.`,
          );
        }
      }

      const reasoning: Record<string, unknown> = { exclude: false };
      if (request.reasoningEffort) reasoning.effort = request.reasoningEffort;
      if (request.reasoningMaxTokens != null) reasoning.max_tokens = request.reasoningMaxTokens;
      body.reasoning = reasoning;

      // Anthropic's extended thinking rejects any temperature other than 1 (and a custom top_p).
      if (request.model.startsWith('anthropic/')) {
        if (body.temperature !== 1) {
          console.warn(
            `[OpenRouterClient] Overriding temperature to 1 for ${request.model} — Anthropic extended thinking requires default sampling.`,
          );
        }
        body.temperature = 1;
        delete body.top_p;
      }
    } else {
      // Request reasoning/thinking traces when available (no-op for models that don't support it)
      body.include_reasoning = true;
    }

    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools;
      body.tool_choice = 'auto';
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
        'HTTP-Referer': 'https://github.com/model-misalignment-experiment',
        'X-Title': 'Model Misalignment Research Sandbox',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `OpenRouter API error ${response.status} ${response.statusText}: ${errorText}`,
      );
    }

    const data = (await response.json()) as OpenRouterResponse;

    if (!data.choices || data.choices.length === 0) {
      throw new Error('OpenRouter returned an empty choices array');
    }

    return data;
  }
}
