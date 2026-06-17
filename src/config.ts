// ── IO Code Config — BYOK resolution ──

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as YAML from "yaml";
import type { ProviderId } from "./llm/types.js";
import { PROVIDER_REGISTRY, MODEL_PRESETS, resolveApiKey } from "./llm/index.js";

export interface IOConfig {
  provider?: ProviderId;
  model?: string;
  baseUrl?: string;
  keys?: Record<string, string>;
  temperature?: number;
  maxSteps?: number;
  compactThreshold?: number;
  // MCP servers
  mcp_servers?: Record<string, {
    command?: string;
    args?: string[];
    url?: string;
    headers?: Record<string, string>;
    env?: Record<string, string>;
  }>;
}

/**
 * Resolve config from multiple sources (priority: highest first)
 * 1. CLI flags
 * 2. Env vars
 * 3. Project-local .iorc.yaml
 * 4. Global ~/.iorc.yaml
 */
export function loadConfig(
  projectRoot: string,
  cliOverrides?: Partial<IOConfig>,
): IOConfig {
  // 1. Global config
  const global: IOConfig = loadConfigFile(path.join(os.homedir(), ".iorc.yaml"));

  // 2. Project-local config
  const local: IOConfig = loadConfigFile(path.join(projectRoot, ".iorc.yaml"));

  // 3. Env vars
  const env: IOConfig = loadEnvConfig();

  // Merge: global < local < env < CLI
  const merged = mergeConfigs(global, local);
  const merged2 = mergeConfigs(merged, env);
  const final = cliOverrides ? mergeConfigs(merged2, cliOverrides) : merged2;

  // Ensure provider defaults
  if (!final.provider) {
    // Auto-detect from available keys
    if (resolveApiKey("anthropic")) final.provider = "anthropic";
    else if (resolveApiKey("deepseek")) final.provider = "deepseek";
    else if (resolveApiKey("openai")) final.provider = "openai";
    else if (resolveApiKey("groq")) final.provider = "groq";
  }

  if (final.provider && !final.model) {
    final.model = PROVIDER_REGISTRY[final.provider]?.defaultModel;
  }

  return final;
}

function loadConfigFile(filePath: string): IOConfig {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return YAML.parse(content) ?? {};
  } catch {
    return {};
  }
}

function loadEnvConfig(): IOConfig {
  const config: IOConfig = {};

  // Provider from env
  if (process.env.IO_PROVIDER) {
    const prov = process.env.IO_PROVIDER.toLowerCase();
    if (prov in PROVIDER_REGISTRY) config.provider = prov as ProviderId;
  }

  // Model from env
  if (process.env.IO_MODEL) config.model = process.env.IO_MODEL;

  // Keys
  config.keys = {};
  for (const [id, meta] of Object.entries(PROVIDER_REGISTRY)) {
    const key = process.env[meta.keyEnv];
    if (key) config.keys[id] = key;
  }

  // IO-specific env vars
  if (process.env.IO_ANTHROPIC_KEY) config.keys["anthropic"] = process.env.IO_ANTHROPIC_KEY;
  if (process.env.IO_OPENAI_KEY) config.keys["openai"] = process.env.IO_OPENAI_KEY;
  if (process.env.IO_DEEPSEEK_KEY) config.keys["deepseek"] = process.env.IO_DEEPSEEK_KEY;
  if (process.env.IO_GROQ_KEY) config.keys["groq"] = process.env.IO_GROQ_KEY;
  if (process.env.IO_OPENROUTER_KEY) config.keys["openrouter"] = process.env.IO_OPENROUTER_KEY;

  if (Object.keys(config.keys).length === 0) delete config.keys;

  // Temperature
  if (process.env.IO_TEMPERATURE) {
    config.temperature = parseFloat(process.env.IO_TEMPERATURE);
  }

  return config;
}

function mergeConfigs(base: IOConfig, override: Partial<IOConfig>): IOConfig {
  return {
    ...base,
    ...override,
    keys: { ...(base.keys ?? {}), ...(override.keys ?? {}) },
  };
}

/**
 * Save config back to disk.
 */
export function saveConfig(config: IOConfig, global: boolean, projectRoot?: string): void {
  const filePath = global
    ? path.join(os.homedir(), ".iorc.yaml")
    : path.join(projectRoot ?? ".", ".iorc.yaml");

  const toWrite: Record<string, unknown> = {};
  if (config.provider) toWrite.provider = config.provider;
  if (config.model) toWrite.model = config.model;
  if (config.baseUrl) toWrite.baseUrl = config.baseUrl;
  if (config.keys && Object.keys(config.keys).length > 0) {
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(config.keys)) {
      if (v) clean[k] = v;
    }
    if (Object.keys(clean).length > 0) toWrite.keys = clean;
  }
  if (config.temperature !== undefined) toWrite.temperature = config.temperature;
  if (config.maxSteps !== undefined) toWrite.maxSteps = config.maxSteps;

  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, YAML.stringify(toWrite), "utf-8");
  } catch {
    // Silently fail
  }
}

/**
 * Get the effective API key for a provider from config + env.
 */
export function getApiKey(config: IOConfig, provider: ProviderId): string | undefined {
  return config.keys?.[provider] ?? resolveApiKey(provider);
}
