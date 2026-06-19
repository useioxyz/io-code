// ── IO Code Tool System ──
// Real filesystem tools for the coding agent.

import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { glob } from "glob";
import { parse, type HTMLElement } from "node-html-parser";

export interface ToolOutcome {
  ok: boolean;
  output: string;
  fileChange?: {
    path: string;
    action: "created" | "modified" | "deleted";
  };
  verifies?: boolean; // tool that exercises build/test
}

export interface ToolDef {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, {
      type: string;
      description: string;
      default?: unknown;
      enum?: string[];
      items?: { type: string };
    }>;
    required?: string[];
  };
}

/**
 * Promisified spawn — runs a command with array args (no shell, injection-safe).
 * Resolves with collected stdout/stderr and exit code. Never throws — callers
 * inspect exitCode. Non-blocking: yields to the event loop between chunks, so
 * concurrent tool calls in the harness actually run in parallel.
 */
function execFileAsync(
  command: string,
  args: string[],
  opts: { cwd: string; timeout: number; maxBuffer?: number },
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve) => {
    const maxBuf = opts.maxBuffer ?? 500_000;
    const child = spawn(command, args, {
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    let killed = false;
    const timer = setTimeout(() => { killed = true; child.kill("SIGTERM"); }, opts.timeout * 1000);

    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
      if (stdout.length > maxBuf) { killed = true; child.kill("SIGTERM"); }
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > maxBuf) { killed = true; child.kill("SIGTERM"); }
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (killed && stdout.length > maxBuf) {
        stdout = stdout.slice(0, maxBuf) + `\n... (truncated at ${maxBuf} bytes)`;
      }
      resolve({ stdout, stderr, exitCode: code });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      stderr += err.message;
      resolve({ stdout, stderr, exitCode: -1 });
    });
  });
}

/**
 * Async shell exec — for run_command which intentionally runs arbitrary shell
 * strings (pipes, redirects, &&). Non-blocking but DOES use a shell, so only
 * use for trusted/explicit commands, never for interpolating user input.
 */
function execShellAsync(
  command: string,
  opts: { cwd: string; timeout: number; maxBuffer?: number },
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve) => {
    const maxBuf = opts.maxBuffer ?? 500_000;
    const child = spawn(command, {
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      shell: true,
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    let killed = false;
    const timer = setTimeout(() => { killed = true; child.kill("SIGTERM"); }, opts.timeout * 1000);

    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
      if (stdout.length > maxBuf) { killed = true; child.kill("SIGTERM"); }
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > maxBuf) { killed = true; child.kill("SIGTERM"); }
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (killed && stdout.length > maxBuf) {
        stdout = stdout.slice(0, maxBuf) + `\n... (truncated at ${maxBuf} bytes)`;
      }
      resolve({ stdout, stderr, exitCode: code });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      stderr += err.message;
      resolve({ stdout, stderr, exitCode: -1 });
    });
  });
}

// ── Tool Definitions ──

