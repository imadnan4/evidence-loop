import { F04aSessionApi, SessionApiError } from "/assets/learner-session-api.js";

const sessionId = new URLSearchParams(window.location.search).get("session");
const api = new F04aSessionApi();
const elements = {
  briefing: document.querySelector("#briefing-view"),
  checkin: document.querySelector("#checkin-view"),
  paused: document.querySelector("#paused-view"),
  receipt: document.querySelector("#receipt-view"),
  support: document.querySelector("#support-view"),
  acknowledgement: document.querySelector("#policy-acknowledgement"),
  start: document.querySelector("#start-checkin"),
  questionNumber: document.querySelector("#question-number"),
  questionText: document.querySelector("#question-text"),
  progress: document.querySelector("#checkin-progress"),
  progressText: document.querySelector("#progress-text"),
  response: document.querySelector("#typed-response"),
  responseForm: document.querySelector("#response-form"),
  pause: document.querySelector("#pause-checkin"),
  resume: document.querySelector("#resume-checkin"),
  followUp: document.querySelector("#request-follow-up"),
  supportButton: document.querySelector("#show-support"),
  error: document.querySelector("#checkin-error"),
  status: document.querySelector("#checkin-status"),
  receiptList: document.querySelector("#receipt-responses"),
  receiptTitle: document.querySelector("#receipt-title"),
  receiptIntro: document.querySelector("#receipt-intro"),
  receiptCompleted: document.querySelector("#receipt-completed"),
  receiptPolicy: document.querySelector("#receipt-policy"),
};

let briefing;
let activeSession;
let activeQuestion;
let savedDraft = "";

