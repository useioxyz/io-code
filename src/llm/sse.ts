// ── SSE stream parser for both Anthropic and OpenAI ──

export interface SSECallbacks {
  onText: (text: string) => void;
  onToolUse: (id: string, name: string, input: Record<string, unknown>) => void;
  onUsage: (inputTokens: number, outputTokens: number) => void;
  onStop: (reason: string) => void;
  onError: (message: string) => void;
}

/**
 * Parse an Anthropic SSE stream.
 * Events: message_start, content_block_start/delta, message_delta, message_stop, ping
 */
export async function parseAnthropicSSE(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  cb: SSECallbacks,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  const toolInputs = new Map<string, string>(); // accumulate JSON fragments per tool ID

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
            case "content_block_start": {
              const block = ev.content_block;
              if (block?.type === "tool_use") {
                toolInputs.set(block.id, "");
              }
              break;
            }
            case "content_block_delta": {
              const delta = ev.delta;
              if (delta?.type === "text_delta") {
                cb.onText(delta.text);
              } else if (delta?.type === "input_json_delta") {
                const cur = toolInputs.get(ev.index?.toString() ?? "") ?? "";
                toolInputs.set(ev.index?.toString() ?? "", cur + delta.partial_json);
              }
              break;
            }
            case "content_block_stop": {
              // Try to finalize accumulated tool input
              break;
            }
            case "message_delta": {
              if (ev.usage) {
                cb.onUsage(ev.usage.input_tokens ?? 0, ev.usage.output_tokens ?? 0);
              }
              break;
            }
            case "message_stop": {
              cb.onStop("end_turn");
              // Flush accumulated tool inputs
              for (const [id, json] of toolInputs) {
                if (json) {
                  try {
                    const parsed = JSON.parse(json);
                    cb.onToolUse(id, parsed.name ?? "unknown", parsed.input ?? parsed);
                  } catch {
                    // Partial tool input — ignore
                  }
                }
              }
              return;
            }
            case "error": {
              cb.onError(ev.error?.message ?? "Unknown error");
              return;
            }
          }
        } catch {
          // Ignore parse errors on individual events
        }
      }
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

/**
 * Parse an OpenAI-compatible SSE stream.
 * Events: chat.completion.chunk with choices[0].delta
 */
export async function parseOpenAISSE(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  cb: SSECallbacks,
): Promise<void> {
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
          // Flush completed tool calls
          for (const [, tc] of toolCalls) {
            if (tc.name && tc.args) {
              try {
                cb.onToolUse(tc.id, tc.name, JSON.parse(tc.args));
              } catch {
                cb.onError(`Failed to parse tool args for ${tc.name}`);
              }
            }
          }
          cb.onStop("stop");
          return;
        }

        try {
          const ev = JSON.parse(data);
          const choices = ev.choices;
          if (!choices?.length) continue;

          const delta = choices[0].delta;
          if (!delta) {
            // Usage may come in final chunk
            if (ev.usage) {
              cb.onUsage(ev.usage.prompt_tokens ?? 0, ev.usage.completion_tokens ?? 0);
            }
            continue;
          }

          if (delta.content) {
            cb.onText(delta.content);
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
          // Ignore parse errors
        }
      }
    }

    // Stream ended without [DONE]
    cb.onStop("stream_end");
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

/**
 * Non-streaming SSE — collect entire body then parse as JSON.
 * Used for fallback when streaming fails.
 */
export async function collectResponse(response: Response): Promise<string> {
  return response.text();
}
