#!/usr/bin/env node
// ── IO Code CLI — Entry Point ──

import * as readline from "node:readline";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import chalk from "chalk";
import { Command } from "commander";
import ora from "ora";

import { loadConfig, saveConfig, getApiKey, type IOConfig } from "../src/config.js";
import {
  runAgent,
  compactConversation,
  estimateTokens,
  estimateCost,
} from "../src/harness.js";
import { TOOL_DEFS } from "../src/tools.js";
import { buildSystemPrompt, buildCompactPrompt } from "../src/prompts.js";
import { loadContextFiles, scanWorkspace, detectProject } from "../src/context.js";
import {
  PROVIDER_REGISTRY,
  MODEL_PRESETS,
  detectProviders,
  type ProviderId,
  type ProviderConfig,
} from "../src/llm/index.js";
import type { AgentMessage, ContentBlock } from "../src/llm/types.js";

const VERSION = "0.2.0";
const I = chalk.bold.hex("#00ff88");
const D = chalk.dim;
const W = chalk.white;
const C = chalk.cyan;
const G = chalk.green;
const R = chalk.red;
const Y = chalk.yellow;
const B = chalk.bold;
const M = chalk.magenta;

// ── Banner ──

function showBanner(): string {
  const termWidth = process.stdout.columns ?? 80;
  if (termWidth < 70) {
    return [
      ``,
      `  ${I("▌▐  ▐▌")}  ${D(`IO Code v${VERSION}`)}`,
      `  ${W("▐▛▀▜▌")}  ${D("private coding agent")}`,
      `  ${W("▐  ▐▌")}  ${D("BYOK · I/O Protocol")}`,
      ``,
    ].join("\n");
  }
  return [
    ``,
    `  ${I("▌▐  ▐▌")}  ${W("▐▛▀▜▌ ▐▛▀▀▘ ▐▛▀▜▌ ▐▛▀▀▘ ▐▛▀▀▘")}`,
    `  ${I("▐▛▀▜▌")}  ${W("▐▌ ▐▌ ▐▌    ▐▌ ▐▌ ▐▌    ▐▌▀▀▘")}`,
    `  ${I("▐▌ ▐▌")}  ${W("▐▌ ▐▌ ▐▙▄▄▘ ▐▌ ▐▌ ▐▙▄▄▘ ▐▙▄▄▘")}`,
    ``,
    `  ${D(`private coding agent  ·  BYOK  ·  v${VERSION}`)}`,
    ``,
  ].join("\n");
}

// ── Session State ──

interface TodoItem {
  id: string;
  text: string;
  done: boolean;
}

interface AgentDef {
  name: string;
  description: string;
  model?: string;
  prompt: string;
}

interface SessionState {
  config: IOConfig;
  providerConfig: ProviderConfig | null;
  projectRoot: string;
  conversation: AgentMessage[];
  totalInputTokens: number;
  totalOutputTokens: number;
  contextFiles: ReturnType<typeof loadContextFiles>;
  workspaceFiles: string[];
  compactThreshold: number;
  exit: boolean;
  todos: TodoItem[];
  planMode: boolean;
  pendingReview?: string;
  agents: AgentDef[];
  sessionName?: string;
}

const SESSIONS_DIR = path.join(os.homedir(), ".io_sessions");
const AGENTS_DIR = ".iocode/agents";

// ── History ──

const HISTORY_FILE = path.join(os.homedir(), ".io_history");

function loadHistory(): string[] {
  try {
    return fs.readFileSync(HISTORY_FILE, "utf-8").split("\n").filter(Boolean).slice(-500);
  } catch {
    return [];
  }
}

function saveLine(line: string): void {
  try {
    fs.appendFileSync(HISTORY_FILE, line + "\n", "utf-8");
  } catch {}
}

// ── Session Persistence ──

function saveSession(name: string, state: SessionState): void {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  const data = {
    name,
    savedAt: new Date().toISOString(),
    provider: state.providerConfig?.provider,
    model: state.providerConfig?.model,
    projectRoot: state.projectRoot,
    conversation: state.conversation,
    totalInputTokens: state.totalInputTokens,
    totalOutputTokens: state.totalOutputTokens,
    todos: state.todos,
  };
  fs.writeFileSync(path.join(SESSIONS_DIR, `${name}.json`), JSON.stringify(data, null, 2));
}

function loadSessionData(name: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, `${name}.json`), "utf-8"));
  } catch {
    return null;
  }
}

function listSessions(): Array<{ name: string; savedAt: string; provider: string; messages: number }> {
  try {
    return fs.readdirSync(SESSIONS_DIR)
      .filter(f => f.endsWith(".json"))
      .map(f => {
        const data = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), "utf-8"));
        return {
          name: f.replace(".json", ""),
          savedAt: data.savedAt ?? "unknown",
          provider: data.provider ?? "?",
          messages: data.conversation?.length ?? 0,
        };
      })
      .sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  } catch {
    return [];
  }
}

// ── Agent Loading ──

function loadAgents(projectRoot: string): AgentDef[] {
  const agents: AgentDef[] = [];
  const dirs = [
    path.join(projectRoot, AGENTS_DIR),
    path.join(os.homedir(), ".iocode", "agents"),
  ];

  for (const dir of dirs) {
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith(".md")) continue;
        const content = fs.readFileSync(path.join(dir, f), "utf-8");
        const name = f.replace(".md", "");

        // Parse frontmatter
        const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
        let description = "";
        let model: string | undefined;
        if (fmMatch) {
          const fm = fmMatch[1];
          const descMatch = fm.match(/description:\s*(.+)/);
          const modelMatch = fm.match(/model:\s*(.+)/);
          if (descMatch) description = descMatch[1].trim();
          if (modelMatch) model = modelMatch[1].trim();
        }

        const body = fmMatch ? content.slice(fmMatch[0].length).trim() : content;
        agents.push({ name, description: description || name, model, prompt: body });
      }
    } catch {}
  }

  return agents;
}

// ── Main CLI ──

const program = new Command();

