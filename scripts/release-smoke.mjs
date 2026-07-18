import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const webRoot = resolve(repositoryRoot, "apps/web");

async function availablePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
}

async function waitForServer(origin, child) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (child.exitCode !== null) throw new Error("The web demo server stopped before it became ready.");
    try {
      const response = await fetch(origin);
      if (response.ok) return;
    } catch {
      // The static server may not have bound its port yet.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error("Timed out waiting for the web demo server.");
}

async function get(origin, path) {
  const response = await fetch(`${origin}${path}`, { redirect: "manual" });
  return { response, text: await response.text() };
}

const port = await availablePort();
const origin = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ["scripts/serve.mjs"], {
  cwd: webRoot,
  env: { ...process.env, PORT: String(port) },
  stdio: ["ignore", "ignore", "pipe"],
});
let serverError = "";
child.stderr.on("data", (chunk) => { serverError += chunk; });

try {
  await waitForServer(origin, child);

  const expectedPages = [
    ["/", "Make learning evidence visible."],
    ["/instructor/", "Synthetic demo data"],
    ["/learner/", "Show your thinking in a short text check-in."],
  ];
  for (const [path, marker] of expectedPages) {
    const { response, text } = await get(origin, path);
    assert.equal(response.status, 200, `${path} must be available to demo viewers.`);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/);
    assert.match(text, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(text, /Synthetic/);
  }

  const { response: assetResponse, text: asset } = await get(origin, "/assets/instructor-review.js");
  assert.equal(assetResponse.status, 200, "The provenance drawer script must be available.");
  assert.match(assetResponse.headers.get("x-content-type-options") ?? "", /nosniff/);
  assert.doesNotMatch(asset, /innerHTML/);

  const { response: uiResponse } = await get(origin, "/ui/components.js");
  assert.equal(uiResponse.status, 200, "Shared UI components must be available to the instructor demo.");

  const postResponse = await fetch(`${origin}/learner/`, { method: "POST", redirect: "manual" });
  assert.equal(postResponse.status, 405, "The static demo must reject unexpected write requests.");

  const { response: missingResponse } = await get(origin, "/not-a-demo-route");
  assert.equal(missingResponse.status, 404, "Unknown demo routes must not resolve to a page.");

  console.log("Release smoke passed: synthetic home, learner, and instructor routes; static assets; and basic HTTP boundaries are available.");
} finally {
  if (child.exitCode === null) {
    child.kill();
    await once(child, "exit");
  }
  if (child.exitCode && child.exitCode !== 0) {
    throw new Error(`The web demo server exited unexpectedly: ${serverError.trim()}`);
  }
}
