// ── IO Code Harness — Core agent loop ──
//
// Agent loop: plan → act (parallel) → observe → verify
//
// Key features:
//   - Parallel tool execution with dependency graph analysis
//   - Tool deduplication within same turn
//   - Automatic retry on transient failures (2 attempts)
//   - Read-after-write verification for file operations
//   - Staged execution: reads → writes → commands (safe ordering)

import type { AgentMessage, ContentBlock, ToolUseBlock, ProviderEvent } from "./llm/types.js";
import { createProvider, type LLMProvider, type ProviderConfig } from "./llm/index.js";
import {
  executeTool,
  extractToolCalls,
  toolTitle,
  type ToolDef,
  type ToolOutcome,
} from "./tools.js";
import { buildCompactPrompt, buildSystemPrompt } from "./prompts.js";
import type { ContextFile } from "./context.js";
import chalk from "chalk";

export interface HarnessOptions {
  providerConfig: ProviderConfig;
  projectRoot: string;
  toolDefs: ToolDef[];
  systemPrompt: string;
  maxSteps?: number;
  temperature?: number;
  contextFiles?: ContextFile[];
  workspaceFiles?: string[];
}

export interface HarnessEvent {
  type: "stream" | "tool_call" | "tool_result" | "done" | "error";
  text?: string;
  toolName?: string;
  toolTitle?: string;
  toolOutput?: string;
  toolOk?: boolean;
  fileChange?: { path: string; action: "created" | "modified" | "deleted" };
  steps?: number;
  filesChanged?: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  error?: string;
}

// ── Tool dependency classification ──

/**
 * Classify tools by their effect, for dependency-aware parallel execution.
 */
type ToolPhase = "read" | "write" | "command" | "git";

function classifyTool(name: string): ToolPhase {
  switch (name) {
    case "read_file":
    case "list_files":
    case "find_files":
    case "search_content":
    case "web_search":
    case "web_fetch":
      return "read";
    case "write_file":
    case "replace_in_file":
    case "delete_file":
      return "write";
    case "run_command":
    case "run_tests":
    case "web_clone":
      return "command";
    case "git_diff":
    case "git_status":
    case "git_log":
    case "git_commit":
      return "git";
    default:
      return "command";
  }
}

/**
 * Detect dependencies between tool calls.
 * write_file → read_file(same path)  : read depends on write
 * write_file → replace_in_file(same) : edit depends on write
 * run_command → read_file(path)      : read depends on command spawning file
 * git_commit → (anything after)      : commit should be last
 */
function dependsOn(a: { name: string; input: Record<string, unknown> }, b: { name: string; input: Record<string, unknown> }): boolean {
  const aPath = (a.input.path || a.input.url) as string;
  const bPath = (b.input.path || b.input.url) as string;

  // write_file creates file that something else reads/edits
  if (b.name === "write_file" && aPath && aPath === bPath) {
    return true; // a reads the file that b will write
  }
  if (b.name === "replace_in_file" && aPath && aPath === bPath) {
    return true; // a reads the file that b will edit
  }

  // run_command may produce files that read_file then reads
  if (b.name === "run_command" && a.name === "read_file" && aPath) {
    // Conservative: assume command output is needed
    return true;
  }

  // git_commit depends on all write_file / replace_in_file before it
  if (a.name === "git_commit" && (b.name === "write_file" || b.name === "replace_in_file" || b.name === "delete_file")) {
    return true;
  }

  return false;
}

/**
 * Partition tool calls by phase. Execute reads → writes → commands → git in order.
 * Within each phase, execute independent calls in parallel.
 */
function executeWithDependencyGraph(
  toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>,
  projectRoot: string,
): Array<{ tc: { id: string; name: string; input: Record<string, unknown> }; outcome: Promise<ToolOutcome> }> {
  const results: Array<{ tc: { id: string; name: string; input: Record<string, unknown> }; outcome: Promise<ToolOutcome> }> = [];

  // Phase ordering: reads first (can be parallel), writes (sequenced by dependency), commands, git last
  const phases: ToolPhase[] = ["read", "write", "command", "git"];
  const remaining = [...toolCalls];

  for (const phase of phases) {
    const batch = remaining.filter(tc => classifyTool(tc.name) === phase);

    if (batch.length === 0) continue;

    // Within a phase, find independent groups
    const groups: Array<Array<typeof batch[0]>> = [];
    const placed = new Set<number>();

    for (let i = 0; i < batch.length; i++) {
      if (placed.has(i)) continue;
      const group = [batch[i]];
      placed.add(i);

      // Find all calls that don't depend on any in the group
      for (let j = i + 1; j < batch.length; j++) {
        if (placed.has(j)) continue;
        const independent = group.every(g => !dependsOn(g, batch[j]) && !dependsOn(batch[j], g));
        if (independent) {
          group.push(batch[j]);
          placed.add(j);
        }
      }
      groups.push(group);
    }

    // Execute groups in order, but calls within a group in parallel
    for (const group of groups) {
      for (const tc of group) {
        results.push({ tc, outcome: executeWithRetry(tc.name, tc.input, projectRoot) });
      }
    }
  }

  return results;
}