export const TOOL_DEFS: ToolDef[] = [
  {
    name: "read_file",
    description: "Read a file with line numbers. Use for inspecting code.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path (relative to project root)" },
        offset: { type: "number", description: "Start line (default: 1)" },
        limit: { type: "number", description: "Max lines (default: 500)" },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Create or overwrite a file. New file = created, existing = modified.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path (relative to project root)" },
        content: { type: "string", description: "Full file contents" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "replace_in_file",
    description: "Targeted find-and-replace in a file. PREFERRED for edits over write_file.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path" },
        old_string: { type: "string", description: "Exact text to find and replace" },
        new_string: { type: "string", description: "Replacement text" },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  {
    name: "delete_file",
    description: "Delete a file from the project.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path to delete" },
      },
      required: ["path"],
    },
  },
  {
    name: "list_files",
    description: "List files in a directory (shallow).",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path (default: project root)" },
      },
      required: [],
    },
  },
  {
    name: "find_files",
    description: "Find files by glob pattern. E.g. '*.ts', 'src/**/*.test.ts'",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern" },
        path: { type: "string", description: "Search root (default: project root)" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "search_content",
    description: "Search file contents with regex. Like grep.",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regex pattern to search for" },
        path: { type: "string", description: "Search root (default: project root)" },
        file_glob: { type: "string", description: "Filter files (e.g. '*.ts')" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "run_command",
    description: "Execute a shell command. Returns stdout+stderr+exit code.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to run" },
        timeout: { type: "number", description: "Max seconds (default: 30)" },
      },
      required: ["command"],
    },
  },
  {
    name: "run_tests",
    description: "Run the project's test suite. Auto-detects test framework.",
    input_schema: {
      type: "object",
      properties: {
        filter: { type: "string", description: "Optional test name filter" },
      },
      required: [],
    },
  },
  {
    name: "web_search",
    description: "Search the web for current docs, APIs, versions. Returns title+URL+snippet.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
      },
      required: ["query"],
    },
  },
  {
    name: "web_fetch",
    description: "Fetch content from a URL as markdown text.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to fetch" },
      },
      required: ["url"],
    },
  },
  {
    name: "web_clone",
    description:
      "Clone/download a website locally. Fetches HTML, CSS, JS, images, fonts, and rewrites paths to be local. Saves to ./cloned/<domain>/.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Website URL to clone (e.g. https://example.com)" },
        max_depth: { type: "number", description: "Max link depth to follow (default: 1 = single page only)" },
      },
      required: ["url"],
    },
  },
  {
    name: "git_diff",
    description: "Show git diff — unstaged, staged, or between branches/commits.",
    input_schema: {
      type: "object",
      properties: {
        target: { type: "string", description: "unstaged, staged, branch name, or commit SHA" },
      },
      required: [],
    },
  },
  {
    name: "git_status",
    description: "Show git working tree status.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "git_log",
    description: "Show recent git commit history.",
    input_schema: {
      type: "object",
      properties: {
        count: { type: "number", description: "Number of commits (default: 10)" },
      },
      required: [],
    },
  },
  {
    name: "git_commit",
    description: "Stage files and create a commit with a message.",
    input_schema: {
      type: "object",
      properties: {
        message: { type: "string", description: "Commit message (conventional commits format)" },
        files: {
          type: "array",
          items: { type: "string" },
          description: "Files to stage (default: all modified)",
        },
      },
      required: ["message"],
    },
  },
];

// ── Tool Execution ──

export type ToolName = (typeof TOOL_DEFS)[number]["name"];

