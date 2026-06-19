// ── Provider-agnostic normalized types ──

export type ProviderId = "anthropic" | "openai" | "deepseek" | "groq" | "openrouter" | "codex" | "opencode" | "custom";

export interface ProviderMeta {
  id: ProviderId;
  name: string;
  protocol: "anthropic-messages" | "openai-completions" | "codex-cli" | "opencode-cli";
  baseUrl: string;
  defaultModel: string;
  keyEnv: string;
  description: string;
}

export const PROVIDER_REGISTRY: Record<ProviderId, ProviderMeta> = {
  anthropic: {
    id: "anthropic",
    name: "Anthropic (Claude)",
    protocol: "anthropic-messages",
    baseUrl: "https://api.anthropic.com/v1/messages",
    defaultModel: "claude-sonnet-4-6",
    keyEnv: "ANTHROPIC_API_KEY",
    description: "Claude Sonnet/Opus/Haiku — best tool calling",
  },
  openai: {
    id: "openai",
    name: "OpenAI",
    protocol: "openai-completions",
    baseUrl: "https://api.openai.com/v1/chat/completions",
    defaultModel: "gpt-5.1",
    keyEnv: "OPENAI_API_KEY",
    description: "GPT-5.x series",
  },
  deepseek: {
    id: "deepseek",
    name: "DeepSeek",
    protocol: "openai-completions",
    baseUrl: "https://api.deepseek.com/v1/chat/completions",
    defaultModel: "deepseek-v4-pro",
    keyEnv: "DEEPSEEK_API_KEY",
    description: "DeepSeek V4 — best value ($0.14/M)",
  },
  groq: {
    id: "groq",
    name: "Groq",
    protocol: "openai-completions",
    baseUrl: "https://api.groq.com/openai/v1/chat/completions",
    defaultModel: "llama-4-maverick",
    keyEnv: "GROQ_API_KEY",
    description: "Fast inference, free tier available",
  },
  openrouter: {
    id: "openrouter",
    name: "OpenRouter",
    protocol: "openai-completions",
    baseUrl: "https://openrouter.ai/api/v1/chat/completions",
    defaultModel: "anthropic/claude-sonnet-4",
    keyEnv: "OPENROUTER_API_KEY",
    description: "Multi-provider gateway — access all models",
  },
  codex: {
    id: "codex",
    name: "OpenAI Codex (OAuth)",
    protocol: "codex-cli",
    baseUrl: "",
    defaultModel: "gpt-5.5-codex",
    keyEnv: "OPENAI_CODEX_AUTH_TOKEN",
    description: "OpenAI Codex CLI — OAuth device flow, no API key needed",
  },
  opencode: {
    id: "opencode",
    name: "OpenCode (Go)",
    protocol: "opencode-cli",
    baseUrl: "",
    defaultModel: "deepseek-v4-pro",
    keyEnv: "OPENCODE_API_KEY",
    description: "OpenCode Go CLI — multi-provider via subprocess (DeepSeek, Anthropic, OpenAI)",
  },
  custom: {
    id: "custom",
    name: "Custom",
    protocol: "openai-completions",
    baseUrl: "http://localhost:11434/v1/chat/completions",
    defaultModel: "llama3",
    keyEnv: "CUSTOM_API_KEY",
    description: "Custom OpenAI-compatible endpoint (Ollama, etc.)",
  },
};

export const MODEL_PRESETS: Record<ProviderId, Array<{ id: string; name: string; description: string }>> = {
  anthropic: [
    { id: "claude-opus-4-8", name: "Claude Opus 4", description: "Strongest reasoning" },
    { id: "claude-sonnet-4-6", name: "Claude Sonnet 4", description: "Best balance" },
    { id: "claude-haiku-4-5", name: "Claude Haiku 4", description: "Fast & cheap" },
  ],
  openai: [
    { id: "gpt-5.1", name: "GPT-5.1", description: "Latest flagship" },
    { id: "gpt-5.1-mini", name: "GPT-5.1 Mini", description: "Fast, cheaper" },
  ],
  deepseek: [
    { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", description: "Best reasoning" },
    { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", description: "Fast & cheap ($0.14/M)" },
  ],
  groq: [
    { id: "llama-4-maverick", name: "Llama 4 Maverick", description: "Best free model" },
    { id: "llama-4-scout", name: "Llama 4 Scout", description: "Free, weak tool calling" },
  ],
  openrouter: [
    { id: "anthropic/claude-sonnet-4", name: "Claude Sonnet 4", description: "via OpenRouter" },
    { id: "anthropic/claude-opus-4", name: "Claude Opus 4", description: "via OpenRouter" },
    { id: "openai/gpt-5.1", name: "GPT-5.1", description: "via OpenRouter" },
    { id: "deepseek/deepseek-v4-pro", name: "DeepSeek V4 Pro", description: "via OpenRouter" },
  ],
  codex: [
    { id: "gpt-5.5-codex", name: "GPT-5.5 Codex", description: "Codex CLI (OAuth)" },
    { id: "gpt-5-codex", name: "GPT-5 Codex", description: "Codex CLI (OAuth)" },
  ],
  opencode: [
    { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", description: "via OpenCode Go" },
    { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", description: "via OpenCode Go (fast)" },
    { id: "claude-sonnet-4-6", name: "Claude Sonnet 4", description: "via OpenCode Go" },
  ],
  custom: [
    { id: "custom-model", name: "Custom Model", description: "Configure in .iorc" },
  ],
};

// Provider pricing per 1M tokens
export const PROVIDER_PRICING: Record<string, { input: number; output: number }> = {
  "claude-opus-4-8": { input: 15, output: 75 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 0.8, output: 4 },
  "gpt-5.1": { input: 5, output: 20 },
  "gpt-5.1-mini": { input: 0.5, output: 2 },
  "deepseek-v4-pro": { input: 0.14, output: 0.28 },
  "deepseek-v4-flash": { input: 0.07, output: 0.14 },
};

// ── Agent message types ──

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export interface AgentMessage {
  role: "user" | "assistant";
  content: ContentBlock[];
}

// ── Tool definition ──

export interface ToolDef {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, {
      type: string;
      description: string;
      default?: unknown;
      enum?: string[];
      items?: { type: string };
    }>;
    required?: string[];
  };
}

// ── Provider event stream ──

export type ProviderEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_use_preview"; id: string; name: string }
  | { type: "tool_result"; tool_use_id: string; content: string }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "stop"; stopReason: string }
  | { type: "error"; message: string };

export interface ProviderConfig {
  provider: ProviderId;
  apiKey?: string;
  model: string;
  baseUrl?: string;
  maxTokens?: number;
  temperature?: number;
}
