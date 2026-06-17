// ── Provider factory — single entry point for all LLM backends ──

import type {
  ProviderId,
  ProviderConfig,
  ProviderEvent,
  ToolDef,
  AgentMessage,
} from "./types.js";
import { PROVIDER_REGISTRY } from "./types.js";
import { streamAnthropic } from "./anthropic.js";
import { streamOpenAI, completeOpenAI } from "./openai.js";

export * from "./types.js";

export interface LLMProvider {
  streamChat(
    systemPrompt: string,
    messages: AgentMessage[],
    tools: ToolDef[],
  ): AsyncGenerator<ProviderEvent>;
}

/**
 * Create a provider instance from config.
 * Automatically selects the right protocol based on PROVIDER_REGISTRY.
 */
export function createProvider(cfg: ProviderConfig): LLMProvider {
  const meta = PROVIDER_REGISTRY[cfg.provider];
  const protocol = meta?.protocol ?? "openai-completions";
  const baseUrl = cfg.baseUrl ?? meta?.baseUrl;

  const resolvedCfg: ProviderConfig = { ...cfg, baseUrl };

  if (protocol === "anthropic-messages") {
    return {
      async *streamChat(systemPrompt, messages, tools) {
        yield* streamAnthropic(resolvedCfg, systemPrompt, messages, tools);
      },
    };
  }

  // Default: OpenAI-compatible
  return {
    async *streamChat(systemPrompt, messages, tools) {
      yield* streamOpenAI(resolvedCfg, systemPrompt, messages, tools);
    },
  };
}

/**
 * Resolve an API key from multiple sources.
 */
export function resolveApiKey(provider: ProviderId): string | undefined {
  const meta = PROVIDER_REGISTRY[provider];
  if (!meta) return undefined;

  // 1. Direct env var from provider registry
  const key = process.env[meta.keyEnv];
  if (key) return key;

  // 2. IO-prefixed env var (I/O ecosystem standard)
  const ioKey = process.env[`IO_${provider.toUpperCase()}_KEY`];
  if (ioKey) return ioKey;

  // 3. Generic API key
  const generic = process.env["API_KEY"];
  if (generic && provider !== "anthropic") return generic;

  return undefined;
}

/**
 * Detect which providers have API keys configured.
 */
export function detectProviders(): ProviderId[] {
  const result: ProviderId[] = [];
  for (const [id] of Object.entries(PROVIDER_REGISTRY)) {
    if (resolveApiKey(id as ProviderId)) {
      result.push(id as ProviderId);
    }
  }
  return result;
}
