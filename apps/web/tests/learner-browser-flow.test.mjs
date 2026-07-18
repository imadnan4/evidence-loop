import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

const appRoot = resolve(import.meta.dirname, "..");
const uiRoot = resolve(appRoot, "../../packages/ui/src");
const questions = [
  "How did you prepare the data before fitting the model?",
  "How did you keep scaling from leaking information?",
  "How would you interpret one model prediction?",
];

function success(data) { return JSON.stringify({ contract_version: "v1", request_id: "browser-test", data }); }
function session(state = "ready", asked = 0) {
  return { id: "session-browser", submission_id: "submission-browser", assessment_version_id: "version-browser", policy_version_id: "policy-browser", state, mode: "text", question_budget: 3, questions_asked: asked, started_at: "2026-07-18T12:00:00.000Z", paused_at: null, completed_at: state === "completed" ? "2026-07-18T12:03:00.000Z" : null };
}
function question(sequence) {
  return { id: `question-${sequence}`, session_id: "session-browser", submission_id: "submission-browser", objective_id: `objective-${sequence}`, sequence, text: questions[sequence - 1], kind: "explain", rationale: "Approved objective.", source_refs: [{ source_type: "artifact_fragment", source_id: `fragment-${sequence}`, submission_id: "submission-browser", locator: `cell-${sequence}` }], created_at: "2026-07-18T12:00:00.000Z" };
}

async function startTestServer({ timeBudgetReached = false } = {}) {
  let state = "ready";
  let asked = 0;
  const responses = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname === "/learner/") return response.end(await readFile(resolve(appRoot, "learner/index.html")));
    if (url.pathname.startsWith("/assets/")) {
      const name = url.pathname.slice("/assets/".length);
      const type = name.endsWith(".css") ? "text/css" : "text/javascript";
      response.writeHead(200, { "Content-Type": type });
      return response.end(await readFile(resolve(appRoot, "assets", name)));
    }
    if (url.pathname.startsWith("/ui/")) {
      response.writeHead(200, { "Content-Type": "text/css" });
      return response.end(await readFile(resolve(uiRoot, url.pathname.slice("/ui/".length))));
    }
    if (!url.pathname.startsWith("/check-ins/session-browser/")) return response.writeHead(404).end();
    const operation = url.pathname.slice("/check-ins/session-browser/".length);
    const body = request.method === "POST" ? await new Promise((resolveBody) => { let raw = ""; request.on("data", (part) => { raw += part; }); request.on("end", () => resolveBody(raw ? JSON.parse(raw) : {})); }) : {};
    response.setHeader("Content-Type", "application/json");
    if (operation === "policy-shown") return response.end(success({ session: session(state, asked), policy: { learnerFacingText: "Show your thinking. This does not automatically grade you.", aiUsePolicy: "allowed_with_disclosure", privacySummary: "Typed text is the canonical record.", completionCriteria: "Answer three questions or request human follow-up." }, textCheckInAvailable: true, pauseAndResumeAvailable: true }));
    if (operation === "policy-acknowledgements") return response.end(success(session(state, asked)));
    if (operation === "start") { state = "in_progress"; asked = 1; return response.end(success({ session: session(state, asked), question: question(1) })); }
    if (operation === "pause") { state = "paused"; return response.end(success(session(state, asked))); }
    if (operation === "resume") { state = "in_progress"; return response.end(success(session(state, asked))); }
    if (operation === "human-follow-up") { state = "human_follow_up"; return response.end(success(session(state, asked))); }
    if (operation === "answers") {
      if (timeBudgetReached) {
        state = "completed";
        response.writeHead(409);
        return response.end(JSON.stringify({ contract_version: "v1", request_id: "browser-test", error: { code: "invalid_state", message: "The finite check-in time budget has been reached.", field_issues: null } }));
      }
      responses.push({ id: `response-${asked}`, question_id: body.questionId, session_id: "session-browser", submission_id: "submission-browser", modality: "text", canonical_text: body.canonicalText, edited_text: null, started_at: "2026-07-18T12:00:00.000Z", submitted_at: "2026-07-18T12:01:00.000Z" });
      if (asked === 3) { state = "completed"; return response.end(success({ session: session(state, asked), response: responses.at(-1), nextQuestion: null })); }
      asked += 1;
      return response.end(success({ session: session(state, asked), response: responses.at(-1), nextQuestion: question(asked) }));
    }
    if (operation === "receipt") return response.end(success({ session: session(state, asked), policyVersionId: "policy-browser", questions: questions.slice(0, responses.length).map((_, index) => question(index + 1)), responses, completedAt: state === "completed" ? "2026-07-18T12:03:00.000Z" : null }));
    response.writeHead(404).end();
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