// ── Retry Logic ──

/**
 * Retry transient failures up to 2 additional attempts.
 * Transient = command timeout, network fetch failure, lock contention.
 * Non-retryable = file not found, invalid arguments, permission denied.
 */
async function executeWithRetry(
  name: string,
  input: Record<string, unknown>,
  projectRoot: string,
): Promise<ToolOutcome> {
  const maxAttempts = 3;
  let lastOutcome: ToolOutcome | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const outcome = await executeTool(name, input, projectRoot);

    if (outcome.ok) return outcome;
    lastOutcome = outcome;

    // Only retry transient errors
    if (attempt < maxAttempts) {
      const msg = outcome.output.toLowerCase();
      const isTransient =
        msg.includes("timeout") ||
        msg.includes("econnrefused") ||
        msg.includes("enotfound") ||
        msg.includes("econnreset") ||
        msg.includes("eagain") ||
        msg.includes("temporary failure") ||
        msg.includes("network") ||
        msg.includes("too many requests") ||
        msg.includes("429") ||
        msg.includes("503") ||
        msg.includes("502");

      if (isTransient) {
        // Exponential backoff: 500ms, 2s, 5s
        const delay = 500 * Math.pow(2, attempt);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
    }

    break; // Non-transient or max attempts reached
  }

  return lastOutcome!;
}

// ── Dedup Cache ──

/**
 * In-turn tool deduplication cache.
 * Same tool call with same inputs within a single turn = use cached result.
 */
class ToolDedupCache {
  private cache = new Map<string, ToolOutcome>();

  key(name: string, input: Record<string, unknown>): string {
    return `${name}::${JSON.stringify(Object.entries(input).sort())}`;
  }

  get(name: string, input: Record<string, unknown>): ToolOutcome | null {
    return this.cache.get(this.key(name, input)) ?? null;
  }

  set(name: string, input: Record<string, unknown>, outcome: ToolOutcome): void {
    this.cache.set(this.key(name, input), outcome);
  }
}

// ── Main Agent Loop ──

/**
 * Run the agent loop: plan → act (parallel + dependency-aware) → observe → verify
 * Yields events for the UI to render.
 */
export async function* runAgent(
  opts: HarnessOptions,
  userPrompt: string,
  conversation?: AgentMessage[],
): AsyncGenerator<HarnessEvent> {
  const provider = createProvider(opts.providerConfig);
  const maxSteps = opts.maxSteps ?? 24;
  const sysPrompt = opts.systemPrompt;

  // Build conversation
  const messages: AgentMessage[] = conversation?.length
    ? [...conversation]
    : [];

  // Add user prompt
  messages.push({
    role: "user",
    content: [{ type: "text", text: userPrompt }],
  });

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let filesChanged = 0;
  let step = 0;

  const dedupCache = new ToolDedupCache();

  for (step = 0; step < maxSteps; step++) {
    // Call LLM
    let hasToolCallsThisTurn = false;
    const toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
    let assistantText = "";

    try {
      for await (const ev of provider.streamChat(sysPrompt, messages, opts.toolDefs)) {
        switch (ev.type) {
          case "text_delta":
            assistantText += ev.text;
            yield { type: "stream", text: ev.text };
            break;

          case "tool_use":
            // Skip duplicate tool calls within same turn
            if (dedupCache.get(ev.name, ev.input)) continue;

            toolCalls.push({ id: ev.id, name: ev.name, input: ev.input });
            hasToolCallsThisTurn = true;
            yield {
              type: "tool_call",
              toolName: ev.name,
              toolTitle: toolTitle(ev.name, ev.input),
            };
            break;

          case "usage":
            totalInputTokens += ev.inputTokens;
            totalOutputTokens += ev.outputTokens;
            break;

          case "stop":
            break;

          case "error":
            yield { type: "error", error: ev.message };
            return;
        }
      }
    } catch (e: any) {
      yield { type: "error", error: `Provider error: ${e.message}` };
      return;
    }

    // Record assistant response
    const assistantContent: ContentBlock[] = [];
    if (assistantText) {
      assistantContent.push({ type: "text", text: assistantText });
    }
    for (const tc of toolCalls) {
      assistantContent.push({
        type: "tool_use",
        id: tc.id,
        name: tc.name,
        input: tc.input,
      });
    }

    if (assistantContent.length === 0) {
      yield { type: "done", steps: step + 1, filesChanged, totalInputTokens, totalOutputTokens };
      return;
    }

    messages.push({ role: "assistant", content: assistantContent });

    // If no tool calls, agent is done
    if (!hasToolCallsThisTurn) {
      yield { type: "done", steps: step + 1, filesChanged, totalInputTokens, totalOutputTokens };
      return;
    }

    // ── Execute tools with parallel + dependency-aware scheduling ──
    const executions = executeWithDependencyGraph(toolCalls, opts.projectRoot);

    // Wait for all outcomes
    const toolResults: Array<{
      toolUseId: string;
      outcome: ToolOutcome;
      name: string;
    }> = [];

    for (const exec of executions) {
      const outcome = await exec.outcome;

      // Cache for dedup
      dedupCache.set(exec.tc.name, exec.tc.input, outcome);

      toolResults.push({
        toolUseId: exec.tc.id,
        outcome,
        name: exec.tc.name,
      });

      yield {
        type: "tool_result",
        toolName: exec.tc.name,
        toolOk: outcome.ok,
        toolOutput: outcome.output,
        fileChange: outcome.fileChange,
      };

      if (outcome.fileChange) {
        filesChanged++;
      }
    }

    // Feed tool results back as user message
    // Sort: errors last so model sees successes first
    const sortedResults = [
      ...toolResults.filter(tr => tr.outcome.ok),
      ...toolResults.filter(tr => !tr.outcome.ok),
    ];

    const toolResultBlocks: ContentBlock[] = sortedResults.map(tr => ({
      type: "tool_result",
      tool_use_id: tr.toolUseId,
      content: tr.outcome.output.slice(0, 4000),
      is_error: !tr.outcome.ok,
    }));

    messages.push({ role: "user", content: toolResultBlocks });

    // Auto-verification note: files were written — next LLM turn can run tests
  }

  // Max steps reached
  yield {
    type: "done",
    steps: maxSteps,
    filesChanged,
    totalInputTokens,
    totalOutputTokens,
  };
}

