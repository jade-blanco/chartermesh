import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";

const excludedDirectories = new Set([
  ".git",
  ".chartermesh",
  ".pnpm-store",
  "coverage",
  "dist",
  "node_modules",
  "playwright-report",
  "test-results",
]);

const textExtensions = new Set([
  ".cjs",
  ".css",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".toml",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);

const forbiddenMarkers = [
  { name: "Windows user path", pattern: /\b[A-Z]:[\\/]Users[\\/][^\\/\s]+/u },
  { name: "macOS user path", pattern: /\/Users\/[^/\s]+/u },
  { name: "Linux user path", pattern: /\/home\/[^/\s]+/u },
  { name: "legacy message ledger", pattern: /\.claude[\\/]team[\\/]MESSAGES\.md/iu },
];

const secretPatterns = [
  { name: "OpenAI-style secret", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/u },
  { name: "AWS access key", pattern: /\bAKIA[0-9A-Z]{16}\b/u },
  { name: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/u },
  { name: "private key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u },
  {
    name: "assigned provider key",
    pattern: /\b(?:OPENAI|ANTHROPIC|GEMINI)_API_KEY\s*=\s*[^\s"'`]{8,}/iu,
  },
];

async function* walk(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === "ENOENT") return;
    throw error;
  }

  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && !excludedDirectories.has(entry.name)) {
      yield* walk(path);
    } else if (entry.isFile() && textExtensions.has(extname(entry.name))) {
      yield path;
    }
  }
}

const findings = [];

for await (const path of walk(".")) {
  const text = await readFile(path, "utf8");
  for (const check of [...forbiddenMarkers, ...secretPatterns]) {
    if (check.pattern.test(text)) {
      findings.push(`${path}: ${check.name}`);
    }
  }
}

if (findings.length > 0) {
  console.error("Repository boundary checks failed:");
  for (const finding of findings) console.error(`- ${finding}`);
  process.exitCode = 1;
} else {
  console.log("Repository boundary checks passed.");
}