async function waitFor(check, message) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await check()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(message);
}

async function startBrowser(origin, learnerPath = "/learner/?session=session-browser") {
  const port = 9300 + Math.floor(Math.random() * 500);
  const process = spawn("chromium", ["--headless", "--no-sandbox", "--disable-gpu", `--remote-debugging-port=${port}`, `--user-data-dir=${resolve(tmpdir(), `evidence-loop-${port}`)}`, "about:blank"], { stdio: "ignore" });
  await waitFor(async () => {
    try { return (await fetch(`http://127.0.0.1:${port}/json/version`)).ok; } catch { return false; }
  }, "Chromium did not start.");
  const learnerUrl = `${origin}${learnerPath}`;
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(learnerUrl)}`, { method: "PUT" })).json();
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolveOpen, rejectOpen) => { socket.addEventListener("open", resolveOpen, { once: true }); socket.addEventListener("error", rejectOpen, { once: true }); });
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener("message", async ({ data }) => {
    const raw = typeof data === "string" ? data : data instanceof Blob ? await data.text() : Buffer.from(data).toString();
    const message = JSON.parse(raw);
    const resolvePending = pending.get(message.id);
    if (resolvePending) { pending.delete(message.id); resolvePending(message); }
  });
  const command = (method, params = {}) => new Promise((resolveCommand, rejectCommand) => {
    const id = ++nextId;
    const timeout = setTimeout(() => {
      pending.delete(id);
      rejectCommand(new Error(`CDP command timed out: ${method}`));
    }, 5_000);
    pending.set(id, (message) => {
      clearTimeout(timeout);
      message.error ? rejectCommand(new Error(message.error.message)) : resolveCommand(message.result);
    });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  };
  return { process, socket, command, evaluate };
}

async function key(browser, key, code = key) {
  const virtualKeyCode = key === "Enter" ? 13 : key === "Tab" ? 9 : key === " " ? 32 : 0;
  const params = { key, code, windowsVirtualKeyCode: virtualKeyCode, nativeVirtualKeyCode: virtualKeyCode, ...(key === "Enter" ? { text: "\r", unmodifiedText: "\r" } : {}) };
  await browser.command("Input.dispatchKeyEvent", { type: key === "Enter" ? "rawKeyDown" : "keyDown", ...params });
  await browser.command("Input.dispatchKeyEvent", { type: "keyUp", ...params });
}

async function tabTo(browser, id) {
  for (let count = 0; count < 40; count += 1) {
    if (await browser.evaluate("document.activeElement.id" ) === id) return;
    await key(browser, "Tab");
  }
  throw new Error(`Could not reach #${id} with Tab.`);
}

async function openFlow(context, options) {
  const { server, origin } = await startTestServer(options);
  const browser = await startBrowser(origin);
  context.after(async () => {
    browser.socket.close();
    browser.process.kill();
    server.closeAllConnections();
    await new Promise((resolveClose) => server.close(resolveClose));
  });
  await waitFor(async () => await browser.evaluate("document.querySelector('#policy-version')?.textContent") === "policy-browser", "Policy briefing did not load.");
  return browser;
}

