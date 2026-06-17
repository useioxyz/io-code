// ── IO Code Context Loader ──
// Auto-loads project context files like AGENTS.md, CLAUDE.md, .cursorrules, etc.

import * as fs from "node:fs";
import * as path from "node:path";
import { glob } from "glob";

export interface ContextFile {
  name: string;
  path: string;
  content: string;
}

const CONTEXT_FILE_NAMES = [
  "AGENTS.md",
  "CLAUDE.md",
  ".cursorrules",
  "IODE.md",
  ".iorules",
  "README.md",
];

/**
 * Load context files from project root.
 */
export function loadContextFiles(projectRoot: string): ContextFile[] {
  const files: ContextFile[] = [];

  for (const name of CONTEXT_FILE_NAMES) {
    const fullPath = path.join(projectRoot, name);
    try {
      const content = fs.readFileSync(fullPath, "utf-8");
      // Trim README to first 300 lines
      const trimmed = name === "README.md"
        ? content.split("\n").slice(0, 300).join("\n")
          + (content.split("\n").length > 300 ? "\n\n... (README truncated)" : "")
        : content;

      files.push({ name, path: fullPath, content: trimmed });
    } catch {
      // File doesn't exist — skip
    }
  }

  return files;
}

/**
 * Scan workspace for file listing to give agent context.
 */
export async function scanWorkspace(projectRoot: string): Promise<string[]> {
  try {
    const matches = await glob("**/*", {
      cwd: projectRoot,
      ignore: [
        "node_modules/**",
        ".git/**",
        "dist/**",
        "build/**",
        ".next/**",
        "target/**",
        "*.lock",
        "*.log",
        ".env*",
        "coverage/**",
        "__pycache__/**",
        "*.pyc",
        ".DS_Store",
      ],
      nodir: true,
      maxDepth: 5,
    });

    return matches.sort().slice(0, 60);
  } catch {
    return [];
  }
}

/**
 * Auto-detect project type
 */
export interface ProjectInfo {
  type: string;
  label: string;
  icon: string;
  language: string;
  packageManager?: string;
  buildTool?: string;
  testFramework?: string;
}

export function detectProject(projectRoot: string): ProjectInfo {
  const files = new Set<string>();
  try {
    for (const f of fs.readdirSync(projectRoot)) {
      files.add(f);
    }
  } catch {
    return { type: "unknown", label: "Unknown", icon: "❓", language: "" };
  }

  // Detect framework
  if (files.has("next.config.ts") || files.has("next.config.js") || files.has("next.config.mjs")) {
    const info: ProjectInfo = { type: "next", label: "Next.js", icon: "▲", language: "TypeScript" };
    info.packageManager = detectPackageManager(files);
    info.buildTool = "next";
    info.testFramework = detectTestFramework(projectRoot, files);
    return info;
  }

  if (files.has("vite.config.ts") || files.has("vite.config.js")) {
    const info: ProjectInfo = { type: "react", label: "React (Vite)", icon: "⚛", language: "TypeScript" };
    info.packageManager = detectPackageManager(files);
    info.buildTool = "vite";
    info.testFramework = detectTestFramework(projectRoot, files);
    return info;
  }

  if (files.has("package.json")) {
    const info: ProjectInfo = { type: "node", label: "Node.js", icon: "●", language: "JS/TS" };
    info.packageManager = detectPackageManager(files);
    info.testFramework = detectTestFramework(projectRoot, files);
    return info;
  }

  if (files.has("Cargo.toml")) {
    return { type: "rust", label: "Rust", icon: "🦀", language: "Rust", buildTool: "cargo" };
  }

  if (files.has("go.mod")) {
    return { type: "go", label: "Go", icon: "🔷", language: "Go", buildTool: "go" };
  }

  if (files.has("pyproject.toml") || files.has("setup.py")) {
    return { type: "python", label: "Python", icon: "🐍", language: "Python" };
  }

  return { type: "unknown", label: "Unknown", icon: "❓", language: "" };
}

function detectPackageManager(files: Set<string>): string | undefined {
  if (files.has("pnpm-lock.yaml")) return "pnpm";
  if (files.has("bun.lockb") || files.has("bun.lock")) return "bun";
  if (files.has("yarn.lock")) return "yarn";
  if (files.has("package-lock.json")) return "npm";
  return undefined;
}

function detectTestFramework(projectRoot: string, files: Set<string>): string | undefined {
  if (files.has("vitest.config.ts") || files.has("vitest.config.js") || files.has("vitest.config.mjs"))
    return "vitest";
  if (files.has("jest.config.ts") || files.has("jest.config.js") || files.has("jest.config.mjs"))
    return "jest";
  if (files.has("pytest.ini") || files.has("conftest.py")) return "pytest";

  // Check package.json scripts
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf-8"));
    const testScript = pkg.scripts?.test ?? "";
    if (testScript.includes("vitest")) return "vitest";
    if (testScript.includes("jest")) return "jest";
    if (testScript.includes("mocha")) return "mocha";
  } catch {}

  return undefined;
}
