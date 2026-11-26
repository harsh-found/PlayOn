/**
 * PlayOn static hygiene & architectural boundary gate.
 * Run via: npm run lint
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

interface Violation {
  file: string;
  line: number;
  rule: string;
  snippet: string;
}

const ROOT = process.cwd();
const violations: Violation[] = [];

function walkFiles(dir: string, exts: string[]): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".wrangler" || entry.name === ".git") {
      continue;
    }
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full, exts));
    else if (exts.some((ext) => entry.name.endsWith(ext))) out.push(full);
  }
  return out;
}

function add(file: string, line: number, rule: string, snippet: string): void {
  violations.push({
    file: relative(ROOT, file),
    line,
    rule,
    snippet: snippet.trim().slice(0, 120),
  });
}

function stripLineComment(line: string): string {
  const idx = line.indexOf("//");
  if (idx < 0) return line;
  // Avoid stripping inside URLs like https://
  if (idx > 0 && line[idx - 1] === ":") return line;
  return line.slice(0, idx);
}

// 1. Zero stale "/v2/" or "playify" strings across repo
const repoFiles = [
  ...walkFiles(join(ROOT, "src"), [".ts"]),
  ...walkFiles(join(ROOT, "test"), [".ts"]),
  ...walkFiles(join(ROOT, "scripts"), [".ts"]),
  join(ROOT, "wrangler.toml"),
  join(ROOT, "README.md"),
  join(ROOT, "package.json"),
].filter((f) => existsSync(f) && relative(ROOT, f) !== "scripts/lint.ts");

for (const file of repoFiles) {
  const lines = readFileSync(file, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/\/v2\//i.test(line)) {
      add(file, i + 1, "no-legacy-v2-path", line);
    }
    if (/playify/i.test(line)) {
      add(file, i + 1, "no-legacy-playify-brand", line);
    }
  }
}

// 2. Strict src/ code quality, workerd safety, and pure-domain isolation
const srcFiles = walkFiles(join(ROOT, "src"), [".ts"]);
for (const file of srcFiles) {
  const rel = relative(ROOT, file);
  const isDomainOrData = rel.startsWith("src/domain/") || rel.startsWith("src/data/");
  const isTelemetry = rel === "src/edge/telemetry.ts";
  const content = readFileSync(file, "utf8");
  const lines = content.split("\n");

  let braceDepth = 0;
  let parenDepth = 0;
  let inBlockComment = false;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i] ?? "";
    const trimmed = rawLine.trim();

    if (inBlockComment) {
      if (trimmed.includes("*/")) inBlockComment = false;
      continue;
    }
    if (trimmed.startsWith("/*")) {
      if (!trimmed.includes("*/")) inBlockComment = true;
      continue;
    }
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;

    const code = stripLineComment(rawLine);

    // Disallow TypeScript escape hatches in src/
    if (/\bany\b/.test(code) && !/["'`][^"'`]*\bany\b[^"'`]*["'`]/.test(code)) {
      if (/:\s*any\b|\bas\s+any\b|<any>|\bany\[\]/.test(code)) {
        add(file, i + 1, "no-explicit-any", rawLine);
      }
    }
    if (/@ts-ignore|@ts-expect-error/.test(rawLine)) {
      add(file, i + 1, "no-ts-suppression", rawLine);
    }
    if (/\bas\s+unknown\s+as\b/.test(code)) {
      add(file, i + 1, "no-double-cast", rawLine);
    }
    // Non-null assertion check (avoid matching !==, !=, or !expr)
    if (/[A-Za-z0-9_)\]]!(?![=])(?:\.|\[|,|;|\)|\s|$)/.test(code)) {
      // Exclude string literals containing exclamation marks
      const withoutStrings = code.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g, '""');
      if (/[A-Za-z0-9_)\]]!(?![=])(?:\.|\[|,|;|\)|\s|$)/.test(withoutStrings)) {
        add(file, i + 1, "no-non-null-assertion", rawLine);
      }
    }

    // Console discipline: only console.info/error in src/edge/telemetry.ts
    if (/\bconsole\.(log|debug|warn|trace)\s*\(/.test(code)) {
      add(file, i + 1, "no-raw-console", rawLine);
    }
    if (!isTelemetry && /\bconsole\.(info|error)\s*\(/.test(code)) {
      add(file, i + 1, "console-only-in-telemetry", rawLine);
    }

    // Pure domain isolation: src/domain/ and src/data/ must never import src/edge/ or touch runtime I/O
    if (isDomainOrData) {
      if (/from\s+["'][^"']*\/edge\//.test(code)) {
        add(file, i + 1, "domain-no-edge-import", rawLine);
      }
      if (/\b(fetch|caches|setTimeout|setInterval)\s*\(/.test(code) || /\bcaches\.default\b/.test(code)) {
        add(file, i + 1, "domain-no-runtime-io", rawLine);
      }
      if (/\bcrypto\.subtle\b/.test(code)) {
        add(file, i + 1, "domain-no-webcrypto", rawLine);
      }
      if (/\bDate\.now\s*\(/.test(code)) {
        add(file, i + 1, "domain-no-ambient-clock", rawLine);
      }
    }

    // workerd global-scope safety: disallow Date.now(), Math.random(), fetch(), setTimeout(), crypto.subtle at module top level
    if (braceDepth === 0 && parenDepth === 0) {
      if (/\b(Date\.now|Math\.random|fetch|setTimeout|setInterval)\s*\(/.test(code) || /\bcrypto\.subtle\b/.test(code)) {
        add(file, i + 1, "workerd-no-global-scope-io-or-clock", rawLine);
      }
    }

    // Track brace & paren depth (skip strings)
    const strippedStrings = code.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g, '""');
    for (const ch of strippedStrings) {
      if (ch === "{") braceDepth++;
      else if (ch === "}") braceDepth = Math.max(0, braceDepth - 1);
      else if (ch === "(") parenDepth++;
      else if (ch === ")") parenDepth = Math.max(0, parenDepth - 1);
    }
  }
}

if (violations.length > 0) {
  console.error(`PlayOn lint failed with ${violations.length} violation(s):`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line} [${v.rule}] ${v.snippet}`);
  }
  process.exit(1);
}

console.log(`PlayOn static lint passed (${srcFiles.length} src files, ${repoFiles.length} total files checked, 0 violations).`);