export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  projectRoot: string,
): Promise<ToolOutcome> {
  // Path safety — resolve and ensure within project root
  const safe = (p: string): string => {
    const resolved = path.resolve(projectRoot, p);
    if (!resolved.startsWith(path.resolve(projectRoot))) {
      throw new Error(`Path traversal blocked: ${p}`);
    }
    return resolved;
  };

  try {
    switch (name) {
      case "read_file": {
        const filePath = safe(input.path as string);
        const offset = (input.offset as number) ?? 1;
        const limit = (input.limit as number) ?? 500;

        if (!fs.existsSync(filePath)) {
          return { ok: false, output: `File not found: ${input.path}` };
        }

        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) {
          return { ok: false, output: `Path is a directory: ${input.path}` };
        }

        const content = fs.readFileSync(filePath, "utf-8");
        const lines = content.split("\n");
        const start = Math.max(0, offset - 1);
        const end = Math.min(lines.length, start + limit);
        const selected = lines.slice(start, end);

        const numbered = selected
          .map((line, i) => `${String(start + i + 1).padStart(4, " ")}|${line}`)
          .join("\n");

        const header = `📄 ${input.path} (${lines.length} lines, showing ${start + 1}-${end})\n`;
        const totalInfo = lines.length > end
          ? `\n... ${lines.length - end} more lines`
          : "";

        return { ok: true, output: header + numbered + totalInfo };
      }

      case "write_file": {
        const filePath = safe(input.path as string);
        const content = input.content as string;
        const existed = fs.existsSync(filePath);

        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, content, "utf-8");

        const lineCount = content.split("\n").length;
        return {
          ok: true,
          output: `${existed ? "✏️ Modified" : "✨ Created"} ${input.path} (${lineCount} lines)`,
          fileChange: {
            path: input.path as string,
            action: existed ? "modified" : "created",
          },
        };
      }

      case "replace_in_file": {
        const filePath = safe(input.path as string);
        const oldStr = input.old_string as string;
        const newStr = input.new_string as string;

        if (!fs.existsSync(filePath)) {
          return { ok: false, output: `File not found: ${input.path}` };
        }

        const content = fs.readFileSync(filePath, "utf-8");
        const count = content.split(oldStr).length - 1;

        if (count === 0) {
          return {
            ok: false,
            output: `old_string not found in ${input.path}. Check whitespace/exact match.`,
          };
        }

        if (count > 1) {
          return {
            ok: false,
            output: `Found ${count} matches for old_string — must be unique. Include more surrounding context.`,
          };
        }

        const newContent = content.replace(oldStr, newStr);
        fs.writeFileSync(filePath, newContent, "utf-8");

        const oldLines = content.split("\n").length;
        const newLines = newContent.split("\n").length;
        const delta = newLines - oldLines;
        const deltaStr = delta > 0 ? ` (+${delta} lines)` : delta < 0 ? ` (${delta} lines)` : "";

        return {
          ok: true,
          output: `✏️ Replaced in ${input.path}${deltaStr}`,
          fileChange: {
            path: input.path as string,
            action: "modified",
          },
        };
      }

      case "delete_file": {
        const filePath = safe(input.path as string);

        if (!fs.existsSync(filePath)) {
          return { ok: false, output: `File not found: ${input.path}` };
        }

        fs.unlinkSync(filePath);
        return {
          ok: true,
          output: `🗑️ Deleted ${input.path}`,
          fileChange: {
            path: input.path as string,
            action: "deleted",
          },
        };
      }

      case "list_files": {
        const dirPath = safe((input.path as string) ?? ".");
        if (!fs.existsSync(dirPath)) {
          return { ok: false, output: `Directory not found: ${input.path ?? "."}` };
        }

        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        const dirs = entries.filter(e => e.isDirectory()).map(e => `${e.name}/`);
        const files = entries.filter(e => e.isFile()).map(e => e.name);

        const lines: string[] = [];
        for (const d of dirs.sort()) lines.push(`📁 ${d}`);
        for (const f of files.sort()) {
          try {
            const size = fs.statSync(path.join(dirPath, f)).size;
            const sizeStr = size < 1024 ? `${size}B` : size < 1024 * 1024 ? `${(size / 1024).toFixed(1)}KB` : `${(size / (1024 * 1024)).toFixed(1)}MB`;
            lines.push(`📄 ${f} (${sizeStr})`);
          } catch {
            lines.push(`📄 ${f}`);
          }
        }

        return {
          ok: true,
          output: `📂 ${input.path ?? "."} (${entries.length} entries)\n${lines.join("\n")}`,
        };
      }

      case "find_files": {
        const pattern = input.pattern as string;
        const searchRoot = safe((input.path as string) ?? ".");
        const matches = await glob(pattern, {
          cwd: searchRoot,
          ignore: ["node_modules/**", ".git/**", "dist/**", "build/**", "*.lock"],
          nodir: true,
        });
        const limited = matches.slice(0, 50).sort();
        const output = limited.length === 0
          ? `No files matching "${pattern}"`
          : `Found ${matches.length} files matching "${pattern}"${matches.length > 50 ? ` (showing first 50)` : ""}\n${limited.map(f => `  ${f}`).join("\n")}`;
        return { ok: true, output };
      }

      case "search_content": {
        const pattern = input.pattern as string;
        const searchRoot = safe((input.path as string) ?? ".");
        const fileGlob = input.file_glob as string | undefined;

        const matches = await glob(fileGlob ?? "**/*", {
          cwd: searchRoot,
          ignore: ["node_modules/**", ".git/**", "dist/**", "build/**", "*.lock"],
          nodir: true,
        });

        const results: string[] = [];
        let totalHits = 0;
        const regex = new RegExp(pattern, "gi");

        for (const file of matches.slice(0, 200)) {
          try {
            const content = fs.readFileSync(path.join(searchRoot, file), "utf-8");
            const lines = content.split("\n");
            const hits: Array<{ num: number; text: string }> = [];

            for (let i = 0; i < lines.length; i++) {
              if (regex.test(lines[i])) {
                hits.push({ num: i + 1, text: lines[i].trim().slice(0, 120) });
                regex.lastIndex = 0; // reset for next line
              }
            }

            if (hits.length > 0) {
              results.push(`\n📄 ${file} (${hits.length} matches)`);
              for (const h of hits.slice(0, 5)) {
                results.push(`  ${String(h.num).padStart(4)}: ${h.text}`);
              }
              if (hits.length > 5) results.push(`  ... ${hits.length - 5} more`);
              totalHits += hits.length;
            }
          } catch {
            // Skip unreadable files
          }
        }

        return {
          ok: true,
          output: results.length === 0
            ? `No matches for "${pattern}"`
            : `🔍 "${pattern}" — ${totalHits} matches across ${results.filter(l => l.startsWith("\n📄")).length} files\n${results.join("\n")}`,
        };
      }

      case "run_command": {
        const command = input.command as string;

        // Safety checks
        const dangerous = [
          /rm\s+-rf\s+\//, /sudo\s+rm/, />\s*\/dev\/sd/,
          /mkfs\./, /dd\s+if=/, /:\(\s*\)\s*{\s*:\s*\|:\s*&\s*};\s*:/,
        ];
        for (const d of dangerous) {
          if (d.test(command)) {
            return { ok: false, output: `🚫 Blocked dangerous command: ${command}` };
          }
        }

        const timeout = (input.timeout as number) ?? 30;
        const result = await execShellAsync(command, { cwd: projectRoot, timeout, maxBuffer: 500_000 });
        const combined = result.stdout + result.stderr;
        const truncated = combined.length > 6000
          ? combined.slice(0, 6000) + `\n... (${combined.length - 6000} more chars)`
          : combined;

        if (result.exitCode === 0) {
          return { ok: true, output: truncated || "(no output)", verifies: true };
        }
        return {
          ok: false,
          output: `❌ Command failed (exit ${result.exitCode}):\n${(combined || "").slice(0, 3000)}`,
          verifies: true,
        };
      }

      case "run_tests": {
        const filter = input.filter as string | undefined;

        // Auto-detect test framework
        const hasJest = fs.existsSync(path.join(projectRoot, "jest.config.ts"))
          || fs.existsSync(path.join(projectRoot, "jest.config.js"));
        const hasVitest = fs.existsSync(path.join(projectRoot, "vitest.config.ts"))
          || fs.existsSync(path.join(projectRoot, "vitest.config.js"));
        const hasPytest = fs.existsSync(path.join(projectRoot, "pytest.ini"))
          || fs.existsSync(path.join(projectRoot, "pyproject.toml"));
        const hasCargo = fs.existsSync(path.join(projectRoot, "Cargo.toml"));

        let cmd: string;
        if (hasVitest) {
          cmd = "npx vitest run --reporter=verbose";
        } else if (hasJest) {
          cmd = "npx jest --verbose";
        } else if (hasPytest) {
          cmd = "python3 -m pytest -v";
        } else if (hasCargo) {
          cmd = "cargo test";
        } else if (fs.existsSync(path.join(projectRoot, "package.json"))) {
          cmd = "npm test";
        } else {
          return { ok: false, output: "No test framework detected. Use run_command to run tests manually." };
        }

        if (filter) cmd += ` -t "${filter}"`;

        const result = await execShellAsync(cmd, { cwd: projectRoot, timeout: 120, maxBuffer: 500_000 });
        const out = result.stdout + result.stderr;
        if (result.exitCode === 0) {
          return { ok: true, output: `🧪 Tests passed\n${out.slice(0, 4000)}`, verifies: true };
        }
        return { ok: false, output: `🧪 Tests failed\n${out.slice(0, 4000)}`, verifies: true };
      }

      case "web_search": {
        const query = input.query as string;
        try {
          // Use Whoogle if available
          const resp = await fetch(
            `http://127.0.0.1:50997/search?q=${encodeURIComponent(query)}&format=json`,
            { signal: AbortSignal.timeout(10_000) },
          );

          if (!resp.ok) throw new Error(`Whoogle returned ${resp.status}`);

          const data = await resp.json() as any;
          const results = (data.results ?? []).slice(0, 8);

          if (results.length === 0) {
            return { ok: true, output: `No results for "${query}"` };
          }

          const formatted = results.map((r: any, i: number) =>
            `${i + 1}. **${r.title ?? "Untitled"}**\n   ${r.url ?? ""}\n   ${(r.snippet ?? r.description ?? "").slice(0, 200)}`,
          ).join("\n\n");

          return { ok: true, output: `🔍 "${query}"\n\n${formatted}` };
        } catch {
          return {
            ok: false,
            output: `Web search unavailable. Whoogle not running on localhost:50997. Start with: uv tool install whoogle-search && whoogle-search`,
          };
        }
      }

      case "web_fetch": {
        const url = input.url as string;
        try {
          const resp = await fetch(url, {
            signal: AbortSignal.timeout(15_000),
            headers: { "User-Agent": "IO-Code/0.1.0" },
          });

          if (!resp.ok) {
            return { ok: false, output: `HTTP ${resp.status} for ${url}` };
          }

          const contentType = resp.headers.get("content-type") ?? "";
          const text = await resp.text();

          if (text.length > 100_000) {
            return {
              ok: true,
              output: `📄 ${url} (${(text.length / 1000).toFixed(0)}KB, truncated)\n\n${text.slice(0, 5000)}\n\n... (${text.length - 5000} more chars)`,
            };
          }

          return { ok: true, output: `📄 ${url}\n\n${text.slice(0, 8000)}` };
        } catch (e: any) {
          return { ok: false, output: `Failed to fetch ${url}: ${e.message}` };
        }
      }

      case "web_clone": {
        const url = (input.url as string).replace(/\/$/, "");
        const maxDepth = (input.max_depth as number) ?? 1;

        let baseUrl: URL;
        try {
          baseUrl = new URL(url);
        } catch {
          return { ok: false, output: `Invalid URL: ${url}` };
        }

        const domain = baseUrl.hostname;
        const outDir = path.join(projectRoot, "cloned", domain);
        fs.mkdirSync(outDir, { recursive: true });

        const fetched = new Set<string>();
        const assets = new Map<string, Buffer>();
        const stats = { html: 0, css: 0, js: 0, img: 0, font: 0, other: 0 };

        // Resolve a potentially relative URL against the base
        const resolveUrl = (raw: string): string => {
          if (!raw || raw.startsWith("data:") || raw.startsWith("#") || raw.startsWith("javascript:") || raw.startsWith("mailto:")) return "";
          try {
            return new URL(raw, baseUrl).href;
          } catch {
            return "";
          }
        };

        // Download an asset and return the local path
        const downloadAsset = async (assetUrl: string, ext: string): Promise<string | null> => {
          if (fetched.has(assetUrl)) return assetUrl;
          fetched.add(assetUrl);

          try {
            const resp = await fetch(assetUrl, {
              signal: AbortSignal.timeout(15_000),
              headers: { "User-Agent": "IO-Code/0.2.0" },
            });
            if (!resp.ok) return null;

            const buffer = Buffer.from(await resp.arrayBuffer());

            // Build a clean local filename
            const urlPath = new URL(assetUrl).pathname;
            const filename = path.basename(urlPath) || `asset_${fetched.size}${ext}`;
            const localPath = `cloned/${domain}/assets/${filename}`;
            const fullPath = path.join(projectRoot, localPath);
            fs.mkdirSync(path.dirname(fullPath), { recursive: true });
            fs.writeFileSync(fullPath, buffer);
            assets.set(assetUrl, buffer);

            // Track type
            if (ext === ".css") stats.css++;
            else if (ext === ".js") stats.js++;
            else if ([".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".ico"].includes(ext)) stats.img++;
            else if ([".woff", ".woff2", ".ttf", ".eot", ".otf"].includes(ext)) stats.font++;
            else stats.other++;

            return `assets/${filename}`;
          } catch {
            return null;
          }
        };

        // Step 1: Fetch the main HTML
        let htmlText: string;
        try {
          const resp = await fetch(url, {
            signal: AbortSignal.timeout(15_000),
            headers: { "User-Agent": "IO-Code/0.2.0" },
          });
          if (!resp.ok) return { ok: false, output: `HTTP ${resp.status} for ${url}` };
          htmlText = await resp.text();
        } catch (e: any) {
          return { ok: false, output: `Failed to fetch ${url}: ${e.message}` };
        }
        stats.html++;

        // Step 2: Parse HTML
        const root = parse(htmlText);

        // Collect all asset URLs
        interface AssetRef { el: HTMLElement; attr: string; url: string; ext: string; }
        const refs: AssetRef[] = [];

        const collectAttr = (selector: string, attr: string, extMap: Record<string, string>) => {
          for (const el of root.querySelectorAll(selector)) {
            const val = el.getAttribute(attr);
            if (!val) continue;
            const full = resolveUrl(val);
            if (!full) continue;
            const ext = path.extname(new URL(full).pathname).toLowerCase() || extMap[selector] || "";
            refs.push({ el, attr, url: full, ext });
          }
        };

        // <link> — stylesheets, icons
        for (const el of root.querySelectorAll("link[href]")) {
          const rel = el.getAttribute("rel") ?? "";
          const href = el.getAttribute("href") ?? "";
          const full = resolveUrl(href);
          if (!full) continue;
          const u = new URL(full);
          const ext = path.extname(u.pathname).toLowerCase();
          if (rel.includes("stylesheet") || ext === ".css") refs.push({ el, attr: "href", url: full, ext: ".css" });
          else if (rel.includes("icon") || ext === ".ico") refs.push({ el, attr: "href", url: full, ext: ext || ".ico" });
          else if ([".woff", ".woff2", ".ttf", ".eot", ".otf"].includes(ext)) refs.push({ el, attr: "href", url: full, ext });
        }

        // <script src>
        collectAttr("script[src]", "src", {});
        // <img src> and <img srcset>
        for (const el of root.querySelectorAll("img")) {
          const src = resolveUrl(el.getAttribute("src") ?? "");
          if (src) {
            const ext = path.extname(new URL(src).pathname).toLowerCase() || ".png";
            refs.push({ el, attr: "src", url: src, ext });
          }
          // srcset
          const srcset = el.getAttribute("srcset");
          if (srcset) {
            const parts = srcset.split(",").map(s => s.trim().split(/\s+/)[0]);
            for (const p of parts) {
              const full = resolveUrl(p);
              if (full) {
                const ext = path.extname(new URL(full).pathname).toLowerCase() || ".png";
                refs.push({ el, attr: "srcset", url: full, ext });
              }
            }
          }
        }
        // <source src> and srcset
        for (const el of root.querySelectorAll("source")) {
          for (const attr of ["src", "srcset"]) {
            const val = el.getAttribute(attr);
            if (!val) continue;
            for (const p of val.split(",").map(s => s.trim().split(/\s+/)[0])) {
              const full = resolveUrl(p);
              if (full) {
                const ext = path.extname(new URL(full).pathname).toLowerCase() || ".mp4";
                refs.push({ el, attr, url: full, ext });
              }
            }
          }
        }
        // <video poster>, <audio src>, <source src>
        collectAttr("video[poster]", "poster", {});
        collectAttr("audio[src]", "src", {});

        // Build URL→localPath map
        const urlMap = new Map<string, string>();

        // Download all assets (sequential to be polite)
        const results: string[] = [];
        for (const ref of refs) {
          if (urlMap.has(ref.url)) continue;
          const local = await downloadAsset(ref.url, ref.ext || "");
          if (local) {
            urlMap.set(ref.url, local);
          } else {
            results.push(`  ✗ ${ref.url}`);
          }
        }

        // Step 3: Rewrite paths in HTML
        for (const ref of refs) {
          const local = urlMap.get(ref.url);
          if (local) {
            ref.el.setAttribute(ref.attr, local);
            // Handle srcset rewriting
            if (ref.attr === "srcset") {
              ref.el.setAttribute("srcset", local);
            }
          }
        }

        // Step 4: Save rewritten HTML
        const htmlPath = path.join(outDir, "index.html");
        fs.writeFileSync(htmlPath, root.toString(), "utf-8");

        // Summary
        const total = stats.html + stats.css + stats.js + stats.img + stats.font + stats.other;
        const lines = [
          `🌐 Cloned ${url}`,
          ``,
          `  📄 ${stats.html} HTML  ·  ${stats.css} CSS  ·  ${stats.js} JS  ·  ${stats.img} images  ·  ${stats.font} fonts  ·  ${stats.other} other`,
          `  📁 ${outDir}`,
          ``,
          `  Total: ${total} files (${refs.length} asset refs, ${urlMap.size} downloaded)`,
        ];

        if (results.length > 0) {
          lines.push(``);
          lines.push(`  Failed (${results.length}):`);
          lines.push(...results.slice(0, 10));
          if (results.length > 10) lines.push(`  ... ${results.length - 10} more`);
        }

        return { ok: true, output: lines.join("\n") };
      }

      case "git_diff": {
        const target = input.target as string | undefined;
        // Array args — no shell, injection-safe even with user-provided target.
        const args: string[] = ["diff"];
        if (target === "staged" || target === "cached") args.push("--cached", "--", ".");
        else if (target && target.includes("..")) args.push(target);
        else if (target) args.push(target, "--", ".");
        else args.push("--", ".");

        const result = await execFileAsync("git", args, { cwd: projectRoot, timeout: 10, maxBuffer: 500_000 });
        if (result.exitCode === 0) {
          return { ok: true, output: result.stdout.slice(0, 8000) || "(no changes)" };
        }
        return { ok: false, output: result.stderr.slice(0, 1000) || `git diff failed (exit ${result.exitCode})` };
      }

      case "git_status": {
        const result = await execFileAsync("git", ["status", "--short"], { cwd: projectRoot, timeout: 5, maxBuffer: 500_000 });
        if (result.exitCode === 0) {
          return { ok: true, output: result.stdout || "(clean working tree)" };
        }
        return { ok: false, output: result.stderr.slice(0, 1000) || `git status failed (exit ${result.exitCode})` };
      }

      case "git_log": {
        const count = (input.count as number) ?? 10;
        const result = await execFileAsync("git", ["log", "--oneline", "-n", String(Math.min(count, 50)), "--decorate"], { cwd: projectRoot, timeout: 5, maxBuffer: 500_000 });
        if (result.exitCode === 0) {
          return { ok: true, output: result.stdout || "(no commits)" };
        }
        return { ok: false, output: result.stderr.slice(0, 1000) || `git log failed (exit ${result.exitCode})` };
      }

      case "git_commit": {
        const message = input.message as string;
        const files = input.files as string[] | undefined;

        // Array args — injection-safe. Commit message passed as a single arg,
        // no shell interpolation of backticks/$()/; in the message.
        const addArgs = files && files.length > 0 ? ["add", ...files] : ["add", "-A"];
        const addResult = await execFileAsync("git", addArgs, { cwd: projectRoot, timeout: 5, maxBuffer: 500_000 });
        if (addResult.exitCode !== 0) {
          return { ok: false, output: `❌ git add failed: ${addResult.stderr.slice(0, 1000)}` };
        }

        const commitResult = await execFileAsync("git", ["commit", "-m", message], { cwd: projectRoot, timeout: 10, maxBuffer: 500_000 });
        if (commitResult.exitCode !== 0) {
          const msg = (commitResult.stdout + commitResult.stderr).slice(0, 1000);
          return { ok: false, output: `❌ Commit failed: ${msg}` };
        }
        return { ok: true, output: `✅ Committed: ${commitResult.stdout.trim()}` };
      }

      default:
        return { ok: false, output: `Unknown tool: ${name}` };
    }
  } catch (e: any) {
    return { ok: false, output: `Tool execution error: ${e.message}` };
  }
}

