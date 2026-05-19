import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const [, , targetDir, ...forbiddenPatterns] = process.argv;

if (!targetDir) {
  console.error("Usage: node scripts/verify-package-imports.mjs <dir> <pattern>...");
  process.exit(1);
}

const patterns = forbiddenPatterns.length > 0 ? forbiddenPatterns : ["@/", "next/"];
const exts = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs"]);

function visit(filePath) {
  const stats = statSync(filePath);
  if (stats.isDirectory()) {
    for (const entry of readdirSync(filePath)) {
      visit(path.join(filePath, entry));
    }
    return;
  }

  if (!exts.has(path.extname(filePath))) return;

  const contents = readFileSync(filePath, "utf8");
  for (const pattern of patterns) {
    if (contents.includes(pattern)) {
      console.error(`Forbidden import pattern "${pattern}" found in ${filePath}`);
      process.exitCode = 1;
    }
  }
}

visit(path.resolve(targetDir));

if (process.exitCode) {
  process.exit(process.exitCode);
}
