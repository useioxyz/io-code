# IO Code

**Private AI coding agent for the terminal.** BYOK. Multi-provider. I/O Protocol native.

```
  ▌▐  ▐▌  ▐▛▀▜▌ ▐▛▀▀▘ ▐▛▀▜▌ ▐▛▀▀▘ ▐▛▀▀▘
  ▐▛▀▜▌  ▐▌ ▐▌ ▐▌    ▐▌ ▐▌ ▐▌    ▐▌▀▀▘
  ▐▌ ▐▌  ▐▌ ▐▌ ▐▙▄▄▘ ▐▌ ▐▌ ▐▙▄▄▘ ▐▙▄▄▘

  private coding agent  ·  BYOK  ·  v0.1.0
```

## Features

- **Real filesystem tools** — read, write, edit, patch (unified diff), delete, search, git operations
- **Multi-provider BYOK** — Anthropic, OpenAI, DeepSeek, Groq, OpenRouter, Codex (OAuth), OpenCode, custom
- **Provider failover** — auto-retries with the next connected provider on 429/503
- **Parallel tool execution** — dependency graph + concurrent async tool calls + automatic retry
- **Streaming tool preview** — see tool calls start the moment the model emits them
- **Smart linting** — auto-detect and run ESLint, Biome, Prettier, Ruff, Oxlint
- **Undo + checkpoint support** — `/undo` for file ops, `/checkpoint` + `/restore` for full working-tree snapshots
- **Autonomous agent loop** — plan → act → observe → verify
- **Auto-compact** — conversation compacts automatically when context grows too large
- **`@agent` dispatch** — invoke sub-agents by mentioning `@agent-name` in your prompt
- **Slash commands** — /model, /provider, /compact, /clear, /config, /diff, /status, /commit, /lint, /undo, /checkpoint, /restore, /clone
- **Context auto-loading** — AGENTS.md, CLAUDE.md, .cursorrules, IODE.md
- **Project intelligence** — auto-detects framework, package manager, test runner
- **Session log** — auto-captures file changes to IODE.md (opt-in)
- **Compact prompt mode** — save tokens on simple tasks
- **Privacy-first** — never reads .env files, built on I/O Protocol

## Quick Start

```bash
# Install
cd io-code
npm install
npm run build
npm link

# Run — even without any config, you can set up from the CLI
io                                    # interactive REPL (no setup needed!)
io> /provider deepseek                # switch to deepseek
io> /key sk-...                       # set API key (saved to ~/.iorc.yaml)
io> build a CLI tool in TypeScript    # start coding!

# Or set up via env vars
export DEEPSEEK_API_KEY=sk-...
export IO_PROVIDER=deepseek
io                                    # ready to go

# One-shot mode (requires provider+key)
io "Fix the auth bug"
io -p anthropic -m claude-opus-4-8 "Refactor"
```

## Providers

| Provider | Env Var | Default Model |
|----------|---------|---------------|
| Anthropic | `ANTHROPIC_API_KEY` | claude-sonnet-4-6 |
| OpenAI | `OPENAI_API_KEY` | gpt-5.1 |
| DeepSeek | `DEEPSEEK_API_KEY` | deepseek-v4-pro |
| Groq | `GROQ_API_KEY` | llama-4-maverick |
| OpenRouter | `OPENROUTER_API_KEY` | anthropic/claude-sonnet-4 |
| Codex (OAuth) | `codex login` | gpt-5.5-codex |
| OpenCode (Go) | `opencode` CLI | deepseek-v4-pro |

## Slash Commands

| Command | Description |
|---------|-------------|
| `/help` | Show all commands |
| `/model [name]` | List or switch models |
| `/models` | Browse models from ALL connected providers |
| `/provider [name]` | List or switch providers |
| `/config` | Show current config |
| `/key <api-key>` | Set API key |
| `/temp [0-2]` | Get/set temperature |
| `/clear` | Clear conversation |
| `/compact [instr]` | Compress context |
| `/tokens` / `/cost` | Show token usage |
| `/diff [target]` | Git diff viewer |
| `/status` | Git status |
| `/log [n]` | Git log |
| `/find <pattern>` | Find files by glob |
| `/clone <url>` | Clone website locally (HTML+CSS+JS+assets) |
| `/lint [--fix]` | Run linters (auto-detect: ESLint, Biome, Prettier, Ruff, Oxlint) |
| `/undo [n]` | Undo last N file changes (git-based revert) |
| `/checkpoint [label]` | Snapshot the working tree (git stash create) |
| `/restore [n]` | Restore a checkpoint (discards current changes first) |
| `/checkpoints` | List saved checkpoints |
| `/workspace` | List workspace files |
| `/reload` | Reload context files |
| `/quit` | Exit |

## Configuration

Config is resolved from (highest priority first):
1. CLI flags (`--provider`, `--model`, `--key`)
2. Env vars (`IO_PROVIDER`, `DEEPSEEK_API_KEY`, etc.)
3. Project `.iorc.yaml`
4. Global `~/.iorc.yaml`

```yaml
# ~/.iorc.yaml
provider: deepseek
model: deepseek-v4-pro
keys:
  deepseek: sk-...
  anthropic: sk-ant-...
temperature: 0
maxSteps: 24
```

## Project Context

IO Code auto-loads project context files from the working directory:
- `AGENTS.md`
- `CLAUDE.md`
- `.cursorrules`
- `IODE.md` (I/O ecosystem specific)
- `README.md` (trimmed to first 300 lines)

## Sub-Agents

Define specialized agents in `.iocode/agents/<name>.md` (or `~/.iocode/agents/`):

```markdown
---
name: code-reviewer
description: Security-focused code reviewer
model: claude-opus-4-8
---

You are a senior security engineer. Analyze code for...
```

Invoke by mentioning `@agent-name` in your prompt — the agent's prompt is
injected into the system prompt and its model overrides the session model
for that turn:

```
io> @code-reviewer review src/auth.ts for vulnerabilities
```

## Coming Soon

- I/O Protocol native inference (no external API keys needed)
- Cryptographic receipts on all inferences
- IO MCP integration
- Self-destruct timer for conversations
- Client-side encrypted agent memory
- TUI mode (Ink/React)

## License

Apache-2.0 — https://github.com/useioxyz/io-code
