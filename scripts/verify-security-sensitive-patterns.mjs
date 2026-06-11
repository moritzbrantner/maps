#!/usr/bin/env node

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scanRoots = ["src", "demo", "scripts"];
const sourceExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const scriptPath = path.relative(rootDir, fileURLToPath(import.meta.url));

const rules = [
  {
    id: "dangerous-react-html",
    pattern: /dangerouslySetInnerHTML/,
    message: "React raw HTML injection must be reviewed and allowlisted.",
  },
  {
    id: "dom-inner-html",
    pattern: /\.innerHTML\b/,
    message: "DOM innerHTML writes must be reviewed and allowlisted.",
  },
  {
    id: "eval-call",
    pattern: /\beval\s*\(/,
    message: "eval calls are not allowed.",
  },
  {
    id: "function-constructor",
    pattern: /\bnew\s+Function\b/,
    message: "Function constructor usage must be reviewed and allowlisted.",
  },
  {
    id: "document-write",
    pattern: /\bdocument\.write\s*\(/,
    message: "document.write is not allowed.",
  },
  {
    id: "hardcoded-secret",
    pattern:
      /\b(?:gho_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|npm_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})\b/,
    message: "Hardcoded credential-like values are not allowed.",
  },
];

const allowlist = [
  {
    path: "src/maplibre-compat.ts",
    ruleId: "dom-inner-html",
    text: "element.innerHTML = icon?.html ?? \"\";",
    rationale: "FlatDivIconOptions.html is a documented trusted-markup compatibility path.",
  },
  {
    path: "src/scalar-field.ts",
    ruleId: "function-constructor",
    text: "const dynamicImport = new Function(\"specifier\", \"return import(specifier)\")",
    rationale: "Optional viz-engine dynamic import avoids bundling optional runtime modules.",
  },
  {
    path: "src/kernels/wasm-kernels.ts",
    ruleId: "function-constructor",
    text: "const dynamicImport = new Function(\"specifier\", \"return import(specifier)\")",
    rationale: "Optional WASM kernel dynamic import avoids bundling optional runtime modules.",
  },
];

const findings = [];

for (const scanRoot of scanRoots) {
  visit(path.join(rootDir, scanRoot));
}

if (findings.length > 0) {
  console.error("Security-sensitive pattern verification failed:");

  for (const finding of findings) {
    console.error(
      `- ${finding.file}:${finding.lineNumber} ${finding.rule.id}: ${finding.rule.message}`,
    );
    console.error(`  ${finding.line.trim()}`);
  }

  console.error("Review the usage and add a narrow allowlist entry with a rationale if intentional.");
  process.exit(1);
}

function visit(filePath) {
  const stats = statSync(filePath);

  if (stats.isDirectory()) {
    for (const entry of readdirSync(filePath)) {
      visit(path.join(filePath, entry));
    }
    return;
  }

  if (!sourceExtensions.has(path.extname(filePath))) return;

  const relativePath = path.relative(rootDir, filePath);
  if (relativePath === scriptPath) return;

  const contents = readFileSync(filePath, "utf8");
  const lines = contents.split(/\r?\n/);

  lines.forEach((line, index) => {
    for (const rule of rules) {
      if (!rule.pattern.test(line)) continue;
      if (isAllowed(relativePath, rule.id, line)) continue;

      findings.push({
        file: relativePath,
        line,
        lineNumber: index + 1,
        rule,
      });
    }
  });
}

function isAllowed(filePath, ruleId, line) {
  return allowlist.some(
    (entry) => entry.path === filePath && entry.ruleId === ruleId && line.includes(entry.text),
  );
}
