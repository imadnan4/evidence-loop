import { F04aSessionApi, SessionApiError } from "/demo/assets/learner-session-api.js";
import { F07aVoiceApi, RealtimeVoiceTransport, VoiceTransportError } from "/demo/assets/voice-checkin.js";

const sessionId = new URLSearchParams(window.location.search).get("session");
const api = new F04aSessionApi();
const voiceApi = new F07aVoiceApi();
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
  typedField: document.querySelector("#typed-response-field"),
  responseForm: document.querySelector("#response-form"),
  pause: document.querySelector("#pause-checkin"),
  resume: document.querySelector("#resume-checkin"),
  followUp: document.querySelector("#request-follow-up"),
  supportButton: document.querySelector("#show-support"),
  error: document.querySelector("#checkin-error"),
  voiceNotice: document.querySelector("#voice-notice"),
  status: document.querySelector("#checkin-status"),
  receiptList: document.querySelector("#receipt-responses"),
  receiptTitle: document.querySelector("#receipt-title"),
  receiptIntro: document.querySelector("#receipt-intro"),
  receiptCompleted: document.querySelector("#receipt-completed"),
  receiptPolicy: document.querySelector("#receipt-policy"),
  enableVoice: document.querySelector("#enable-voice"),
  voicePanel: document.querySelector("#voice-panel"),
  voiceStatus: document.querySelector("#voice-status"),
  voiceTranscript: document.querySelector("#voice-transcript"),
  toggleVoiceCapture: document.querySelector("#toggle-voice-capture"),
  replayQuestion: document.querySelector("#replay-question"),
  switchToText: document.querySelector("#switch-to-text"),
};

let briefing;
let activeSession;
let activeQuestion;
let savedDraft = "";
let responseRoute = "text";
let voice = emptyVoice();

function emptyVoice() {
  return { connectionId: null, transport: null, rawTranscript: "", renderedTranscript: "", capturePaused: false, submitIdempotencyKey: null };
}

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

function setVoiceStatus(message) {
  elements.voiceStatus.textContent = message;
  announce(message);
}

function showVoiceNotice(message) {
  elements.voiceNotice.textContent = message;
  elements.voiceNotice.hidden = false;
  announce(message);
}

function clearVoiceNotice() {
  elements.voiceNotice.textContent = "";
  elements.voiceNotice.hidden = true;
}

function setResponseRoute(route, { preserveVoiceDraft = true } = {}) {
  responseRoute = route;
  const voiceActive = route === "voice";
  if (!voiceActive && preserveVoiceDraft && elements.voiceTranscript.value.trim()) {
    elements.response.value = elements.voiceTranscript.value;
  }
  elements.voicePanel.hidden = !voiceActive;
  elements.typedField.hidden = voiceActive;
  elements.response.required = !voiceActive;
  elements.voiceTranscript.required = voiceActive;
  elements.enableVoice.disabled = voiceActive;
  elements.enableVoice.textContent = voiceActive ? "Voice response in use" : "Use voice for this response";
}

function stopVoiceTransport() {
  voice.transport?.stop();
  voice.transport = null;
  voice.capturePaused = false;
  elements.toggleVoiceCapture.disabled = true;
  elements.toggleVoiceCapture.textContent = "Pause voice capture";
}

function resetVoiceForQuestion() {
  stopVoiceTransport();
  voice = emptyVoice();
  elements.voiceTranscript.value = "";
  setResponseRoute("text", { preserveVoiceDraft: false });
}

function updateQuestion(question) {
  resetVoiceForQuestion();
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
    announce("Text check-in started. Question 1 is ready. Voice is available as an optional response method if enabled by your assessment.");
  } catch (error) {
    reportError(error);
  } finally {
    setBusy(elements.start, false);
  }
}

function appendTranscript(update) {
  if (update.kind === "completed") voice.rawTranscript = update.text;
  else voice.rawTranscript += update.text;
  const next = voice.rawTranscript;
  // Do not overwrite a learner's manual correction while new transcript events arrive.
  if (!elements.voiceTranscript.value || elements.voiceTranscript.value === voice.renderedTranscript) {
    elements.voiceTranscript.value = next;
  }
  voice.renderedTranscript = next;
}

