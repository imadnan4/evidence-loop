import assert from "node:assert/strict";
import test from "node:test";

import {
  F04VoiceSessionAccessAdapter,
  InMemoryVoiceRepository,
  RealtimeCredentialAdapter,
  VoicePolicyError,
  VoiceService,
} from "../src/voice/index.js";
import {
  InMemorySessionRepository,
  InMemoryTrustedSessionResolver,
  TextCheckInSessionService,
} from "../src/session/index.ts";

const NOW = "2026-07-18T12:00:00.000Z";
const learner = { userId: "learner-1" };

function trustedContext() {
  return {
    submissionId: "submission-1", learnerId: learner.userId, submissionCourseId: "course-1", assessmentCourseId: "course-1",
    submissionState: "ready", assessmentVersionId: "version-1", assessmentVersionState: "published", policyVersionId: "version-1",
    policy: { learnerFacingText: "Show your thinking.", aiUsePolicy: "allowed", privacySummary: "Text is retained.", completionCriteria: "Answer the questions." },
    questionBudget: 3, timeBudgetMinutes: 3, pauseAndResume: true, voiceCheckInEnabled: true,
    objectives: [
      { id: "objective-1", label: "data preparation", assessableInCheckIn: true, approvedBy: "instructor-1", approvedAt: NOW },
      { id: "objective-2", label: "validation", assessableInCheckIn: true, approvedBy: "instructor-1", approvedAt: NOW },
      { id: "objective-3", label: "interpretation", assessableInCheckIn: true, approvedBy: "instructor-1", approvedAt: NOW },
    ],
    objectiveFragmentIds: [
      { objectiveId: "objective-1", fragmentIds: ["fragment-1"] },
      { objectiveId: "objective-2", fragmentIds: ["fragment-2"] },
      { objectiveId: "objective-3", fragmentIds: ["fragment-3"] },
    ],
    fragments: [
      { id: "fragment-1", submissionId: "submission-1", locator: "cell:1" },
      { id: "fragment-2", submissionId: "submission-1", locator: "cell:2" },
      { id: "fragment-3", submissionId: "submission-1", locator: "cell:3" },
    ],
  };
}

function setup({ issuer = async () => ({ ephemeralToken: "ephemeral-browser-token-123456" }) } = {}) {
  let serial = 0;
  const sessionRepository = new InMemorySessionRepository();
  const sessionService = new TextCheckInSessionService(
    sessionRepository,
    new InMemoryTrustedSessionResolver([trustedContext()]),
    { id: () => `id-${++serial}`, now: () => NOW },
  );
  const session = sessionService.createSession(learner, { submissionId: "submission-1", idempotencyKey: "create" });
  sessionService.showPolicy(learner, { sessionId: session.id, idempotencyKey: "shown" });
  sessionService.acknowledgePolicy(learner, { sessionId: session.id, policyVersionId: "version-1", idempotencyKey: "ack" });
  const started = sessionService.start(learner, { sessionId: session.id, policyVersionId: "version-1", mode: "text", idempotencyKey: "start" });
  const voiceRepository = new InMemoryVoiceRepository();
  const service = new VoiceService({
    repository: voiceRepository,
    sessionAccess: new F04VoiceSessionAccessAdapter({ sessionService }),
    credentialAdapter: new RealtimeCredentialAdapter({ issueEphemeralCredential: issuer, model: "test-realtime", clock: () => Date.parse(NOW) }),
    clock: () => Date.parse(NOW),
    id: () => `voice-${++serial}`,
  });
  return { service, sessionService, sessionRepository, voiceRepository, started };
}

async function activeVoice(system) {
  return system.service.requestRealtimeCredential({ actorId: learner.userId, sessionId: system.started.session.id });
}

test("mints a narrow, short-lived credential without storing provider fields", async () => {
  const requests = [];
  const system = setup({ issuer: async (request) => {
    requests.push(request);
    return { ephemeralToken: "ephemeral-browser-token-123456", serverSecret: "never-expose" };
  } });
  const voice = await activeVoice(system);
  assert.deepEqual(requests, [{ model: "test-realtime", expiresAt: "2026-07-18T12:05:00.000Z", modalities: ["audio", "text"] }]);
  assert.equal(voice.mode, "voice");
  assert.equal("serverSecret" in voice.credential, false);
});

test("one atomic operation creates one voice response, provenance, audit entry, and one budget advancement", async () => {
  const system = setup();
  const voice = await activeVoice(system);
  const result = await system.service.persistTranscript({
    actorId: learner.userId, sessionId: system.started.session.id, connectionId: voice.connectionId, questionId: system.started.question.id,
    transcript: "I fit the scaler only on training data.", editedTranscript: "I fit the scaler only on training data before transforming held-out data.", idempotencyKey: "voice-answer-1",
  });
  assert.equal(result.responseId.startsWith("id-"), true);
  assert.equal(result.session.questions_asked, 2);
  assert.equal(result.nextQuestion?.sequence, 2);
  const responses = system.sessionRepository.listResponses(system.started.session.id);
  assert.equal(responses.length, 1);
  assert.equal(responses[0].modality, "voice");
  assert.equal(responses[0].canonical_text, "I fit the scaler only on training data before transforming held-out data.");
  const transcript = system.sessionRepository.getVoiceTranscriptForResponse(result.responseId);
  assert.equal(transcript?.transcript, "I fit the scaler only on training data.");
  assert.equal(transcript?.editedTranscript, responses[0].canonical_text);
  assert.deepEqual(system.sessionRepository.getVoiceResponseSourceRef(result.responseId), {
    source_type: "response", source_id: result.responseId, submission_id: "submission-1", locator: `question:${system.started.question.id}`,
  });
  assert.deepEqual(system.sessionService.getTimeline(learner, system.started.session.id).slice(-2).map((event) => event.action), ["response_submitted", "question_issued"]);
});

