#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "..");
const packagesDir = path.join(rootDir, "packages");
const args = process.argv.slice(2);

const packageDirs =
  args.length > 0
    ? args.map((packageArg) => resolvePackageDir(packageArg))
    : readdirSync(packagesDir)
        .map((entry) => path.join(packagesDir, entry))
        .filter((entry) => existsSync(path.join(entry, "package.json")));

const errors = [];

for (const packageDir of packageDirs) {
  const packageJsonPath = path.join(packageDir, "package.json");

  if (!existsSync(packageJsonPath)) {
    errors.push(`Missing package.json in ${path.relative(rootDir, packageDir)}`);
    continue;
  }

  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  const packageName = packageJson.name ?? path.relative(rootDir, packageDir) ?? packageDir;
  const stylesPath = path.join(packageDir, "styles.css");
  const files = Array.isArray(packageJson.files) ? packageJson.files : [];
  const sideEffects = Array.isArray(packageJson.sideEffects) ? packageJson.sideEffects : [];
  const stylesExport = packageJson.exports?.["./styles.css"];
  const shipsStyles =
    existsSync(stylesPath) ||
    files.includes("styles.css") ||
    stylesExport === "./styles.css" ||
    sideEffects.includes("*.css");

  if (!shipsStyles) {
    continue;
  }

  if (!existsSync(stylesPath)) {
    errors.push(`${packageName}: missing required styles.css export target`);
    continue;
  }

  const stylesheet = readFileSync(stylesPath, "utf8");

  if (!/@import\s+"tailwindcss";/.test(stylesheet)) {
    errors.push(`${packageName}: styles.css must import tailwindcss`);
  }

  if (!/@source\s+/.test(stylesheet)) {
    errors.push(`${packageName}: styles.css must declare at least one Tailwind @source`);
  }

  if (!files.includes("styles.css")) {
    errors.push(`${packageName}: package.json files must include styles.css`);
  }

  if (stylesExport !== "./styles.css") {
    errors.push(`${packageName}: package.json exports must expose ./styles.css`);
  }

  if (!sideEffects.includes("*.css")) {
    errors.push(`${packageName}: package.json sideEffects must include *.css`);
  }
}

if (errors.length > 0) {
  console.error("Package style verification failed:");

  for (const error of errors) {
    console.error(`- ${error}`);
  }

  process.exit(1);
}

function resolvePackageDir(packageArg) {
  const candidate = path.resolve(process.cwd(), packageArg);

  if (existsSync(path.join(candidate, "package.json"))) {
    return candidate;
  }

  const nestedCandidate = path.join(rootDir, packageArg);

  if (existsSync(path.join(nestedCandidate, "package.json"))) {
    return nestedCandidate;
  }

  throw new Error(`Could not resolve package directory for ${packageArg}`);
}