test("learner sees a plain-language error without a course-provided session", { timeout: 30_000 }, async (context) => {
  const { server, origin } = await startTestServer();
  const browser = await startBrowser(origin, "/learner/");
  context.after(async () => {
    browser.socket.close();
    browser.process.kill();
    server.closeAllConnections();
    await new Promise((resolveClose) => server.close(resolveClose));
  });
  await waitFor(async () => await browser.evaluate("document.querySelector('#checkin-error') ? !document.querySelector('#checkin-error').hidden : false"), "Missing-session error did not render.");
  assert.match(await browser.evaluate("document.querySelector('#checkin-error').textContent"), /course-provided link/);
  assert.equal(await browser.evaluate("document.querySelector('#start-checkin').disabled"), true);
});

async function startTextFlow(browser) {
  await tabTo(browser, "start-checkin");
  await key(browser, " ", "Space");
  await waitFor(async () => await browser.evaluate("!document.querySelector('#checkin-error').hidden"), "Policy acknowledgement error did not render.");
  assert.equal(await browser.evaluate("document.activeElement.id"), "checkin-error");
  await tabTo(browser, "policy-acknowledgement");
  await key(browser, " ", "Space");
  await tabTo(browser, "start-checkin");
  await key(browser, " ", "Space");
  await waitFor(async () => await browser.evaluate("!document.querySelector('#checkin-view').hidden"), "Text flow did not start.");
}

test("learner completes the authorized F04a text route with keyboard controls", { timeout: 30_000 }, async (context) => {
  const browser = await openFlow(context);
  await startTextFlow(browser);

  await browser.command("Input.insertText", { text: "I prepared the training data before fitting." });
  await tabTo(browser, "pause-checkin");
  await key(browser, " ", "Space");
  await waitFor(async () => await browser.evaluate("!document.querySelector('#paused-view').hidden"), "Pause did not render.");
  await tabTo(browser, "resume-checkin");
  await key(browser, " ", "Space");
  await waitFor(async () => await browser.evaluate("document.querySelector('#typed-response').value.includes('prepared the training')"), "Pause did not preserve draft.");

  for (const answer of ["I prepared the training data before fitting.", "Scaling is fit only on training data.", "I would relate the prediction to feature values."]) {
    await browser.evaluate("document.querySelector('#typed-response').focus(); document.querySelector('#typed-response').value = ''");
    await browser.command("Input.insertText", { text: answer });
    await tabTo(browser, "pause-checkin");
    await key(browser, "Tab");
    await key(browser, "Tab");
    assert.equal(await browser.evaluate("document.activeElement.type"), "submit");
    await key(browser, " ", "Space");
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  await waitFor(async () => await browser.evaluate("!document.querySelector('#receipt-view').hidden"), "Receipt did not render.");
  assert.equal(await browser.evaluate("document.querySelectorAll('#receipt-responses li').length"), 3);
  assert.equal(await browser.evaluate("document.querySelector('#receipt-policy').textContent"), "policy-browser");
});

test("learner receives a persisted human-follow-up receipt from the F04a boundary", { timeout: 30_000 }, async (context) => {
  const browser = await openFlow(context);
  await startTextFlow(browser);
  await tabTo(browser, "request-follow-up");
  await key(browser, " ", "Space");
  await waitFor(async () => await browser.evaluate("!document.querySelector('#receipt-view').hidden"), "Human-follow-up receipt did not render.");
  assert.equal(await browser.evaluate("document.querySelector('#receipt-title').textContent"), "Human follow-up requested.");
  assert.equal(await browser.evaluate("document.querySelector('#receipt-policy').textContent"), "policy-browser");
});

test("learner receives a receipt when the server reaches the finite time budget", { timeout: 30_000 }, async (context) => {
  const browser = await openFlow(context, { timeBudgetReached: true });
  await startTextFlow(browser);
  await browser.command("Input.insertText", { text: "My response before the time limit." });
  await tabTo(browser, "pause-checkin");
  await key(browser, "Tab");
  await key(browser, "Tab");
  await key(browser, " ", "Space");
  await waitFor(async () => await browser.evaluate("!document.querySelector('#receipt-view').hidden"), "Time-budget receipt did not render.");
  assert.equal(await browser.evaluate("document.querySelectorAll('#receipt-responses li').length"), 0);
  assert.equal(await browser.evaluate("document.querySelector('#receipt-policy').textContent"), "policy-browser");
});