test("same-key retries return the single committed result and changed retry content is rejected", async () => {
  const system = setup();
  const voice = await activeVoice(system);
  const request = {
    actorId: learner.userId, sessionId: system.started.session.id, connectionId: voice.connectionId, questionId: system.started.question.id,
    transcript: "I separate train and test data.", editedTranscript: null, idempotencyKey: "retry-1",
  };
  const first = await system.service.persistTranscript(request);
  const retry = await system.service.persistTranscript(request);
  assert.equal(retry.idempotent, true);
  assert.equal(retry.responseId, first.responseId);
  assert.equal(system.sessionRepository.listResponses(system.started.session.id).length, 1);
  await assert.rejects(
    () => system.service.persistTranscript({ ...request, transcript: "different answer" }),
    (error) => error instanceof VoicePolicyError && error.code === "voice_idempotency_conflict",
  );
});

test("concurrent distinct retry keys still create exactly one canonical voice response", async () => {
  const system = setup();
  const voice = await activeVoice(system);
  const submit = (idempotencyKey) => system.service.persistTranscript({
    actorId: learner.userId, sessionId: system.started.session.id, connectionId: voice.connectionId, questionId: system.started.question.id,
    transcript: "One answer despite a transport retry.", editedTranscript: null, idempotencyKey,
  });
  const results = await Promise.allSettled([submit("concurrent-a"), submit("concurrent-b")]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.equal(system.sessionRepository.listResponses(system.started.session.id).length, 1);
});

test("cross-learner and policy-disabled voice requests are rejected before any response write", async () => {
  const system = setup();
  await assert.rejects(
    () => system.service.requestRealtimeCredential({ actorId: "learner-2", sessionId: system.started.session.id }),
    (error) => error instanceof VoicePolicyError && error.code === "voice_session_forbidden",
  );
  const disabled = setup();
  // The trusted session service, rather than browser input, controls this immutable policy value.
  disabled.sessionRepository.saveContext(disabled.started.session.id, { ...disabled.sessionRepository.getContext(disabled.started.session.id), voiceCheckInEnabled: false });
  await assert.rejects(
    () => activeVoice(disabled),
    (error) => error instanceof VoicePolicyError && error.code === "voice_not_enabled_by_policy",
  );
});

test("intentional switch, pause, and human-follow-up exits are not recorded as transport failures", async () => {
  const switched = setup();
  const switchVoice = await activeVoice(switched);
  const switchExit = await switched.service.recordIntentionalExit({ actorId: learner.userId, sessionId: switched.started.session.id, connectionId: switchVoice.connectionId, reason: "switch_to_text" });
  assert.deepEqual({ mode: switchExit.mode, reason: switchExit.reason, preserveProgress: switchExit.preserveProgress }, { mode: "text", reason: "switch_to_text", preserveProgress: true });

  const paused = setup();
  const pauseVoice = await activeVoice(paused);
  paused.sessionService.pause(learner, { sessionId: paused.started.session.id, idempotencyKey: "pause" });
  const pauseExit = await paused.service.recordIntentionalExit({ actorId: learner.userId, sessionId: paused.started.session.id, connectionId: pauseVoice.connectionId, reason: "session_paused" });
  assert.equal(pauseExit.mode, "stopped");
  const pausedConnection = await paused.voiceRepository.getConnection(pauseVoice.connectionId);
  assert.equal(pausedConnection.state, "intentional_exit");
  assert.equal(pausedConnection.exitReason, "session_paused");

  const followUp = setup();
  const followUpVoice = await activeVoice(followUp);
  followUp.sessionService.requestHumanFollowUp(learner, { sessionId: followUp.started.session.id, idempotencyKey: "follow-up" });
  const followUpExit = await followUp.service.recordIntentionalExit({ actorId: learner.userId, sessionId: followUp.started.session.id, connectionId: followUpVoice.connectionId, reason: "human_follow_up" });
  assert.equal(followUpExit.reason, "human_follow_up");
  assert.equal((await followUp.voiceRepository.getConnection(followUpVoice.connectionId)).exitReason, "human_follow_up");
});

test("provider failure returns the equivalent text fallback without changing session progress", async () => {
  const system = setup({ issuer: async () => { throw new Error("provider unavailable"); } });
  const result = await activeVoice(system);
  assert.deepEqual({ mode: result.mode, reason: result.reason, preserveProgress: result.preserveProgress }, { mode: "text", reason: "realtime_unavailable", preserveProgress: true });
  assert.equal(system.sessionRepository.listResponses(system.started.session.id).length, 0);
  assert.equal(system.sessionRepository.getSession(system.started.session.id).questions_asked, 1);
});