/** Get human-readable one-liner for a tool call */
export function toolTitle(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "read_file": return `Read ${input.path}`;
    case "write_file": return `Write ${input.path}`;
    case "replace_in_file": return `Edit ${input.path}`;
    case "delete_file": return `Delete ${input.path}`;
    case "list_files": return `List ${input.path ?? "."}`;
    case "find_files": return `Find ${input.pattern}`;
    case "search_content": return `Search "${input.pattern}"`;
    case "run_command": return `Run \`${String(input.command).slice(0, 60)}\``;
    case "run_tests": return `Run tests${input.filter ? ` (filter: ${input.filter})` : ""}`;
    case "web_search": return `Search web: "${input.query}"`;
    case "web_fetch": return `Fetch ${input.url}`;
    case "web_clone": return `Clone ${input.url}`;
    case "git_diff": return `Git diff${input.target ? ` ${input.target}` : ""}`;
    case "git_status": return "Git status";
    case "git_log": return `Git log (${input.count ?? 10})`;
    case "git_commit": return `Git commit: "${String(input.message).slice(0, 50)}"`;
    default: return name;
  }
}

/** Parse tool calls from assistant message content */
export function extractToolCalls(
  blocks: Array<{ type: string; id?: string; name?: string; input?: Record<string, unknown> }>,
): Array<{ id: string; name: string; input: Record<string, unknown> }> {
  return blocks
    .filter(b => b.type === "tool_use")
    .map(b => ({ id: b.id!, name: b.name!, input: b.input ?? {} }));
}