program
  .name("io")
  .description("IO Code — private AI coding agent")
  .version(VERSION)
  .argument("[prompt]", "One-shot prompt (omit for interactive REPL)")
  .option("-p, --provider <provider>", "Provider: anthropic, openai, deepseek, groq, openrouter")
  .option("-m, --model <model>", "Model name")
  .option("-k, --key <key>", "API key")
  .option("-d, --dir <dir>", "Project directory", process.cwd())
  .option("--max-steps <n>", "Max agent steps", "24")
  .option("--temperature <n>", "Temperature (0-2)", "0")
  .option("--compact", "Use compact system prompt")
  .option("--no-stream", "Disable streaming")
  .option("--resume <session>", "Resume a saved session")
  .action(async (prompt, options) => {
    const projectRoot = path.resolve(options.dir);
    const config = loadConfig(projectRoot, {
      provider: options.provider as ProviderId,
      model: options.model,
    });

    if (!config.provider) {
      console.error(R("No provider configured. Set IO_PROVIDER env var or use --provider."));
      console.error(D("Available: anthropic, openai, deepseek, groq, openrouter"));
      process.exit(1);
    }

    const apiKey = options.key ?? getApiKey(config, config.provider);
    if (!apiKey) {
      console.error(R(`No API key for ${config.provider}. Set ${PROVIDER_REGISTRY[config.provider]?.keyEnv} env var or use --key.`));
      process.exit(1);
    }

    const providerConfig: ProviderConfig = {
      provider: config.provider,
      model: config.model ?? PROVIDER_REGISTRY[config.provider]?.defaultModel ?? "unknown",
      apiKey,
      baseUrl: config.baseUrl,
      temperature: parseFloat(options.temperature),
    };

    if (prompt) {
      await runOneShot(providerConfig, projectRoot, prompt, config);
    } else {
      await runRepl(providerConfig, projectRoot, config, options.resume);
    }
  });

program.parse();

// ── One-shot mode ──

async function runOneShot(
  providerConfig: ProviderConfig,
  projectRoot: string,
  prompt: string,
  config: IOConfig,
): Promise<void> {
  const contextFiles = loadContextFiles(projectRoot);
  const workspaceFiles = await scanWorkspace(projectRoot);
  const sysPrompt = buildSystemPrompt(TOOL_DEFS, projectRoot, contextFiles, workspaceFiles);

  console.log(D(`  ${providerConfig.provider}  ·  ${providerConfig.model}  ·  ${projectRoot}`));
  console.log("");

  try {
    for await (const ev of runAgent({
      providerConfig,
      projectRoot,
      toolDefs: TOOL_DEFS,
      systemPrompt: sysPrompt,
      maxSteps: config.maxSteps ?? 24,
      temperature: providerConfig.temperature,
      contextFiles,
      workspaceFiles,
    }, prompt)) {
      switch (ev.type) {
        case "stream":
          if (ev.text) process.stdout.write(ev.text);
          break;
        case "tool_call":
          console.log(`\n${C("◇")} ${ev.toolTitle}`);
          break;
        case "tool_result":
          const icon = ev.toolOk ? G("✓") : R("✗");
          console.log(`${D("┆")} ${icon} ${D((ev.toolOutput ?? "").slice(0, 200))}`);
          break;
        case "done":
          console.log(D(`\n┌─ ✓ ${ev.steps} steps  ↥${ev.totalInputTokens?.toLocaleString() ?? 0} ↧${ev.totalOutputTokens?.toLocaleString() ?? 0}`));
          const cost = estimateCost(providerConfig.provider, providerConfig.model, ev.totalInputTokens ?? 0, ev.totalOutputTokens ?? 0);
          console.log(D(`└─ ${ev.filesChanged} files changed  ${cost.label}`));
          break;
        case "error":
          console.error(R(`\n  Error: ${ev.error}`));
          break;
      }
    }
  } catch (e: any) {
    console.error(R(`\n  Fatal: ${e.message}`));
    process.exit(1);
  }

  console.log("");
  process.exit(0);
}

// ── Interactive REPL ──

