import { readFile, readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const tokens = await readFile(resolve(root, "src/tokens.css"), "utf8");
const primitives = await readFile(resolve(root, "src/primitives.css"), "utf8");
const requiredTokens = [
  "--el-elevation-flat",
  "--el-elevation-slight",
  "--el-elevation-raised",
  "--el-elevation-overlay",
  "--el-focus-ring",
];
const requiredPrimitives = [
  ".el-skip-link",
  ".el-dialog",
  ".el-card",
  ".el-button",
  ".el-progress",
  ".el-tablist",
  ".el-toast",
  ":focus-visible",
];
const requiredAccessibilityTokens = ["prefers-reduced-motion"];

for (const token of requiredTokens) {
  if (!tokens.includes(token)) throw new Error(`Missing required token: ${token}`);
}
for (const primitive of requiredPrimitives) {
  if (!primitives.includes(primitive)) throw new Error(`Missing required primitive: ${primitive}`);
}
for (const feature of requiredAccessibilityTokens) {
  if (!tokens.includes(feature)) throw new Error(`Missing required accessibility feature: ${feature}`);
}

const reducedMotionBlock = tokens.slice(tokens.indexOf("@media (prefers-reduced-motion: reduce)"));
for (const override of [
  /\.el-skip-link\s*\{[^}]*transform:\s*none/s,
  /\.el-skip-link:focus\s*\{[^}]*transform:\s*none/s,
  /\.el-button:active\s*\{\s*transform:\s*none/s,
]) {
  if (!override.test(reducedMotionBlock)) throw new Error("Reduced-motion transform override is missing.");
}

for (const name of await readdir(resolve(root, "src"))) {
  if (!name.endsWith(".js")) continue;
  const result = spawnSync(process.execPath, ["--check", resolve(root, "src", name)], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || `Syntax check failed: ${name}`);
}

console.log("Design-system token, primitive, and JavaScript syntax checks passed.");
