// ── OpenCode Go CLI Provider ──
// Wraps the OpenCode CLI via subprocess. Same pattern as codex provider.
//
// Install: go install github.com/nicholasgriffintn/opencode-go@latest
// Auth: export DEEPSEEK_API_KEY=sk-... (or ANTHROPIC_API_KEY, OPENAI_API_KEY)

import { spawn, execSync } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import type {
  ProviderConfig,
  ProviderEvent,
  ToolDef,
  AgentMessage,
} from "./types.js";

/**
 * Check if OpenCode CLI is installed.
 */
export function opencodeInstalled(): boolean {
  const codePath = [
    path.join(os.homedir(), "go", "bin", "opencode"),
    path.join(os.homedir(), "go", "bin", "opencode-go"),
    path.join(os.homedir(), ".local", "bin", "opencode"),
    "/usr/local/bin/opencode",
    "/usr/bin/opencode",
  ];
  for (const p of codePath) {
    if (fs.existsSync(p)) return true;
  }
  // Also try which
  try {
    execSync("which opencode 2>/dev/null || which opencode-go 2>/dev/null", {
      encoding: "utf-8",
      timeout: 3000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Build a JSON request payload compatible with OpenCode CLI.
 * OpenCode expects messages + tools via stdin JSON.
 */
function buildOpenCodeRequest(
  systemPrompt: string,
  messages: AgentMessage[],
  tools: ToolDef[],
): string {
  const payload: any = {
    messages: [
      { role: "system", content: systemPrompt },
      ...messages.map((m) => {
        const textBlocks = m.content
          .filter((b) => b.type === "text")
          .map((b) => (b as any).text)
          .join("\n");
        const toolResults = m.content
          .filter((b) => b.type === "tool_result")
          .map((b) => ({
            tool_use_id: (b as any).tool_use_id,
            content: (b as any).content,
          }));
        // Preserve assistant tool_use blocks as tool_calls so multi-turn
        // tool calling keeps context (was dropped — only text + results sent).
        const toolUses = m.content
          .filter((b) => b.type === "tool_use")
          .map((b) => ({
            id: (b as any).id,
            type: "function",
            function: {
              name: (b as any).name,
              arguments: JSON.stringify((b as any).input ?? {}),
            },
          }));

        const msg: any = {
          role: m.role,
          content: textBlocks || (toolUses.length > 0 ? null : ""),
        };
        if (toolUses.length > 0) msg.tool_calls = toolUses;
        if (toolResults.length > 0) msg.tool_results = toolResults;
        return msg;
      }),
    ],
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
    })),
    max_turns: 1,
  };

  return JSON.stringify(payload);
}

/**
 * Parse OpenCode CLI streaming JSONL output lines.
 * Matches the same schema as codex for consistency.
 */
function parseOpenCodeLine(line: string): ProviderEvent | null {
  if (!line.trim()) return null;

  try {
    const data = JSON.parse(line);
    const type = data.type;

    switch (type) {
      case "assistant":
      case "text":
      case "content_block_delta":
        return {
          type: "text_delta",
          text: data.text ?? data.content ?? data.delta?.text ?? "",
        };

      case "tool_use":
      case "tool_call":
        return {
          type: "tool_use",
          id: data.id ?? data.tool_use_id ?? `tool_${Date.now()}`,
          name: data.name ?? data.tool_name ?? "unknown",
          input: data.input ?? data.arguments ?? {},
        };

      case "usage":
      case "token_usage":
        return {
          type: "usage",
          inputTokens: data.input_tokens ?? data.inputTokens ?? 0,
          outputTokens: data.output_tokens ?? data.outputTokens ?? 0,
        };

      case "stop":
      case "done":
      case "message_stop":
        return {
          type: "stop",
          stopReason: data.stop_reason ?? data.stopReason ?? "end_turn",
        };

      case "error":
        return {
          type: "error",
          message: data.message ?? data.error ?? "Unknown OpenCode error",
        };

      default:
        return null;
    }
  } catch {
    return null;
  }
}

/**
 * Stream chat through OpenCode CLI.
 */
export async function* streamOpenCode(
  cfg: ProviderConfig,
  systemPrompt: string,
  messages: AgentMessage[],
  tools: ToolDef[],
): AsyncGenerator<ProviderEvent> {
  const request = buildOpenCodeRequest(systemPrompt, messages, tools);

  const env: Record<string, string> = { ...(process.env as Record<string, string>) };

  // Pass API key if configured (OpenCode reads DEEPSEEK_API_KEY, ANTHROPIC_API_KEY, etc.)
  if (cfg.apiKey) {
    env.OPENCODE_API_KEY = cfg.apiKey;
  }

  // Detect which binary is available
  let binary = "opencode";
  try {
    execSync("which opencode-go 2>/dev/null", { encoding: "utf-8", timeout: 2000 });
    binary = "opencode-go";
  } catch {
    // fallback to opencode
  }

  const args = [
    "exec",
    "--model", cfg.model,
    "--json",
  ];

  if (cfg.temperature !== undefined) {
    args.push("--temperature", String(cfg.temperature));
  }

  const child = spawn(binary, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env,
  });

  let buffer = "";

  // Write the request to stdin
  if (child.stdin) {
    child.stdin.write(request);
    child.stdin.end();
  }

  // Read JSONL lines from stdout
  if (child.stdout) {
    for await (const chunk of child.stdout) {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const event = parseOpenCodeLine(line);
        if (event) yield event;
      }
    }
  }

  // Flush remaining buffer
  if (buffer.trim()) {
    const event = parseOpenCodeLine(buffer);
    if (event) yield event;
  }

  // Check for stderr errors
  let stderr = "";
  if (child.stderr) {
    for await (const chunk of child.stderr) {
      stderr += chunk.toString();
    }
  }

  await new Promise<void>((resolve) => child.on("close", resolve));

  if (child.exitCode !== 0 && stderr) {
    yield {
      type: "error",
      message: `OpenCode CLI exited with code ${child.exitCode}: ${stderr.slice(0, 500)}`,
    };
  }

  yield { type: "stop", stopReason: "end_turn" };
}