async function enableVoice() {
  clearError();
  clearVoiceNotice();
  if (!activeSession || !activeQuestion || responseRoute === "voice") return;
  setBusy(elements.enableVoice, true);
  try {
    const voiceSession = await voiceApi.requestRealtimeCredential({ sessionId: activeSession.id, idempotencyKey: newIdempotencyKey() });
    if (voiceSession.mode !== "voice") {
      setResponseRoute("text");
      announce(voiceSession.message || "Voice is unavailable. You can continue with text without losing progress.");
      elements.response.focus();
      return;
    }
    voice.connectionId = voiceSession.connectionId;
    voice.rawTranscript = elements.response.value;
    voice.renderedTranscript = voice.rawTranscript;
    elements.voiceTranscript.value = voice.rawTranscript;
    setResponseRoute("voice", { preserveVoiceDraft: false });
    setVoiceStatus("Requesting microphone access…");
    const transport = new RealtimeVoiceTransport();
    voice.transport = await transport.connect({
      ephemeralToken: voiceSession.credential?.ephemeralToken,
      onTranscript: appendTranscript,
      onConnectionState: (reason) => { void fallbackToText(reason); },
    });
    elements.toggleVoiceCapture.disabled = false;
    setVoiceStatus("Voice capture is on. Your live transcript appears below and can be edited.");
    elements.voiceTranscript.focus();
  } catch (error) {
    const reason = error instanceof VoiceTransportError ? error.code : "connection_failed";
    await fallbackToText(reason, "Voice could not start. You can continue with text without losing progress.");
  } finally {
    setBusy(elements.enableVoice, false);
  }
}

async function fallbackToText(reason, message) {
  const connectionId = voice.connectionId;
  stopVoiceTransport();
  setResponseRoute("text");
  announce(message || "Voice is unavailable. You can continue with text without losing progress.");
  elements.response.focus();
  if (connectionId && activeSession) {
    try {
      const fallback = await voiceApi.recordFallback({ sessionId: activeSession.id, connectionId, reason, idempotencyKey: newIdempotencyKey() });
      if (fallback.message) announce(fallback.message);
    } catch {
      showVoiceNotice("Voice capture is stopped. We could not record that connection problem, but you can continue with text without losing progress.");
    }
  }
}

async function switchToText() {
  clearError();
  const connectionId = stopVoiceAndReturnToText();
  announce("Switched to text. Your current transcript is available as an editable typed draft.");
  elements.response.focus();
  await recordIntentionalVoiceExit("switch_to_text", connectionId);
}

function stopVoiceAndReturnToText() {
  const connectionId = voice.connectionId;
  stopVoiceTransport();
  setResponseRoute("text");
  return connectionId;
}

async function recordIntentionalVoiceExit(reason, connectionId = voice.connectionId) {
  if (!connectionId || !activeSession) return true;
  try {
    await voiceApi.recordIntentionalExit({
      sessionId: activeSession.id,
      connectionId,
      reason,
      idempotencyKey: newIdempotencyKey(),
    });
    return true;
  } catch {
    showVoiceNotice("Voice capture is stopped. We could not record that change right now; your text or human-support route is still available. Please contact course support if you need help.");
    return false;
  }
}

function toggleVoiceCapture() {
  if (!voice.transport) return;
  voice.capturePaused = !voice.capturePaused;
  if (voice.capturePaused) {
    voice.transport.pause();
    elements.toggleVoiceCapture.textContent = "Resume voice capture";
    setVoiceStatus("Voice capture paused. You can edit the transcript or resume when ready.");
  } else {
    voice.transport.resume();
    elements.toggleVoiceCapture.textContent = "Pause voice capture";
    setVoiceStatus("Voice capture resumed. Your live transcript will continue below.");
  }
}

function replayQuestion() {
  const text = activeQuestion?.text;
  if (!text || !globalThis.speechSynthesis || typeof globalThis.SpeechSynthesisUtterance !== "function") {
    setVoiceStatus("Question replay is unavailable in this browser. The question remains available as text.");
    return;
  }
  globalThis.speechSynthesis.cancel();
  globalThis.speechSynthesis.speak(new globalThis.SpeechSynthesisUtterance(text));
  setVoiceStatus("Replaying the question aloud. The written question remains available on this page.");
}

