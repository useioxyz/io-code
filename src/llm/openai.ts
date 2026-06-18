// ── OpenAI-compatible provider (OpenAI, DeepSeek, Groq, OpenRouter, custom) ──

import type {
  ToolDef,
  AgentMessage,
  ProviderConfig,
  ProviderEvent,
} from "./types.js";
import { parseOpenAISSE } from "./sse.js";

function agentToOpenAIMessages(
  messages: AgentMessage[],
): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [];

  for (const m of messages) {
    const textParts: string[] = [];
    const toolCalls: Array<Record<string, unknown>> = [];
    const toolResults: Array<{ tool_call_id: string; content: string }> = [];

    for (const block of m.content) {
      if (block.type === "text") {
        textParts.push(block.text);
      } else if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          type: "function",
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input),
          },
        });
      } else if (block.type === "tool_result") {
        toolResults.push({
          tool_call_id: block.tool_use_id,
          content: block.content,
        });
      }
    }

    // Tool results → separate messages with role: "tool" (OpenAI format)
    for (const tr of toolResults) {
      result.push({
        role: "tool",
        tool_call_id: tr.tool_call_id,
        content: tr.content,
      });
    }

    // Main message
    if (toolCalls.length > 0) {
      // Assistant message with tool calls — content as plain string or null
      result.push({
        role: "assistant",
        content: textParts.join("\n") || null,
        tool_calls: toolCalls,
      });
    } else if (textParts.length > 0) {
      // Plain text message — content as plain string (max compatibility)
      result.push({
        role: m.role,
        content: textParts.join("\n"),
      });
    } else if (toolResults.length === 0) {
      // Empty message — skip entirely
      continue;
    }
  }

  return result;
}

function toolsToOpenAI(tools: ToolDef[]): Array<Record<string, unknown>> {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));
}

/**
 * Stream from OpenAI-compatible endpoint.
 * Works with: OpenAI, DeepSeek, Groq, OpenRouter, vLLM, Ollama, etc.
 */
export async function* streamOpenAI(
  cfg: ProviderConfig,
  systemPrompt: string,
  messages: AgentMessage[],
  tools: ToolDef[],
): AsyncGenerator<ProviderEvent> {
  const body: Record<string, unknown> = {
    model: cfg.model,
    messages: [
      { role: "system", content: systemPrompt },
      ...agentToOpenAIMessages(messages),
    ],
    max_tokens: cfg.maxTokens ?? 8000,
    stream: true,
  };

  if (tools.length > 0) {
    body.tools = toolsToOpenAI(tools);
    body.tool_choice = "auto";
  }

  if (cfg.temperature !== undefined) body.temperature = cfg.temperature;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${cfg.apiKey}`,
  };

  // OpenRouter requires extra headers
  if (cfg.baseUrl?.includes("openrouter.ai")) {
    headers["HTTP-Referer"] = "https://useio.xyz";
    headers["X-Title"] = "IO Code";
  }

  let url = cfg.baseUrl ?? "https://api.openai.com/v1/chat/completions";
  // Make sure URL ends with /chat/completions
  if (!url.endsWith("/chat/completions")) {
    if (url.endsWith("/")) url = url.slice(0, -1);
    if (!url.endsWith("/v1")) url += "/v1";
    url += "/chat/completions";
  }

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "unknown");
    yield { type: "error", message: `API ${response.status}: ${text.slice(0, 500)}` };
    return;
  }

  if (!response.body) {
    yield { type: "error", message: "No response body" };
    return;
  }

  yield* parseOpenAIStream(response.body.getReader());
}

async function* parseOpenAIStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<ProviderEvent> {
  const decoder = new TextDecoder();
  let buffer = "";
  const toolCalls = new Map<number, { id: string; name: string; args: string }>();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) continue;
        const data = trimmed.slice(6);
        if (data === "[DONE]") {
          // Flush tool calls
          for (const [, tc] of toolCalls) {
            if (tc.name && tc.args) {
              try {
                yield {
                  type: "tool_use",
                  id: tc.id,
                  name: tc.name,
                  input: JSON.parse(tc.args),
                };
              } catch {
                // Skip malformed
              }
            }
          }
          yield { type: "stop", stopReason: "stop" };
          return;
        }

        try {
          const ev = JSON.parse(data);
          const choices = ev.choices;
          if (!choices?.length) {
            if (ev.usage) {
              yield {
                type: "usage",
                inputTokens: ev.usage.prompt_tokens ?? ev.usage.prompt_token_count ?? 0,
                outputTokens: ev.usage.completion_tokens ?? ev.usage.candidates_token_count ?? 0,
              };
            }
            continue;
          }

          const delta = choices[0].delta;
          if (!delta) continue;

          if (delta.content) {
            yield { type: "text_delta", text: delta.content };
          }

          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              const existing = toolCalls.get(idx) ?? { id: "", name: "", args: "" };
              if (tc.id) existing.id = tc.id;
              if (tc.function?.name) existing.name += tc.function.name;
              if (tc.function?.arguments) existing.args += tc.function.arguments;
              toolCalls.set(idx, existing);
            }
          }
        } catch {
          // Ignore
        }
      }
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }

  // Flush remaining tool calls
  for (const [, tc] of toolCalls) {
    if (tc.name && tc.args) {
      try {
        yield { type: "tool_use", id: tc.id, name: tc.name, input: JSON.parse(tc.args) };
      } catch {}
    }
  }
  yield { type: "stop", stopReason: "stream_end" };
}

/**
 * Non-streaming completion — fallback for providers that don't stream well.
 */
export async function completeOpenAI(
  cfg: ProviderConfig,
  systemPrompt: string,
  messages: AgentMessage[],
  tools: ToolDef[],
): Promise<{ text: string; toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>; usage: { input: number; output: number } }> {
  const body: Record<string, unknown> = {
    model: cfg.model,
    messages: [
      { role: "system", content: systemPrompt },
      ...agentToOpenAIMessages(messages),
    ],
    max_tokens: cfg.maxTokens ?? 8000,
  };

  if (tools.length > 0) body.tools = toolsToOpenAI(tools);
  if (cfg.temperature !== undefined) body.temperature = cfg.temperature;

  let url = cfg.baseUrl ?? "https://api.openai.com/v1/chat/completions";
  if (!url.endsWith("/chat/completions")) {
    if (url.endsWith("/")) url = url.slice(0, -1);
    if (!url.endsWith("/v1")) url += "/v1";
    url += "/chat/completions";
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "unknown");
    throw new Error(`API ${response.status}: ${text.slice(0, 500)}`);
  }

  const data = await response.json();
  const choice = data.choices?.[0];
  const message = choice?.message ?? {};
  const content = message.content ?? "";
  const usage = {
    input: data.usage?.prompt_tokens ?? 0,
    output: data.usage?.completion_tokens ?? 0,
  };

  const toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
  if (message.tool_calls) {
    for (const tc of message.tool_calls) {
      try {
        toolCalls.push({
          id: tc.id,
          name: tc.function?.name ?? "unknown",
          input: tc.function?.arguments ? JSON.parse(tc.function.arguments) : {},
        });
      } catch {}
    }
  }

  return { text: content, toolCalls, usage };
}