async function runRepl(
  providerConfig: ProviderConfig,
  projectRoot: string,
  config: IOConfig,
  resumeSession?: string,
): Promise<void> {
  const contextFiles = loadContextFiles(projectRoot);
  const workspaceFiles = await scanWorkspace(projectRoot);
  const projectInfo = detectProject(projectRoot);
  const agents = loadAgents(projectRoot);

  const state: SessionState = {
    config,
    providerConfig,
    projectRoot,
    conversation: [],
    totalInputTokens: 0,
    totalOutputTokens: 0,
    contextFiles,
    workspaceFiles,
    compactThreshold: config.compactThreshold ?? 15,
    exit: false,
    todos: [],
    planMode: false,
    agents,
  };

  // Resume session if requested
  if (resumeSession) {
    const data = loadSessionData(resumeSession);
    if (data) {
      state.conversation = data.conversation ?? [];
      state.totalInputTokens = data.totalInputTokens ?? 0;
      state.totalOutputTokens = data.totalOutputTokens ?? 0;
      state.todos = data.todos ?? [];
      state.sessionName = resumeSession;
    }
  }

  console.log(showBanner());

  // Startup info line
  console.log(D(`  ${providerConfig.provider}  ·  ${providerConfig.model}  ·  ${projectRoot}`));

  if (contextFiles.length > 0) {
    console.log(D(`  Context: ${contextFiles.map(f => f.name).join(", ")}`));
  }

  if (projectInfo.type !== "unknown") {
    const parts = [`${projectInfo.icon} ${projectInfo.label}`];
    if (projectInfo.packageManager) parts.push(projectInfo.packageManager);
    if (projectInfo.buildTool) parts.push(projectInfo.buildTool);
    if (projectInfo.testFramework) parts.push(`🧪${projectInfo.testFramework}`);
    console.log(D(`  project: ${parts.join(" · ")}`));
  }

  if (agents.length > 0) {
    console.log(D(`  agents: ${agents.map(a => `@${a.name}`).join(", ")}`));
  }

  if (resumeSession) {
    console.log(G(`  ↻ Resumed session: ${resumeSession} (${state.conversation.length} messages, ${state.todos.filter(t => !t.done).length} open todos)`));
  }

  console.log("");

  const history = loadHistory();
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: state.planMode ? M("  📋 ❯ ") : C("  ❯ "),
    terminal: true,
    history,
    historySize: 500,
    removeHistoryDuplicates: true,
  });

  rl.prompt();

  let multilineBuffer: string[] = [];
  let inMultiline = false;

  rl.on("line", async (line) => {
    // Multi-line input (end with \)
    if (line.endsWith("\\") && !inMultiline) {
      inMultiline = true;
      multilineBuffer = [line.slice(0, -1)];
      rl.setPrompt(D("  | "));
      rl.prompt();
      return;
    }

    if (inMultiline) {
      if (line.trim() === "") {
        inMultiline = false;
        rl.setPrompt(state.planMode ? M("  📋 ❯ ") : C("  ❯ "));
        rl.prompt();
        return;
      }
      if (line === ".") {
        inMultiline = false;
        rl.setPrompt(state.planMode ? M("  📋 ❯ ") : C("  ❯ "));
        await processInput(state, multilineBuffer.join("\n"), rl);
        saveLine(multilineBuffer.join("\\n"));
        if (!state.exit) rl.prompt();
        multilineBuffer = [];
        return;
      }
      multilineBuffer.push(line);
      rl.prompt();
      return;
    }

    const input = line.trim();

    if (!input) {
      rl.prompt();
      return;
    }

    saveLine(input);

    // Slash commands
    if (input.startsWith("/")) {
      const result = await handleCommand(input, state);
      if (result) console.log(result);
      if (state.exit) {
        rl.close();
        return;
      }
      rl.setPrompt(state.planMode ? M("  📋 ❯ ") : C("  ❯ "));
      rl.prompt();
      return;
    }

    // Bang commands
    if (input.startsWith("!")) {
      const cmd = input.startsWith("!!") ? input.slice(2) : input.slice(1);
      try {
        const { execSync } = await import("node:child_process");
        const output = execSync(cmd, {
          cwd: state.projectRoot,
          timeout: 30_000,
          maxBuffer: 1_000_000,
          encoding: "utf-8",
        });
        console.log(D(output.slice(0, 5000)));

        if (!input.startsWith("!!")) {
          state.conversation.push({
            role: "user",
            content: [{ type: "text", text: `Command output:\n${output.slice(0, 3000)}` }],
          });
          console.log(D("  (output sent to agent context)"));
        }
      } catch (e: any) {
        console.error(R(e.stderr ?? e.message));
      }
      rl.prompt();
      return;
    }

    // @file references
    const expanded = await expandFileRefs(input, state.projectRoot);

    // Normal input → agent
    await processInput(state, expanded, rl);
    if (!state.exit) rl.prompt();
  });

  rl.on("close", () => {
    console.log(D("\n  bye 👋\n"));
    process.exit(0);
  });
}

// ── Pre-Send Cost Estimation ──

function preSendEstimate(state: SessionState): string {
  if (!state.providerConfig) return "";

  // Estimate context size from conversation
  let totalChars = 0;
  for (const msg of state.conversation) {
    for (const block of msg.content) {
      if (block.type === "text") totalChars += (block as any).text?.length ?? 0;
      else if (block.type === "tool_result") totalChars += (block as any).content?.length ?? 0;
    }
  }
  const estTokens = Math.ceil(totalChars / 4);
  const cost = estimateCost(
    state.providerConfig.provider,
    state.providerConfig.model,
    estTokens,
    0,
  );

  if (cost.total === 0) return D(`  ↥ ~${estTokens.toLocaleString()} tokens est.  free`);
  return D(`  ↥ ~${estTokens.toLocaleString()} tokens est.  $${cost.total.toFixed(4)}`);
}

// ── Process Input ──