async function submitVoiceResponse() {
  const editedTranscript = elements.voiceTranscript.value.trim();
  if (!editedTranscript) throw new Error("Wait for or enter a transcript before continuing, or switch to the text route.");
  if (!voice.connectionId) throw new Error("Voice is no longer connected. Switch to text to continue without losing your draft.");
  const transcript = voice.rawTranscript.trim() || editedTranscript;
  const edit = transcript === editedTranscript ? null : editedTranscript;
  // The F07a operation is the sole canonical write. Its one retry key
  // atomically stores the voice transcript/response, audit event, and finite
  // session advancement; never follow this with F04a /answers.
  voice.submitIdempotencyKey ??= newIdempotencyKey();
  const result = await voiceApi.persistTranscript({
    sessionId: activeSession.id,
    connectionId: voice.connectionId,
    questionId: activeQuestion.id,
    transcript,
    editedTranscript: edit,
    idempotencyKey: voice.submitIdempotencyKey,
  });
  stopVoiceTransport();
  return result;
}

async function submitResponse(event) {
  event.preventDefault();
  clearError();
  const responseText = responseRoute === "voice" ? elements.voiceTranscript.value.trim() : elements.response.value.trim();
  if (!responseText) {
    reportError(new Error(responseRoute === "voice" ? "Wait for or enter a transcript before continuing, or switch to text." : "Enter a typed response before continuing."));
    return;
  }
  const submit = event.submitter ?? elements.responseForm.querySelector("button[type=submit]");
  setBusy(submit, true);
  try {
    const result = responseRoute === "voice"
      ? await submitVoiceResponse()
      : await api.submitTextResponse({ sessionId: activeSession.id, questionId: activeQuestion.id, canonicalText: responseText, editedText: null, idempotencyKey: newIdempotencyKey() });
    activeSession = result.session;
    if (result.nextQuestion) {
      updateQuestion(result.nextQuestion);
      announce(`Response saved. Question ${result.nextQuestion.sequence} is ready.`);
    } else {
      await showReceipt();
    }
  } catch (error) {
    if (terminalSessionError(error)) await showReceipt();
    else reportError(error);
  } finally {
    setBusy(submit, false);
  }
}

async function pauseCheckIn() {
  clearError();
  savedDraft = responseRoute === "voice" ? elements.voiceTranscript.value : elements.response.value;
  const voiceConnectionId = responseRoute === "voice" ? stopVoiceAndReturnToText() : null;
  setBusy(elements.pause, true);
  try {
    activeSession = await api.pause({ sessionId: activeSession.id, idempotencyKey: newIdempotencyKey() });
    await recordIntentionalVoiceExit("session_paused", voiceConnectionId);
    setView("paused");
    elements.resume.focus();
    announce("Check-in paused. Your response draft remains in this browser.");
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
  savedDraft = responseRoute === "voice" ? elements.voiceTranscript.value : elements.response.value;
  const voiceConnectionId = responseRoute === "voice" ? stopVoiceAndReturnToText() : null;
  setBusy(elements.followUp, true);
  try {
    activeSession = await api.requestHumanFollowUp({ sessionId: activeSession.id, idempotencyKey: newIdempotencyKey() });
    await recordIntentionalVoiceExit("human_follow_up", voiceConnectionId);
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
      elements.receiptTitle.textContent = "Your check-in is complete.";
      elements.receiptIntro.textContent = "Your typed responses and any learner-approved voice transcripts were recorded as text. Your instructor reviews any evidence card and makes all final decisions.";
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
elements.enableVoice.addEventListener("click", enableVoice);
elements.toggleVoiceCapture.addEventListener("click", toggleVoiceCapture);
elements.replayQuestion.addEventListener("click", replayQuestion);
elements.switchToText.addEventListener("click", switchToText);
elements.supportButton.addEventListener("click", () => {
  setView("support");
  document.querySelector("#support-title").focus();
});

loadBriefing();
