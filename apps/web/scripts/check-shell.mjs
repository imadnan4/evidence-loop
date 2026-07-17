import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const pages = ["index.html", "instructor/index.html", "learner/index.html"];

for (const page of pages) {
  const html = await readFile(resolve(root, page), "utf8");
  for (const required of ["<html lang=\"en\"", "el-skip-link", "id=\"main-content\"", "Synthetic"]) {
    if (!html.includes(required)) throw new Error(`${page} is missing ${required}`);
  }
  if (/\b(fetch|XMLHttpRequest)\s*\(/.test(html)) throw new Error(`${page} must not make API calls`);
}

const shellCss = await readFile(resolve(root, "assets/shell.css"), "utf8");
if (!shellCss.includes("/ui/primitives.css")) throw new Error("Shell must consume UI primitives rather than duplicate them.");

for (const script of ["scripts/serve.mjs"]) {
  const result = spawnSync(process.execPath, ["--check", resolve(root, script)], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || `Syntax check failed: ${script}`);
}

console.log("Web-shell placeholder, accessibility marker, API isolation, and syntax checks passed.");