async function processInput(
  state: SessionState,
  input: string,
  rl: readline.Interface,
): Promise<void> {
  if (!state.providerConfig) return;

  // Auto-compaction warning
  const msgCount = state.conversation.length;
  if (msgCount > state.compactThreshold) {
    console.log(Y(`  💡 ${msgCount} messages — use /compact to save tokens`));
  }

  // Pre-send cost estimation (only for paid providers)
  const preEstimate = preSendEstimate(state);
  if (preEstimate && !preEstimate.includes("free")) {
    console.log(preEstimate);
  }

  // Auto-compaction threshold reached
  if (msgCount > 25) {
    console.log(Y(`  ⚠️  ${msgCount} messages — context is large. Consider /compact or /clear.`));
  }

  // Plan mode: inject planning directive
  let promptText = input;
  if (state.planMode) {
    promptText = `[PLAN MODE] Create a detailed implementation plan for this task. Break it into small, numbered steps. List files to create/modify. Do NOT write code — only plan.\n\n${input}`;
    state.planMode = false;
  }

  // Review mode
  if (state.pendingReview) {
    try {
      const { execSync } = await import("node:child_process");
      let diffCmd = "git diff -- .";
      if (state.pendingReview === "staged") diffCmd = "git diff --cached -- .";
      else if (state.pendingReview.includes("..")) diffCmd = `git diff ${state.pendingReview}`;
      else if (state.pendingReview) diffCmd = `git diff ${state.pendingReview} -- .`;

      const diff = execSync(diffCmd, {
        cwd: state.projectRoot, timeout: 10_000, maxBuffer: 500_000, encoding: "utf-8",
      });

      if (diff.trim()) {
        promptText = `Review this code diff thoroughly. Check for:\n- Bugs and logic errors\n- Security vulnerabilities\n- Performance issues\n- Missing error handling\n- Style/consistency issues\n- Missing tests\n\nBe specific — cite line numbers where possible.\n\n\`\`\`diff\n${diff.slice(0, 8000)}\n\`\`\``;
      } else {
        console.log(D("  (no changes to review)"));
        return;
      }
    } catch (e: any) {
      console.error(R(`  Review setup failed: ${e.message}`));
      return;
    }
    state.pendingReview = undefined;
  }

  const sysPrompt = buildSystemPrompt(
    TOOL_DEFS,
    state.projectRoot,
    state.contextFiles,
    state.workspaceFiles,
  );

  rl.pause();

  let currentText = "";

  try {
    for await (const ev of runAgent({
      providerConfig: state.providerConfig,
      projectRoot: state.projectRoot,
      toolDefs: TOOL_DEFS,
      systemPrompt: sysPrompt,
      maxSteps: state.config.maxSteps ?? 24,
      temperature: state.providerConfig.temperature,
      contextFiles: state.contextFiles,
      workspaceFiles: state.workspaceFiles,
    }, promptText, state.conversation.length > 0 ? state.conversation : undefined)) {
      switch (ev.type) {
        case "stream":
          if (ev.text) {
            process.stdout.write(ev.text);
            currentText += ev.text;
          }
          break;

        case "tool_call":
          if (currentText) console.log("");
          console.log(`\n${C("◇")} ${ev.toolTitle}`);
          break;

        case "tool_result":
          const icon = ev.toolOk ? G("✓") : R("✗");
          const outLine = (ev.toolOutput ?? "").split("\n")[0].slice(0, 120);
          console.log(`${D("┆")} ${icon} ${D(outLine)}`);
          break;

        case "done":
          state.totalInputTokens += ev.totalInputTokens ?? 0;
          state.totalOutputTokens += ev.totalOutputTokens ?? 0;

          if (currentText) console.log("");

          const cost = estimateCost(
            state.providerConfig.provider,
            state.providerConfig.model,
            ev.totalInputTokens ?? 0,
            ev.totalOutputTokens ?? 0,
          );

          console.log(D(`  ┌─ ✓ ${ev.steps} steps  ↥${ev.totalInputTokens?.toLocaleString() ?? 0} ↧${ev.totalOutputTokens?.toLocaleString() ?? 0}`));
          console.log(D(`  └─ ${ev.filesChanged} files changed  ${cost.label}`));

          if (state.conversation.length === 0) {
            state.conversation.push({
              role: "user",
              content: [{ type: "text", text: input }],
            });
            if (currentText) {
              state.conversation.push({
                role: "assistant",
                content: [{ type: "text", text: currentText }],
              });
            }
          }
          console.log("");
          break;

        case "error":
          console.error(R(`\n  Error: ${ev.error}`));
          break;
      }
    }
  } catch (e: any) {
    console.error(R(`\n  Error: ${e.message}`));
  } finally {
    rl.resume();
  }
}

// ── Slash Commands ──

