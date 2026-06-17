// ── IO Code Harness — Core agent loop ──

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
  steps?: number;
  filesChanged?: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  error?: string;
}

/**
 * Run the agent loop: plan → act → observe → verify
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
      // Empty response — shouldn't happen but handle gracefully
      yield { type: "done", steps: step + 1, filesChanged, totalInputTokens, totalOutputTokens };
      return;
    }

    messages.push({ role: "assistant", content: assistantContent });

    // If no tool calls, agent is done
    if (!hasToolCallsThisTurn) {
      yield { type: "done", steps: step + 1, filesChanged, totalInputTokens, totalOutputTokens };
      return;
    }

    // Execute tools
    const toolResults: Array<{
      toolUseId: string;
      outcome: ToolOutcome;
      name: string;
    }> = [];

    for (const tc of toolCalls) {
      const outcome = await executeTool(tc.name, tc.input, opts.projectRoot);

      toolResults.push({
        toolUseId: tc.id,
        outcome,
        name: tc.name,
      });

      yield {
        type: "tool_result",
        toolName: tc.name,
        toolOk: outcome.ok,
        toolOutput: outcome.output,
      };

      if (outcome.fileChange) {
        filesChanged++;
      }
    }

    // Feed tool results back as user message
    const toolResultBlocks: ContentBlock[] = toolResults.map(tr => ({
      type: "tool_result",
      tool_use_id: tr.toolUseId,
      content: tr.outcome.output.slice(0, 6000),
      is_error: !tr.outcome.ok,
    }));

    messages.push({ role: "user", content: toolResultBlocks });
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