function newIdempotencyKey() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `browser-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function plainLanguageAiUsePolicy(policy) {
  if (policy === "allowed") return "AI use is allowed for this assessment.";
  if (policy === "allowed_with_disclosure") return "AI use is allowed with disclosure under this assessment policy.";
  return "AI use is not allowed for this assessment.";
}

function setView(name) {
  for (const [key, node] of Object.entries({ briefing: elements.briefing, checkin: elements.checkin, paused: elements.paused, receipt: elements.receipt, support: elements.support })) {
    node.hidden = key !== name;
  }
}

function setBusy(control, busy) {
  control.disabled = busy;
  control.setAttribute("aria-busy", String(busy));
}

function reportError(error) {
  elements.error.textContent = error instanceof Error ? error.message : "Something went wrong. Your typed draft remains in this browser.";
  elements.error.hidden = false;
  elements.error.focus();
}

function clearError() {
  elements.error.textContent = "";
  elements.error.hidden = true;
}

function announce(message) {
  elements.status.textContent = "";
  window.setTimeout(() => { elements.status.textContent = message; }, 20);
}

function updateQuestion(question) {
  activeQuestion = question;
  const total = activeSession.question_budget;
  elements.questionNumber.textContent = `Question ${question.sequence} of ${total}`;
  elements.questionText.textContent = question.text;
  elements.progress.value = question.sequence - 1;
  elements.progress.max = total;
  const remaining = total - question.sequence + 1;
  elements.progressText.textContent = `${remaining} planned question${remaining === 1 ? "" : "s"} remaining, including this one`;
  elements.response.value = savedDraft;
  savedDraft = "";
  elements.response.focus();
}

function terminalSessionError(error) {
  return error instanceof SessionApiError && error.code === "invalid_state";
}

async function loadBriefing() {
  if (!sessionId) {
    reportError(new Error("Open the check-in from your course-provided link. No check-in session was supplied."));
    return;
  }
  try {
    briefing = await api.showPolicy({ sessionId, idempotencyKey: newIdempotencyKey() });
    document.querySelector("#policy-text").textContent = briefing.policy.learnerFacingText;
    document.querySelector("#ai-use-policy").textContent = plainLanguageAiUsePolicy(briefing.policy.aiUsePolicy);
    document.querySelector("#policy-version").textContent = briefing.session.policy_version_id;
    document.querySelector("#privacy-summary").textContent = briefing.policy.privacySummary;
    document.querySelector("#completion-criteria").textContent = briefing.policy.completionCriteria;
    elements.start.disabled = false;
  } catch (error) {
    reportError(error);
  }
}

async function startCheckIn() {
  clearError();
  if (!elements.acknowledgement.checked) {
    reportError(new Error("Confirm that you reviewed the policy before starting the text check-in."));
    return;
  }
  setBusy(elements.start, true);
  try {
    await api.acknowledgePolicy({ sessionId: briefing.session.id, policyVersionId: briefing.session.policy_version_id, idempotencyKey: newIdempotencyKey() });
    const started = await api.start({ sessionId: briefing.session.id, policyVersionId: briefing.session.policy_version_id, mode: "text", idempotencyKey: newIdempotencyKey() });
    activeSession = started.session;
    setView("checkin");
    updateQuestion(started.question);
    announce("Text check-in started. Question 1 is ready.");
  } catch (error) {
    reportError(error);
  } finally {
    setBusy(elements.start, false);
  }
}

async function submitResponse(event) {
  event.preventDefault();
  clearError();
  const responseText = elements.response.value.trim();
  if (!responseText) {
    reportError(new Error("Enter a typed response before continuing."));
    return;
  }
  const submit = event.submitter ?? elements.responseForm.querySelector("button[type=submit]");
  setBusy(submit, true);
  try {
    const result = await api.submitTextResponse({
      sessionId: activeSession.id,
      questionId: activeQuestion.id,
      canonicalText: responseText,
      editedText: null,
      idempotencyKey: newIdempotencyKey(),
    });
    activeSession = result.session;
    if (result.nextQuestion) {
      updateQuestion(result.nextQuestion);
      announce(`Response saved. Question ${result.nextQuestion.sequence} is ready.`);
    } else {
      await showReceipt();
    }
  } catch (error) {
    if (terminalSessionError(error)) {
      await showReceipt();
    } else {
      reportError(error);
    }
  } finally {
    setBusy(submit, false);
  }
}

async function pauseCheckIn() {
  clearError();
  savedDraft = elements.response.value;
  setBusy(elements.pause, true);
  try {
    activeSession = await api.pause({ sessionId: activeSession.id, idempotencyKey: newIdempotencyKey() });
    setView("paused");
    elements.resume.focus();
    announce("Check-in paused. Your typed draft remains in this browser.");
  } catch (error) {
    if (terminalSessionError(error)) await showReceipt();
    else reportError(error);
  } finally {
    setBusy(elements.pause, false);
  }
}

async function resumeCheckIn() {
  clearError();
  setBusy(elements.resume, true);
  try {
    activeSession = await api.resume({ sessionId: activeSession.id, idempotencyKey: newIdempotencyKey() });
    setView("checkin");
    updateQuestion(activeQuestion);
    announce("Check-in resumed. The same question is ready.");
  } catch (error) {
    if (terminalSessionError(error)) await showReceipt();
    else reportError(error);
  } finally {
    setBusy(elements.resume, false);
  }
}

async function requestHumanFollowUp() {
  clearError();
  savedDraft = elements.response.value;
  setBusy(elements.followUp, true);
  try {
    activeSession = await api.requestHumanFollowUp({ sessionId: activeSession.id, idempotencyKey: newIdempotencyKey() });
    await showReceipt();
  } catch (error) {
    reportError(error);
  } finally {
    setBusy(elements.followUp, false);
  }
}

async function showReceipt() {
  try {
    const receipt = await api.getReceipt(activeSession.id);
    activeSession = receipt.session;
    setView("receipt");
    elements.receiptPolicy.textContent = receipt.policyVersionId;
    if (receipt.session.state === "human_follow_up") {
      elements.receiptTitle.textContent = "Human follow-up requested.";
      elements.receiptIntro.textContent = "No more automated questions will be asked. Your instructor or course support can review the request and offer the next appropriate route.";
      elements.receiptCompleted.closest("span").hidden = true;
    } else {
      elements.receiptTitle.textContent = "Your text check-in is complete.";
      elements.receiptIntro.textContent = "Your responses were recorded as typed text. Your instructor reviews any evidence card and makes all final decisions.";
      elements.receiptCompleted.closest("span").hidden = false;
      elements.receiptCompleted.textContent = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(receipt.completedAt));
    }
    elements.receiptList.replaceChildren();
    for (const [index, response] of receipt.responses.entries()) {
      const item = document.createElement("li");
      item.className = "el-receipt-item";
      const question = document.createElement("p");
      question.className = "el-receipt-question";
      const label = document.createElement("strong");
      label.textContent = `Question ${index + 1}:`;
      question.append(label, document.createTextNode(` ${receipt.questions[index].text}`));
      const answer = document.createElement("p");
      answer.className = "el-receipt-answer";
      answer.textContent = response.canonical_text;
      item.append(question, answer);
      elements.receiptList.append(item);
    }
    elements.receiptTitle.focus();
    announce(receipt.session.state === "human_follow_up" ? "Human follow-up requested. Your receipt is ready." : "Check-in complete. Your receipt is ready.");
  } catch (error) {
    reportError(error);
  }
}

elements.start.addEventListener("click", startCheckIn);
elements.responseForm.addEventListener("submit", submitResponse);
elements.pause.addEventListener("click", pauseCheckIn);
elements.resume.addEventListener("click", resumeCheckIn);
elements.followUp.addEventListener("click", requestHumanFollowUp);
elements.supportButton.addEventListener("click", () => {
  setView("support");
  document.querySelector("#support-title").focus();
});

loadBriefing();