async function handleCommand(
  input: string,
  state: SessionState,
): Promise<string | null> {
  const parts = input.split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const arg = parts.slice(1).join(" ");

  switch (cmd) {
    // ═══ Help ═══
    case "/help":
    case "/h": {
      const lines = [
        ``,
        `  ${C("IO Code")} ${D(`v${VERSION}  ·  ${state.providerConfig?.provider ?? "?"}  ·  ${state.providerConfig?.model ?? "?"}`)}`,
        ``,
        `  ${B("▸ Session")}     /model /provider /config /key /temp /clear /session /sessions /handoff /export`,
        `  ${B("▸ Context")}    /project /reload /compact /tokens /cost /init`,
        `  ${B("▸ Code")}       /review /plan /todos /agents`,
        `  ${B("▸ Files")}      /find /workspace`,
        `  ${B("▸ Git")}        /diff /status /log /commit`,
        `  ${B("▸ Shell")}      ! cmd   !! cmd  (bang commands)`,
        `  ${B("▸ Meta")}       /help /quit`,
        ``,
        `  ${D("Tab auto-complete available.  ▸ = category, ● = active item.")}`,
        `  ${D("Type # at start to add to IODE.md memory.")}`,
      ];
      return lines.join("\n");
    }

    // ═══ Model ═══
    case "/model":
    case "/m": {
      if (!state.providerConfig) return R("No provider configured.");
      const presets = MODEL_PRESETS[state.providerConfig.provider] ?? [];

      if (!arg) {
        const lines = [
          ``,
          `  ${C("Models for")} ${state.providerConfig.provider}:`,
        ];
        for (const m of presets) {
          const active = m.id === state.providerConfig.model ? G("●") : "○";
          const priceInfo = estimateCost(state.providerConfig.provider, m.id, 0, 0);
          const priceStr = priceInfo.total === 0 ? "free" : `$${priceInfo.total.toFixed(2)}/M out`;
          lines.push(`  ${active} ${m.name} ${D(`(${m.id})`)}  ${D(m.description)}  ${D(priceStr)}`);
        }
        return lines.join("\n") + "\n";
      }

      const match = presets.find(m =>
        m.id === arg ||
        m.id.toLowerCase().includes(arg.toLowerCase()) ||
        m.name.toLowerCase().includes(arg.toLowerCase()),
      );

      if (!match) return R(`Unknown model: ${arg}. Use /model to list.`);

      // Pre-send estimate of switching cost
      state.providerConfig.model = match.id;
      state.config.model = match.id;
      const newCost = preSendEstimate(state);
      saveConfig(state.config, false, state.projectRoot);
      return G(`  Model → ${match.name} (${match.id})  (saved)\n${newCost ? `  ${newCost}` : ""}`);
    }

    // ═══ Provider ═══
    case "/provider":
    case "/p": {
      const available = detectProviders();

      if (!arg) {
        const lines = [
          ``,
          `  ${C("Providers:")}`,
        ];
        for (const [id, meta] of Object.entries(PROVIDER_REGISTRY)) {
          const active = state.providerConfig?.provider === id ? G("●") : "○";
          const keyStatus = available.includes(id as ProviderId) ? G("key ✓") : D("key ✗");
          const models = MODEL_PRESETS[id as ProviderId];
          const modelList = models?.slice(0, 3).map(m => m.name).join(", ") ?? "?";
          lines.push(`  ${active} ${id.padEnd(12)} ${keyStatus}  ${D(meta.description)}`);
          lines.push(`        ${D(`models: ${modelList}`)}`);
        }
        return lines.join("\n") + "\n";
      }

      // Switch provider — case-insensitive
      const argLower = arg.toLowerCase();
      const match = Object.keys(PROVIDER_REGISTRY).find(
        k => k.toLowerCase() === argLower,
      ) as ProviderId | undefined;

      if (!match) return R(`Unknown provider: ${arg}. Use /provider to list.`);

      const apiKey = getApiKey(state.config, match);
      if (!apiKey) {
        return R(`No API key for ${match}. Set ${PROVIDER_REGISTRY[match]?.keyEnv} or use /key.`);
      }

      state.providerConfig = {
        provider: match,
        model: PROVIDER_REGISTRY[match].defaultModel,
        apiKey,
        baseUrl: state.config.baseUrl ?? PROVIDER_REGISTRY[match].baseUrl,
        temperature: state.providerConfig?.temperature,
      };
      state.config.provider = match;
      state.config.model = PROVIDER_REGISTRY[match].defaultModel;
      saveConfig(state.config, false, state.projectRoot);
      return G(`  Provider → ${match} (${PROVIDER_REGISTRY[match].defaultModel})  (saved)`);
    }

    // ═══ API Key ═══
    case "/key": {
      if (!arg) {
        if (!state.providerConfig) return R("No provider configured.");
        const provider = state.providerConfig.provider;
        const key = state.providerConfig.apiKey;
        const masked = key
          ? key.slice(0, 6) + "..." + key.slice(-4)
          : "(not set)";
        return `  ${provider} key: ${masked}`;
      }

      if (!state.providerConfig) return R("No provider configured.");

      state.providerConfig.apiKey = arg;
      state.config.keys ??= {};
      state.config.keys[state.providerConfig.provider] = arg;
      saveConfig(state.config, true);
      return G("  API key set (saved to ~/.iorc.yaml)");
    }

    // ═══ Config ═══
    case "/config": {
      if (!state.providerConfig) return R("No provider configured.");
      const cost = estimateCost(
        state.providerConfig.provider,
        state.providerConfig.model,
        state.totalInputTokens,
        state.totalOutputTokens,
      );
      const lines = [
        ``,
        `  Provider:    ${state.providerConfig.provider}`,
        `  Model:       ${state.providerConfig.model}`,
        `  Project:     ${state.projectRoot}`,
        `  Temp:        ${state.providerConfig.temperature ?? "default (0)"}`,
        `  Max steps:   ${state.config.maxSteps ?? 24}`,
        `  Key:         ${state.providerConfig.apiKey ? state.providerConfig.apiKey.slice(0, 6) + "..." + state.providerConfig.apiKey.slice(-4) : "(not set)"}`,
        `  Messages:    ${state.conversation.length}`,
        `  Session $:   ${cost.label}`,
        `  Todos:       ${state.todos.filter(t => !t.done).length} open / ${state.todos.length} total`,
        `  Agents:      ${state.agents.length} loaded`,
        ``,
        `  ${D("Config files: ~/.iorc.yaml, ./.iorc.yaml, env vars")}`,
      ];
      return lines.join("\n");
    }

    // ═══ Temperature ═══
    case "/temp": {
      if (!state.providerConfig) return R("No provider configured.");
      if (!arg) {
        return `  Temperature: ${state.providerConfig.temperature ?? "default (0)"}  ${D("(0 = deterministic, 1 = creative, 2 = wild)")}`;
      }
      const t = parseFloat(arg);
      if (isNaN(t) || t < 0 || t > 2) return R("Temperature must be 0-2");
      state.providerConfig.temperature = t;
      state.config.temperature = t;
      saveConfig(state.config, false, state.projectRoot);
      return G(`  Temperature → ${t}`);
    }

    // ═══ Clear ═══
    case "/clear":
    case "/new":
    case "/reset": {
      state.conversation = [];
      state.totalInputTokens = 0;
      state.totalOutputTokens = 0;
      return G("  Conversation cleared. Fresh start!");
    }

    // ═══ Project ═══
    case "/project": {
      if (!arg) return `  Project: ${state.projectRoot}`;
      const resolved = path.resolve(arg);
      if (!fs.existsSync(resolved)) return R(`Directory not found: ${resolved}`);
      state.projectRoot = resolved;
      state.contextFiles = loadContextFiles(resolved);
      state.workspaceFiles = await scanWorkspace(resolved);
      state.agents = loadAgents(resolved);
      return G(`  Project → ${resolved}${state.agents.length > 0 ? ` (${state.agents.length} agents loaded)` : ""}`);
    }

    // ═══ Reload ═══
    case "/reload": {
      state.contextFiles = loadContextFiles(state.projectRoot);
      state.workspaceFiles = await scanWorkspace(state.projectRoot);
      state.agents = loadAgents(state.projectRoot);
      return G(`  Reloaded: ${state.contextFiles.length} context files, ${state.workspaceFiles.length} workspace files, ${state.agents.length} agents`);
    }

    // ═══ Init ═══
    case "/init": {
      const iodePath = path.join(state.projectRoot, "IODE.md");
      if (fs.existsSync(iodePath)) {
        return Y(`  IODE.md already exists. Use @IODE.md to view it.`);
      }

      const projectInfo = detectProject(state.projectRoot);
      const template = `# ${path.basename(state.projectRoot)}

## Project Type
${projectInfo.icon} ${projectInfo.label}${projectInfo.language ? ` · ${projectInfo.language}` : ""}

## Architecture
<!-- Describe your project architecture here -->

## Key Commands
<!-- e.g. \`npm run dev\`, \`cargo test\` -->

## Code Standards
<!-- e.g. Use 2-space indentation, TypeScript strict mode -->

## Important Notes
<!-- Any gotchas, conventions, or context the agent should know -->

---

_IO Code auto-loads this file. Edit me anytime!_
`;

      fs.writeFileSync(iodePath, template, "utf-8");
      state.contextFiles = loadContextFiles(state.projectRoot);
      return G(`  Created IODE.md — edit it to add project context for IO Code.`);
    }

    // ═══ Memory (quick-add to IODE.md) ═══
    case "/memory": {
      if (!arg) {
        const iodePath = path.join(state.projectRoot, "IODE.md");
        if (fs.existsSync(iodePath)) {
          // Open for reading
          const content = fs.readFileSync(iodePath, "utf-8");
          return `\n${D(content.split("\n").slice(0, 30).join("\n"))}\n${D("... (use /init to create if missing)")}`;
        }
        return D("  No IODE.md. Use /init to create one.");
      }

      const iodePath = path.join(state.projectRoot, "IODE.md");
      fs.appendFileSync(iodePath, `\n- ${arg}`, "utf-8");
      return G(`  Added to IODE.md: ${arg}`);
    }

    // ═══ Compact ═══
    case "/compact": {
      if (state.conversation.length === 0) return D("  Nothing to compact.");
      if (!state.providerConfig) return R("No provider configured.");

      const preTokens = estimateTokens(
        state.conversation.map(m => {
          const texts = m.content.filter(b => b.type === "text").map(b => (b as any).text ?? "").join(" ");
          return texts;
        }).join(" "),
      );

      const spinner = ora(D(`Compacting ${state.conversation.length} messages (~${preTokens.toLocaleString()} tokens)...`)).start();

      try {
        const compacted = await compactConversation(
          state.providerConfig,
          state.conversation,
          arg,
        );

        const postTokens = estimateTokens(
          compacted.map(m => (m.content[0] as any)?.text ?? "").join(" "),
        );

        state.conversation = compacted;
        spinner.stop();
        const savings = preTokens - postTokens;
        return G(`  Context compacted: ${state.conversation.length}↓ messages, ~${preTokens.toLocaleString()} → ~${postTokens.toLocaleString()} tokens${savings > 0 ? ` (${Math.round(savings / preTokens * 100)}% saved)` : ""}`);
      } catch (e: any) {
        spinner.stop();
        return R(`  Compaction failed: ${e.message}`);
      }
    }

    // ═══ Tokens / Cost ═══
    case "/tokens":
    case "/cost": {
      const input = state.totalInputTokens;
      const output = state.totalOutputTokens;
      const cost = state.providerConfig
        ? estimateCost(state.providerConfig.provider, state.providerConfig.model, input, output)
        : { input: 0, output: 0, total: 0, label: "n/a" };

      const ctxTokens = estimateTokens(
        state.conversation.map(m => {
          return m.content.filter(b => b.type === "text" || b.type === "tool_result")
            .map(b => (b as any).text ?? (b as any).content ?? "")
            .join(" ");
        }).join(" "),
      );

      const lines = [
        ``,
        `  ${C("Token Usage")}  ${D(`(${state.providerConfig?.provider ?? "?"}  ·  ${state.providerConfig?.model ?? "?"})`)}`,
        ``,
        `  ▲ Input:    ${input.toLocaleString().padStart(10)}  ${D(`$${cost.input.toFixed(4)}`)}`,
        `  ▼ Output:   ${output.toLocaleString().padStart(10)}  ${D(`$${cost.output.toFixed(4)}`)}`,
        `  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
        `  Σ Total:    ${(input + output).toLocaleString().padStart(10)}  ${cost.total > 0 ? Y(cost.label) : G("free")}`,
        ``,
        `  Messages:   ${state.conversation.length}  (~${ctxTokens.toLocaleString()} ctx tokens)` + (state.conversation.length > 20 ? Y(`  ⚠️ High — /compact recommended`) : ""),
        ``,
        `  ${D("Session totals. Use /compact to reduce context size.")}`,
      ];
      return lines.join("\n");
    }

    // ═══ Review ═══
    case "/review": {
      const target = arg || "unstaged";
      state.pendingReview = target;
      const label = target === "staged" ? "staged changes" : target === "unstaged" ? "unstaged changes" : target;
      return G(`  🧪 Code review queued — next message will review ${label}.`);
    }

    // ═══ Plan ═══
    case "/plan": {
      state.planMode = !state.planMode;
      if (state.planMode) {
        return G(`  📋 Plan mode ON — next message will be treated as a planning request.\n  ${D("The agent will break the task into numbered steps without writing code.")}`);
      }
      return D("  📋 Plan mode OFF.");
    }

    // ═══ Todos ═══
    case "/todos":
    case "/todo": {
      if (!arg) {
        // List todos
        if (state.todos.length === 0) return D("  No todos. Use /todo <task> to add one.");
        const lines = [
          ``,
          `  ${C("Tasks")} ${D(`(${state.todos.filter(t => t.done).length}/${state.todos.length} done)`)}`,
          ``,
        ];
        for (const t of state.todos) {
          const marker = t.done ? G("✓") : "○";
          const text = t.done ? D(t.text) : t.text;
          lines.push(`  ${marker} ${t.id}. ${text}`);
        }
        return lines.join("\n") + "\n";
      }

      // Add todo
      const id = (state.todos.length + 1).toString();
      state.todos.push({ id, text: arg, done: false });
      return G(`  + Todo ${id}: ${arg}`);
    }

    case "/todo-done":
    case "/td": {
      if (!arg) return R("Usage: /todo-done <number>");
      const todo = state.todos.find(t => t.id === arg);
      if (!todo) return R(`Todo ${arg} not found.`);
      todo.done = true;
      return G(`  ✓ ${arg}. ${todo.text}`);
    }

    case "/todo-clear": {
      state.todos = [];
      return G("  Todos cleared.");
    }

    // ═══ Agents ═══
    case "/agents":
    case "/agent": {
      if (!arg) {
        // List agents
        const lines = [
          ``,
          `  ${C("Agents")} ${D(`(${state.agents.length} loaded)`)}`,
          ``,
        ];
        if (state.agents.length === 0) {
          lines.push(`  ${D("No agents defined. Create .iocode/agents/<name>.md files.")}`);
          lines.push(`  ${D("Example format:")}`);
          lines.push(`  ${D("---")}`);
          lines.push(`  ${D("name: my-agent")}`);
          lines.push(`  ${D("description: Does something specific")}`);
          lines.push(`  ${D("---")}`);
          lines.push(`  ${D("Your agent instructions here...")}`);
        } else {
          for (const a of state.agents) {
            lines.push(`  ${C("@")}${a.name}  ${D(a.description)}${a.model ? D(`  [${a.model}]`) : ""}`);
          }
          lines.push(``);
          lines.push(`  ${D("To use: @agent-name in your prompt, or create new ones in .iocode/agents/")}`);
        }
        return lines.join("\n") + "\n";
      }

      // Show specific agent
      const agent = state.agents.find(a => a.name === arg || a.name.startsWith(arg));
      if (!agent) return R(`Agent "${arg}" not found.`);

      const lines = [
        ``,
        `  ${C(`Agent: @${agent.name}`)}`,
        `  ${D(agent.description)}`,
        agent.model ? `  Model: ${agent.model}` : "",
        ``,
        `  ${D(agent.prompt.slice(0, 2000))}`,
      ];
      return lines.join("\n");
    }

    // ═══ Session Management ═══
    case "/session":
    case "/save": {
      if (!arg) return R("Usage: /session <name> — save current session");
      saveSession(arg, state);
      state.sessionName = arg;
      return G(`  💾 Session saved: ${arg} (${state.conversation.length} messages, ${state.todos.filter(t => !t.done).length} open todos)`);
    }

    case "/sessions":
    case "/ls": {
      const sessions = listSessions();
      if (sessions.length === 0) return D("  No saved sessions. Use /session <name> to save.");

      const lines = [
        ``,
        `  ${C("Saved Sessions")}`,
        ``,
      ];
      for (const s of sessions) {
        const date = new Date(s.savedAt).toLocaleString();
        const active = s.name === state.sessionName ? G("●") : "○";
        lines.push(`  ${active} ${s.name.padEnd(20)} ${D(`${s.provider}  ·  ${s.messages} msgs  ·  ${date}`)}`);
      }
      lines.push(``);
      lines.push(`  ${D("Use --resume <name> at startup or /load <name> to restore.")}`);
      return lines.join("\n") + "\n";
    }

    case "/load": {
      if (!arg) return R("Usage: /load <session-name>");
      const data = loadSessionData(arg);
      if (!data) return R(`Session "${arg}" not found. Use /sessions to list.`);

      state.conversation = data.conversation ?? [];
      state.totalInputTokens = data.totalInputTokens ?? 0;
      state.totalOutputTokens = data.totalOutputTokens ?? 0;
      state.todos = data.todos ?? [];
      state.sessionName = arg;
      return G(`  📂 Loaded session: ${arg} (${state.conversation.length} messages, ${state.todos.filter((t: TodoItem) => !t.done).length} open todos)`);
    }

    case "/handoff": {
      if (!arg) return R("Usage: /handoff <name> — save session + generate handoff summary");

      if (state.conversation.length === 0) return D("  Nothing to hand off.");

      // Generate handoff summary
      if (!state.providerConfig) return R("No provider configured.");

      // Save first
      saveSession(arg, state);

      const spinner = ora(D("Generating handoff summary...")).start();

      try {
        const handoffPrompt = `Summarize this conversation into a handoff document. Format:

## Handoff: ${arg}

**Goal:** What was being worked on

**Progress:** What was accomplished (files changed, decisions made)

**Current State:** Where things stand now

**Blockers:** Any issues or blockers

**Next Steps:** What to do next

**Key Files:** Important files to know about

**Notes:** Any other important context

Be concise but thorough. This will be read by a developer continuing the work.`;

        let summary = "";
        for await (const ev of runAgent({
          providerConfig: state.providerConfig,
          projectRoot: state.projectRoot,
          toolDefs: [],
          systemPrompt: "You are a handoff summarizer. Be concise and factual.",
          maxSteps: 1,
        }, handoffPrompt, state.conversation)) {
          if (ev.type === "stream" && ev.text) summary += ev.text;
        }

        // Save handoff doc
        const handoffDir = path.join(state.projectRoot, ".iocode", "handoffs");
        fs.mkdirSync(handoffDir, { recursive: true });
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        const handoffPath = path.join(handoffDir, `${arg}-${timestamp}.md`);
        fs.writeFileSync(handoffPath, summary, "utf-8");

        spinner.stop();
        return G(`  🤝 Handoff complete!\n  Session: ${arg} (saved)\n  Handoff: ${handoffPath}`);
      } catch (e: any) {
        spinner.stop();
        // Session was already saved — handoff summary failed
        return Y(`  ⚠️  Session saved, but handoff summary failed: ${e.message}`);
      }
    }

    case "/export": {
      const name = arg || state.sessionName || "session";
      const filePath = path.join(process.cwd(), `${name.replace(/[^a-zA-Z0-9_-]/g, "_")}.md`);

      const lines: string[] = [
        `# IO Code Session: ${name}`,
        ``,
        `**Date:** ${new Date().toISOString()}`,
        `**Provider:** ${state.providerConfig?.provider ?? "?"}`,
        `**Model:** ${state.providerConfig?.model ?? "?"}`,
        `**Project:** ${state.projectRoot}`,
        `**Messages:** ${state.conversation.length}`,
        ``,
        `---`,
        ``,
      ];

      for (const msg of state.conversation) {
        lines.push(`### ${msg.role === "user" ? "🧑 User" : "🤖 Assistant"}`);
        lines.push("");
        for (const block of msg.content) {
          if (block.type === "text") {
            lines.push((block as any).text ?? "");
            lines.push("");
          } else if (block.type === "tool_use") {
            lines.push(`> 🔧 **${(block as any).name}**`);
            lines.push("> ```json");
            lines.push(`> ${JSON.stringify((block as any).input).slice(0, 200)}`);
            lines.push("> ```");
            lines.push("");
          } else if (block.type === "tool_result") {
            lines.push(`> 📄 Result`);
            lines.push("> ```");
            lines.push(`> ${((block as any).content ?? "").slice(0, 500)}`);
            lines.push("> ```");
            lines.push("");
          }
        }
        lines.push("---");
        lines.push("");
      }

      fs.writeFileSync(filePath, lines.join("\n"), "utf-8");
      return G(`  📄 Exported to ${filePath} (${(fs.statSync(filePath).size / 1024).toFixed(1)}KB)`);
    }

    // ═══ Git ═══
    case "/diff": {
      try {
        const { execSync } = await import("node:child_process");
        let args = "diff -- .";
        if (arg === "staged" || arg === "cached") args = "diff --cached -- .";
        else if (arg) args = `diff ${arg} -- .`;
        const output = execSync(`git ${args}`, {
          cwd: state.projectRoot,
          timeout: 10_000,
          maxBuffer: 500_000,
          encoding: "utf-8",
        });
        const truncated = output.slice(0, 5000);
        return output ? `\n${D(truncated)}` : D("  (no changes)");
      } catch (e: any) {
        return R(e.stderr ?? e.message);
      }
    }

    case "/status": {
      try {
        const { execSync } = await import("node:child_process");
        const output = execSync("git status --short", {
          cwd: state.projectRoot,
          timeout: 5000,
          encoding: "utf-8",
        });
        return output ? `\n${D(output)}` : D("  (clean working tree)");
      } catch (e: any) {
        return R(e.stderr ?? e.message);
      }
    }

    case "/log": {
      try {
        const { execSync } = await import("node:child_process");
        const count = parseInt(arg) || 10;
        const output = execSync(`git log --oneline -n ${Math.min(count, 50)} --decorate`, {
          cwd: state.projectRoot,
          timeout: 5000,
          encoding: "utf-8",
        });
        return `\n${D(output)}`;
      } catch (e: any) {
        return R(e.stderr ?? e.message);
      }
    }

    // ═══ Find / Workspace ═══
    case "/find": {
      if (!arg) return R("Usage: /find <pattern>");
      const { glob } = await import("glob");
      const matches = await glob(arg, {
        cwd: state.projectRoot,
        ignore: ["node_modules/**", ".git/**", "dist/**", "build/**"],
        nodir: true,
      });
      const limited = matches.slice(0, 40).sort();
      if (limited.length === 0) return D(`  No files matching "${arg}"`);
      return `\n${D(limited.map(f => `  ${f}`).join("\n"))}`;
    }

    case "/workspace": {
      state.workspaceFiles = await scanWorkspace(state.projectRoot);
      return `\n${D(state.workspaceFiles.map(f => `  ${f}`).join("\n"))}`;
    }

    // ═══ Quit ═══
    case "/quit":
    case "/exit":
    case "/q": {
      state.exit = true;
      return D("  bye 👋");
    }

    default:
      return D(`  Unknown command: ${cmd}. Use /help to see all commands.`);
  }
}

