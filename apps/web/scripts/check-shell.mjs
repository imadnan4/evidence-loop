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

const instructorPage = await readFile(resolve(root, "instructor/index.html"), "utf8");
for (const required of [
  "Review queue",
  "Demonstrated",
  "Needs human review",
  "Next learning step",
  "data-source-drawer",
  "data-review-form",
  "AI draft · awaiting human review",
  "Synthetic demo",
]) {
  if (!instructorPage.includes(required)) throw new Error(`Instructor review is missing ${required}`);
}

if (!instructorPage.includes("<textarea")) throw new Error("Instructor review must provide editable feedback.");
if (!instructorPage.includes("<fieldset")) throw new Error("Instructor review must provide human review actions.");

const instructorReviewScript = await readFile(resolve(root, "assets/instructor-review.js"), "utf8");
if (/\b(fetch|XMLHttpRequest)\s*\(/.test(instructorReviewScript)) {
  throw new Error("Instructor review must not make API calls before the review contract is connected.");
}
if (/\.innerHTML\b/.test(instructorReviewScript)) {
  throw new Error("Instructor review must render source detail as text, never HTML.");
}
for (const required of ["artifact:sample-a-apartment-prices", "response:sample-a:q1", "response:sample-a:q2", "response:sample-a:q3"]) {
  if (!instructorReviewScript.includes(required)) throw new Error(`Instructor review source detail is missing ${required}`);
}

const shellCss = await readFile(resolve(root, "assets/shell.css"), "utf8");
if (!shellCss.includes("/ui/primitives.css")) throw new Error("Shell must consume UI primitives rather than duplicate them.");

for (const script of ["scripts/serve.mjs", "assets/instructor-review.js"]) {
  const result = spawnSync(process.execPath, ["--check", resolve(root, script)], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || `Syntax check failed: ${script}`);
}

console.log("Web UI accessibility markers, instructor review structure, API isolation, and syntax checks passed.");
