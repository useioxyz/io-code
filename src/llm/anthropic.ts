// ── Anthropic Messages API provider ──

import type {
  ToolDef,
  AgentMessage,
  ProviderConfig,
  ProviderEvent,
} from "./types.js";

function agentToAnthropicMessages(
  messages: AgentMessage[],
): Array<Record<string, unknown>> {
  return messages.map((m) => {
    const content: Array<Record<string, unknown>> = [];
    for (const block of m.content) {
      if (block.type === "text") {
        content.push({ type: "text", text: block.text });
      } else if (block.type === "tool_use") {
        content.push({
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: block.input,
        });
      } else if (block.type === "tool_result") {
        content.push({
          type: "tool_result",
          tool_use_id: block.tool_use_id,
          content: block.content,
          is_error: block.is_error ?? false,
        });
      }
    }
    return { role: m.role, content };
  });
}

function toolsToAnthropic(tools: ToolDef[]): Array<Record<string, unknown>> {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));
}

/**
 * Stream from Anthropic Messages API. Handles text_delta, tool_use,
 * usage, and stop events with proper tool input JSON accumulation.
 */
export async function* streamAnthropic(
  cfg: ProviderConfig,
  systemPrompt: string,
  messages: AgentMessage[],
  tools: ToolDef[],
): AsyncGenerator<ProviderEvent> {
  const body: Record<string, unknown> = {
    model: cfg.model,
    max_tokens: cfg.maxTokens ?? 8000,
    system: systemPrompt,
    messages: agentToAnthropicMessages(messages),
    stream: true,
  };

  if (tools.length > 0) body.tools = toolsToAnthropic(tools);
  if (cfg.temperature !== undefined) body.temperature = cfg.temperature;

  const response = await fetch(cfg.baseUrl ?? "https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": cfg.apiKey ?? "",
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "tools-2024-04-04",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.text().catch(() => "unknown");
    yield { type: "error", message: `Anthropic API ${response.status}: ${error}` };
    return;
  }

  if (!response.body) {
    yield { type: "error", message: "No response body" };
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  // Track tool input accumulation
  const toolInputs = new Map<string, { name: string; json: string }>();
  let currentToolId = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (!data) continue;

        try {
          const ev = JSON.parse(data);

          switch (ev.type) {
            case "message_start":
              break;

            case "content_block_start": {
              const block = ev.content_block;
              if (block?.type === "tool_use") {
                currentToolId = block.id;
                toolInputs.set(block.id, { name: block.name ?? "", json: "" });
                // Live preview — tool name is known before args finish streaming
                if (block.name) {
                  yield { type: "tool_use_preview", id: block.id, name: block.name };
                }
              }
              break;
            }

            case "content_block_delta": {
              const delta = ev.delta;
              if (delta?.type === "text_delta") {
                yield { type: "text_delta", text: delta.text };
              } else if (delta?.type === "input_json_delta") {
                const existing = toolInputs.get(currentToolId);
                if (existing) {
                  existing.json += delta.partial_json;
                }
              }
              break;
            }

            case "content_block_stop": {
              if (currentToolId) {
                const existing = toolInputs.get(currentToolId);
                if (existing && existing.json) {
                  try {
                    const parsed = JSON.parse(existing.json);
                    yield {
                      type: "tool_use",
                      id: currentToolId,
                      name: existing.name || (parsed as Record<string, unknown>).name as string || "unknown",
                      input: existing.name ? parsed : parsed as Record<string, unknown>,
                    };
                  } catch {
                    // Incomplete JSON
                  }
                }
              }
              currentToolId = "";
              break;
            }

            case "message_delta": {
              if (ev.usage) {
                yield {
                  type: "usage",
                  inputTokens: (ev.usage as Record<string, number>).input_tokens ?? 0,
                  outputTokens: (ev.usage as Record<string, number>).output_tokens ?? 0,
                };
              }
              if (ev.delta?.stop_reason) {
                yield { type: "stop", stopReason: ev.delta.stop_reason as string };
              }
              break;
            }

            case "message_stop":
              yield { type: "stop", stopReason: "end_turn" };
              return;

            case "error":
              yield {
                type: "error",
                message: (ev.error as Record<string, string>)?.message ?? "Unknown Anthropic error",
              };
              return;
          }
        } catch {
          // Ignore parse errors for individual events
        }
      }
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }

  yield { type: "stop", stopReason: "stream_end" };
}
