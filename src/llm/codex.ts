// ── OpenAI Codex CLI Provider (OAuth-based) ──
// Uses the Codex CLI via subprocess. Auth is handled by `codex login` (OAuth device flow).

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
 * Check if Codex CLI is installed and logged in.
 */
export function codexInstalled(): boolean {
  const codexPath = [
    path.join(os.homedir(), ".npm-global", "bin", "codex"),
    path.join(os.homedir(), ".local", "bin", "codex"),
    "/usr/local/bin/codex",
    "/usr/bin/codex",
  ];
  for (const p of codexPath) {
    if (fs.existsSync(p)) return true;
  }
  // Also check npm global
  try {
    const result = execSync("npm list -g @openai/codex 2>/dev/null || true", {
      encoding: "utf-8",
      timeout: 5000,
    });
    if (result.includes("@openai/codex")) return true;
  } catch {}
  return false;
}

/**
 * Check Codex auth status.
 */
export function codexAuthStatus(): { loggedIn: boolean; account?: string } {
  try {
    const output = execSync("codex whoami 2>/dev/null || echo 'NOT_LOGGED_IN'", {
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
    if (output === "NOT_LOGGED_IN" || output.includes("not logged in")) {
      return { loggedIn: false };
    }
    return { loggedIn: true, account: output };
  } catch {
    return { loggedIn: false };
  }
}

/**
 * Build a JSON request payload compatible with Codex CLI.
 */
function buildCodexRequest(
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
 * Parse Codex CLI streaming JSONL output lines.
 */
function parseCodexLine(
  line: string,
): ProviderEvent | null {
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
          message: data.message ?? data.error ?? "Unknown Codex error",
        };

      default:
        return null;
    }
  } catch {
    // Non-JSON line (stderr, etc.) — ignore
    return null;
  }
}

/**
 * Stream chat through Codex CLI.
 * Launches `codex exec` with the request on stdin, reads JSONL on stdout.
 */
export async function* streamCodex(
  cfg: ProviderConfig,
  systemPrompt: string,
  messages: AgentMessage[],
  tools: ToolDef[],
): AsyncGenerator<ProviderEvent> {
  const request = buildCodexRequest(systemPrompt, messages, tools);

  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  // Pass auth token if available
  if (!env.OPENAI_CODEX_AUTH_TOKEN && cfg.apiKey) {
    env.OPENAI_CODEX_AUTH_TOKEN = cfg.apiKey;
  }

  const args = [
    "exec",
    "--model", cfg.model,
    "--json",
  ];

  if (cfg.temperature !== undefined) {
    args.push("--temperature", String(cfg.temperature));
  }

  const child = spawn("codex", args, {
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
        const event = parseCodexLine(line);
        if (event) yield event;
      }
    }
  }

  // Flush remaining buffer
  if (buffer.trim()) {
    const event = parseCodexLine(buffer);
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
      message: `Codex CLI exited with code ${child.exitCode}: ${stderr.slice(0, 500)}`,
    };
  }

  // Always emit a stop event if the process ended cleanly
  yield { type: "stop", stopReason: "end_turn" };
}