// ── @file Reference Expansion ──

async function expandFileRefs(
  text: string,
  projectRoot: string,
): Promise<string> {
  const re = /(?:^|\s)@([^\s:]+(?:\.[a-zA-Z]{1,10})?(?::\d+(?:-\d+)?)?)(?=\s|$)/g;
  let result = text;
  const replacements: Array<{ original: string; replacement: string }> = [];
  let match: RegExpExecArray | null;

  while ((match = re.exec(text)) !== null) {
    const ref = match[1];
    const parts = ref.split(":");
    const filePath = parts[0];
    let rangeStr = parts[1] ?? "";

    const resolved = path.resolve(projectRoot, filePath);
    if (!resolved.startsWith(path.resolve(projectRoot))) continue;

    try {
      if (!fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) continue;

      let content = fs.readFileSync(resolved, "utf-8");
      let lines = content.split("\n");

      if (rangeStr) {
        const rangeMatch = rangeStr.match(/^(\d+)(?:-(\d+))?$/);
        if (rangeMatch) {
          const start = parseInt(rangeMatch[1]) - 1;
          const end = rangeMatch[2] ? parseInt(rangeMatch[2]) : start + 1;
          lines = lines.slice(start, end);
        }
      }

      if (lines.length > 500) {
        lines = lines.slice(0, 500);
        lines.push("... (truncated)");
      }

      const ext = path.extname(filePath).slice(1) || "txt";
      const block = `\n\n@${ref}:\n\`\`\`${ext}\n${lines.join("\n")}\n\`\`\``;

      replacements.push({
        original: match[0],
        replacement: match[0].replace(new RegExp(`@${ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), block),
      });
    } catch {}
  }

  for (const r of replacements.reverse()) {
    result = result.replace(r.original, r.replacement);
  }

  return result;
}

// ── Startup ──

if (process.argv.length <= 2) {
  const projectRoot = process.cwd();
  const config = loadConfig(projectRoot);

  if (!config.provider) {
    console.error(R("No provider configured."));
    console.error(D("\nQuick start:"));
    console.error(D("  export DEEPSEEK_API_KEY=sk-..."));
    console.error(D("  export ANTHROPIC_API_KEY=sk-ant-..."));
    console.error(D("  export OPENAI_API_KEY=sk-..."));
    console.error(D("  export GROQ_API_KEY=gsk_..."));
    console.error(D("\nOr create ~/.iorc.yaml:"));
    console.error(D("  provider: deepseek"));
    console.error(D("  keys:"));
    console.error(D("    deepseek: sk-..."));
    process.exit(1);
  }

  const apiKey = getApiKey(config, config.provider);
  if (!apiKey) {
    console.error(R(`No API key for ${config.provider}.`));
    process.exit(1);
  }

  const pc: ProviderConfig = {
    provider: config.provider,
    model: config.model ?? PROVIDER_REGISTRY[config.provider]?.defaultModel ?? "unknown",
    apiKey,
    baseUrl: config.baseUrl,
    temperature: config.temperature,
  };

  runRepl(pc, projectRoot, config).catch(e => {
    console.error(R(`\n  Fatal: ${e.message}`));
    process.exit(1);
  });
}