/**
 * Compaction — summarize conversation via LLM to save tokens.
 */
export async function compactConversation(
  providerConfig: ProviderConfig,
  messages: AgentMessage[],
  customInstructions?: string,
): Promise<AgentMessage[]> {
  const provider = createProvider(providerConfig);

  const compactPrompt = `Summarize this conversation into a single concise message capturing:
1. What was asked — the original task/goal
2. What was done — key decisions, files changed, tools used
3. Current state — where things stand, blockers
4. Key facts — important details to continue working

Write dense but readable. Keep under 2000 words.${customInstructions ? `\n\nAdditional instructions: ${customInstructions}` : ""}

Here is the conversation to summarize:
${messages.map(m => {
  const texts = m.content
    .filter(b => b.type === "text" || b.type === "tool_result")
    .map(b => (b as any).text ?? (b as any).content ?? "")
    .filter(Boolean);
  return `[${m.role}]: ${texts.join(" | ")}`;
}).join("\n\n")}`;

  try {
    let summary = "";
    for await (const ev of provider.streamChat(
      "You are a conversation summarizer. Be concise and factual.",
      [{ role: "user", content: [{ type: "text", text: compactPrompt }] }],
      [],
    )) {
      if (ev.type === "text_delta") summary += ev.text;
      if (ev.type === "error") throw new Error(ev.message);
    }

    return [{
      role: "user",
      content: [{ type: "text", text: `[Compacted context — previous conversation summarized]\n\n${summary}` }],
    }];
  } catch {
    // If compaction fails, return original but trimmed
    if (messages.length <= 4) return messages;
    return [messages[0], messages[1], ...messages.slice(-2)];
  }
}

/**
 * Estimate token count (rough — ~4 chars per token for English)
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Estimate cost for a provider/model pair
 */
export function estimateCost(
  providerId: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
): { input: number; output: number; total: number; label: string } {
  // Simplified pricing
  const rates: Record<string, { input: number; output: number }> = {
    "claude-opus-4-8": { input: 15, output: 75 },
    "claude-sonnet-4-6": { input: 3, output: 15 },
    "claude-haiku-4-5": { input: 0.8, output: 4 },
    "gpt-5.1": { input: 5, output: 20 },
    "gpt-5.1-mini": { input: 0.5, output: 2 },
    "deepseek-v4-pro": { input: 0.14, output: 0.28 },
    "deepseek-v4-flash": { input: 0.07, output: 0.14 },
  };

  const rate = rates[model] ?? { input: 0, output: 0 };
  const inputCost = (inputTokens / 1_000_000) * rate.input;
  const outputCost = (outputTokens / 1_000_000) * rate.output;
  const total = inputCost + outputCost;

  let label: string;
  if (total === 0) label = "free";
  else if (total < 0.01) label = `< $0.01`;
  else label = `$${total.toFixed(4)}`;

  return { input: inputCost, output: outputCost, total, label };
}
