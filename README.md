# IO Code

**Private AI coding agent for the terminal.** BYOK. Multi-provider. I/O Protocol native.

```
  ▌▐  ▐▌  ▐▛▀▜▌ ▐▛▀▀▘ ▐▛▀▜▌ ▐▛▀▀▘ ▐▛▀▀▘
  ▐▛▀▜▌  ▐▌ ▐▌ ▐▌    ▐▌ ▐▌ ▐▌    ▐▌▀▀▘
  ▐▌ ▐▌  ▐▌ ▐▌ ▐▙▄▄▘ ▐▌ ▐▌ ▐▙▄▄▘ ▐▙▄▄▘

  private coding agent  ·  BYOK  ·  v0.1.0
```

## Features

- **Real filesystem tools** — read, write, edit, delete, search, git operations
- **Multi-provider BYOK** — Anthropic, OpenAI, DeepSeek, Groq, OpenRouter, Codex (OAuth), OpenCode, custom
- **Parallel tool execution** — dependency graph + concurrent tool calls + automatic retry
- **Smart linting** — auto-detect and run ESLint, Biome, Prettier, Ruff, Oxlint
- **Undo support** — git-based per-file revert with `/undo [n]`
- **Autonomous agent loop** — plan → act → observe → verify
- **Slash commands** — /model, /provider, /compact, /clear, /config, /diff, /status, /commit, /lint, /undo, /clone
- **Context auto-loading** — AGENTS.md, CLAUDE.md, .cursorrules, IODE.md
- **Project intelligence** — auto-detects framework, package manager, test runner
- **Compact prompt mode** — save tokens on simple tasks
- **Privacy-first** — never reads .env files, built on I/O Protocol

## Quick Start

```bash
# Install
cd io-code
npm install
npm run build
npm link

# Set up BYOK
export DEEPSEEK_API_KEY=sk-...    # or ANTHROPIC_API_KEY, OPENAI_API_KEY, GROQ_API_KEY
export IO_PROVIDER=deepseek       # default provider

# Run
io                                  # interactive REPL
io "Fix the auth bug"               # one-shot
io -p anthropic -m claude-opus-4-8 "Refactor"  # custom provider/model
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

## Coming Soon

- I/O Protocol native inference (no external API keys needed)
- Cryptographic receipts on all inferences
- IO MCP integration
- Self-destruct timer for conversations
- Client-side encrypted agent memory
- TUI mode (Ink/React)

## License

Apache-2.0 — https://github.com/useioxyz/io-code
