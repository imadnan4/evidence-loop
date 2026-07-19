import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const demoPages = ["public/demo/instructor/index.html", "public/demo/learner/index.html"];
const appFiles = ["app/page.tsx", "app/layout.tsx"];

for (const page of demoPages) {
  const html = await readFile(resolve(root, page), "utf8");
  for (const required of ["<html lang=\"en\"", "el-skip-link", "id=\"main-content\"", "Synthetic"]) {
    if (!html.includes(required)) throw new Error(`${page} is missing ${required}`);
  }
  if (html.includes('href="/instructor/"') || html.includes('href="/learner/"')) {
    throw new Error(`${page} must keep prototype links under /demo/**`);
  }
  if (/\b(fetch|XMLHttpRequest)\s*\(/.test(html)) throw new Error(`${page} must not make API calls`);
}

for (const file of appFiles) {
  const source = await readFile(resolve(root, file), "utf8");
  if (/Sample learner|artifact:sample-a|response:sample-a|Synthetic demo data/.test(source)) {
    throw new Error(`${file} must not embed demo fixture data in a production route`);
  }
  if (/\b(fetch|XMLHttpRequest|localStorage|sessionStorage)\b|\/check-ins\/|\/v1\//.test(source)) {
    throw new Error(`${file} must not add browser API/auth/persistence wiring in A03`);
  }
}

const instructorPage = await readFile(resolve(root, "public/demo/instructor/index.html"), "utf8");
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
  if (!instructorPage.includes(required)) throw new Error(`Instructor review demo is missing ${required}`);
}

if (!instructorPage.includes("<textarea")) throw new Error("Instructor review demo must provide editable feedback.");
if (!instructorPage.includes("<fieldset")) throw new Error("Instructor review demo must provide human review actions.");

const instructorReviewScript = await readFile(resolve(root, "public/demo/assets/instructor-review.js"), "utf8");
if (/\b(fetch|XMLHttpRequest)\s*\(/.test(instructorReviewScript)) {
  throw new Error("Instructor review demo must not make API calls before the review contract is connected.");
}
if (/\.innerHTML\b/.test(instructorReviewScript)) {
  throw new Error("Instructor review demo must render source detail as text, never HTML.");
}
for (const required of ["artifact:sample-a-apartment-prices", "response:sample-a:q1", "response:sample-a:q2", "response:sample-a:q3"]) {
  if (!instructorReviewScript.includes(required)) throw new Error(`Instructor review source detail is missing ${required}`);
}

const shellCss = await readFile(resolve(root, "public/assets/shell.css"), "utf8");
if (!shellCss.includes("/ui/primitives.css")) throw new Error("Shell must consume UI primitives rather than duplicate them.");

// Verify public/ui files exist (they're copied from packages/ui/src during build)
const uiFiles = ["components.js", "primitives.css", "tokens.css"];
for (const file of uiFiles) {
  try {
    await readFile(resolve(root, "public/ui", file), "utf8");
  } catch {
    throw new Error(`public/ui/${file} is missing — run the copy step before check`);
  }
}

for (const script of ["scripts/serve.mjs", "public/demo/assets/instructor-review.js"]) {
  const result = spawnSync(process.execPath, ["--check", resolve(root, script)], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || `Syntax check failed: ${script}`);
}

console.log("Next.js shell, demo isolation, accessibility markers, API isolation, and syntax checks passed.");
