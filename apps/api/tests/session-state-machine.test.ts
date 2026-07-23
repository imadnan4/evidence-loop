import assert from "node:assert/strict";
import test from "node:test";

import {
  InMemorySessionRepository,
  InMemoryTrustedSessionResolver,
  SessionError,
  TextCheckInSessionService,
  type ResolvedTextCheckInContext,
} from "../src/session/index.ts";

const learner = { userId: "learner-1" };
const outsider = { userId: "learner-2" };

function trustedContext(overrides: Partial<ResolvedTextCheckInContext> = {}): ResolvedTextCheckInContext {
  return {
    submissionId: "submission-1",
    learnerId: learner.userId,
    submissionCourseId: "course-1",
    assessmentCourseId: "course-1",
    submissionState: "ready",
    assessmentVersionId: "version-1",
    assessmentVersionState: "published",
    policyVersionId: "version-1",
    policy: {
      learnerFacingText: "Show your thinking. This does not automatically grade you.",
      aiUsePolicy: "allowed_with_disclosure",
      privacySummary: "Your typed response is the canonical record.",
      completionCriteria: "Answer the three questions or request human follow-up.",
    },
    questionBudget: 3,
    timeBudgetMinutes: 3,
    pauseAndResume: true,
    voiceCheckInEnabled: true,
    objectives: [
      { id: "objective-prep", label: "data preparation", assessableInCheckIn: true, approvedBy: "instructor-1", approvedAt: "2026-07-17T12:00:00.000Z" },
      { id: "objective-leakage", label: "leakage and validation", assessableInCheckIn: true, approvedBy: "instructor-1", approvedAt: "2026-07-17T12:00:00.000Z" },
      { id: "objective-interpret", label: "interpretation", assessableInCheckIn: true, approvedBy: "instructor-1", approvedAt: "2026-07-17T12:00:00.000Z" },
    ],
    objectiveFragmentIds: [
      { objectiveId: "objective-prep", fragmentIds: ["fragment-prep"] },
      { objectiveId: "objective-leakage", fragmentIds: ["fragment-leakage"] },
      { objectiveId: "objective-interpret", fragmentIds: ["fragment-interpret"] },
    ],
    fragments: [
      { id: "fragment-prep", submissionId: "submission-1", locator: "cell:prep" },
      { id: "fragment-leakage", submissionId: "submission-1", locator: "cell:leakage" },
      { id: "fragment-interpret", submissionId: "submission-1", locator: "cell:interpret" },
    ],
    ...overrides,
  };
}

function setup({
  now = () => "2026-07-18T12:00:00.000Z",
  contexts = [trustedContext()],
}: { now?: () => string; contexts?: readonly ResolvedTextCheckInContext[] } = {}) {
  let serial = 0;
  const service = new TextCheckInSessionService(
    new InMemorySessionRepository(),
    new InMemoryTrustedSessionResolver(contexts),
    { id: () => `id-${++serial}`, now },
  );
  return { service };
}

function sessionInput(key = "create-1") {
  return { submissionId: "submission-1", idempotencyKey: key };
}

async function prepareStartedSession(service: TextCheckInSessionService) {
  const session = await service.createSession(learner, sessionInput());
  await service.showPolicy(learner, { sessionId: session.id, idempotencyKey: "shown-1" });
  await service.acknowledgePolicy(learner, { sessionId: session.id, policyVersionId: "version-1", idempotencyKey: "ack-1" });
  return service.start(learner, { sessionId: session.id, policyVersionId: "version-1", mode: "text", idempotencyKey: "start-1" });
}

test("a typed check-in requires learner-visible policy acknowledgement before deterministic questions start", async () => {
  const { service } = setup();
  const session = await service.createSession(learner, sessionInput());

  await assert.rejects(
    async () => { await service.start(learner, { sessionId: session.id, policyVersionId: "version-1", mode: "text", idempotencyKey: "start-before-policy" }); },
    (error: unknown) => error instanceof SessionError && error.code === "INVALID_STATE",
  );
  const briefing = await service.showPolicy(learner, { sessionId: session.id, idempotencyKey: "shown-1" });
  assert.equal(briefing.textCheckInAvailable, true);
  assert.equal(briefing.policy.privacySummary, "Your typed response is the canonical record.");
  await service.acknowledgePolicy(learner, { sessionId: session.id, policyVersionId: "version-1", idempotencyKey: "ack-1" });

  const started = await service.start(learner, { sessionId: session.id, policyVersionId: "version-1", mode: "text", idempotencyKey: "start-1" });
  assert.equal(started.session.state, "in_progress");
  assert.equal(started.question.sequence, 1);
  assert.equal(started.question.objective_id, "objective-prep");
  assert.equal(started.question.source_refs[0].submission_id, "submission-1");
  assert.match(started.question.text, /data preparation/);
});

test("pause and resume preserve the outstanding typed question without spending more budget", async () => {
  const { service } = setup();
  const started = await prepareStartedSession(service);
  const paused = await service.pause(learner, { sessionId: started.session.id, idempotencyKey: "pause-1" });
  assert.equal(paused.state, "paused");
  assert.equal(paused.questions_asked, 1);
  const resumed = await service.resume(learner, { sessionId: paused.id, idempotencyKey: "resume-1" });
  assert.equal(resumed.state, "in_progress");
  assert.equal(resumed.questions_asked, 1);
  await assert.rejects(
    async () => { await service.submitTextResponse(learner, { sessionId: resumed.id, questionId: "id-not-a-question", canonicalText: "reasoning", editedText: null, idempotencyKey: "bad-question" }); },
    (error: unknown) => error instanceof SessionError && error.code === "NOT_FOUND",
  );
});

test("the finite question budget completes the session and returns a canonical text receipt", async () => {
  const { service } = setup();
  let started = await prepareStartedSession(service);
  let result = await service.submitTextResponse(learner, {
    sessionId: started.session.id, questionId: started.question.id, canonicalText: "I fit transformations on training data.", editedText: null, idempotencyKey: "answer-1",
  });
  assert.equal(result.session.state, "in_progress");
  assert.equal(result.nextQuestion?.objective_id, "objective-leakage");
  result = await service.submitTextResponse(learner, {
    sessionId: result.session.id, questionId: result.nextQuestion!.id, canonicalText: "The held-out set must not affect fitting.", editedText: "The held-out set must not affect fitting or selection.", idempotencyKey: "answer-2",
  });
  assert.equal(result.nextQuestion?.objective_id, "objective-interpret");
  result = await service.submitTextResponse(learner, {
    sessionId: result.session.id, questionId: result.nextQuestion!.id, canonicalText: "I would connect the prediction to the feature values.", editedText: null, idempotencyKey: "answer-3",
  });
  assert.equal(result.session.state, "completed");
  assert.equal(result.nextQuestion, null);

  const receipt = await service.getReceipt(learner, result.session.id);
  assert.equal(receipt.questions.length, 3);
  assert.equal(receipt.responses.length, 3);
  assert.equal(receipt.responses[1].canonical_text, "The held-out set must not affect fitting.");
  assert.equal(receipt.responses[1].edited_text, "The held-out set must not affect fitting or selection.");
  assert.deepEqual((await service.getTimeline(learner, result.session.id)).map((event) => event.action), [
    "policy_shown", "policy_acknowledged", "session_started", "question_issued", "response_submitted", "question_issued", "response_submitted", "question_issued", "response_submitted", "session_completed",
  ]);
});

test("writes replay with the same idempotency key and reject a changed request", async () => {
  const secondSubmission = trustedContext({
    submissionId: "submission-2",
    fragments: [
      { id: "fragment-prep", submissionId: "submission-2", locator: "cell:prep" },
      { id: "fragment-leakage", submissionId: "submission-2", locator: "cell:leakage" },
      { id: "fragment-interpret", submissionId: "submission-2", locator: "cell:interpret" },
    ],
  });
  const { service } = setup({ contexts: [trustedContext(), secondSubmission] });
  const first = await service.createSession(learner, sessionInput("create-replay"));
  const replay = await service.createSession(learner, sessionInput("create-replay"));
  assert.equal(replay.id, first.id);
  await assert.rejects(
    async () => { await service.createSession(learner, { submissionId: "submission-2", idempotencyKey: "create-replay" }); },
    (error: unknown) => error instanceof SessionError && error.code === "IDEMPOTENCY_CONFLICT",
  );

  await service.showPolicy(learner, { sessionId: first.id, idempotencyKey: "shown-1" });
  await service.acknowledgePolicy(learner, { sessionId: first.id, policyVersionId: "version-1", idempotencyKey: "ack-1" });
  const started = await service.start(learner, { sessionId: first.id, policyVersionId: "version-1", mode: "text", idempotencyKey: "start-1" });
  const response = { sessionId: first.id, questionId: started.question.id, canonicalText: "My explanation.", editedText: null, idempotencyKey: "answer-replay" };
  assert.equal((await service.submitTextResponse(learner, response)).response.id, (await service.submitTextResponse(learner, response)).response.id);
  await assert.rejects(
    async () => { await service.submitTextResponse(learner, { ...response, canonicalText: "A different explanation." }); },
    (error: unknown) => error instanceof SessionError && error.code === "IDEMPOTENCY_CONFLICT",
  );
});

test("trusted resolution rejects another learner, unpublished/mismatched versions, and fabricated fragment provenance", async () => {
  const { service: privateService } = setup({ contexts: [trustedContext({ learnerId: outsider.userId })] });
  await assert.rejects(
    async () => { await privateService.createSession(learner, sessionInput()); },
    (error: unknown) => error instanceof SessionError && error.code === "NOT_FOUND",
  );
  const unapprovedObjectives = trustedContext().objectives.map(({ approvedAt: _approvedAt, ...objective }) => objective);
  for (const context of [
    trustedContext({ submissionState: "submitted" as never }),
    trustedContext({ assessmentVersionState: "draft" as never }),
    trustedContext({ submissionCourseId: "course-other" }),
    trustedContext({ objectives: unapprovedObjectives as never }),
    trustedContext({ policyVersionId: "policy-other" }),
    trustedContext({ objectiveFragmentIds: [{ objectiveId: "objective-prep", fragmentIds: ["fabricated-fragment"] }, { objectiveId: "objective-leakage", fragmentIds: ["fragment-leakage"] }, { objectiveId: "objective-interpret", fragmentIds: ["fragment-interpret"] }] }),
    trustedContext({ fragments: [{ id: "fragment-prep", submissionId: "submission-2", locator: "cell:prep" }, { id: "fragment-leakage", submissionId: "submission-1", locator: "cell:leakage" }, { id: "fragment-interpret", submissionId: "submission-1", locator: "cell:interpret" }] }),
  ]) {
    const { service } = setup({ contexts: [context] });
    await assert.rejects(
      async () => { await service.createSession(learner, sessionInput()); },
      (error: unknown) => error instanceof SessionError && (error.code === "INVALID_REQUEST" || error.code === "INVALID_STATE"),
    );
  }

  const { service } = setup();
  const session = await service.createSession(learner, sessionInput());
  await assert.rejects(
    async () => { await service.showPolicy(outsider, { sessionId: session.id, idempotencyKey: "outside" }); },
    (error: unknown) => error instanceof SessionError && error.code === "FORBIDDEN",
  );
});

test("the time budget completes the session without accepting a late response, while pauses do not consume it", async () => {
  let now = "2026-07-18T12:00:00.000Z";
  const { service } = setup({ now: () => now });
  const started = await prepareStartedSession(service);
  now = "2026-07-18T12:01:00.000Z";
  await service.pause(learner, { sessionId: started.session.id, idempotencyKey: "pause-time" });
  now = "2026-07-18T12:11:00.000Z";
  await service.resume(learner, { sessionId: started.session.id, idempotencyKey: "resume-time" });
  now = "2026-07-18T12:13:00.000Z";
  await assert.rejects(
    async () => { await service.submitTextResponse(learner, { sessionId: started.session.id, questionId: started.question.id, canonicalText: "Late response", editedText: null, idempotencyKey: "late-response" }); },
    (error: unknown) => error instanceof SessionError && error.code === "INVALID_STATE" && error.message.includes("time budget"),
  );
  const receipt = await service.getReceipt(learner, started.session.id);
  assert.equal(receipt.responses.length, 0);
  assert.equal(receipt.session.completed_at, "2026-07-18T12:13:00.000Z");
});

test("the learner can request a human follow-up instead of continuing indefinitely", async () => {
  const { service } = setup();
  const started = await prepareStartedSession(service);
  const requested = await service.requestHumanFollowUp(learner, { sessionId: started.session.id, idempotencyKey: "follow-up-1" });
  assert.equal(requested.state, "human_follow_up");
  const receipt = await service.getReceipt(learner, requested.id);
  assert.equal(receipt.session.state, "human_follow_up");
  assert.equal(receipt.policyVersionId, "version-1");
  assert.equal(receipt.questions.length, 1);
  assert.equal(receipt.responses.length, 0);
  assert.equal(receipt.completedAt, null);
});

test("unsafe judgment fields and voice mode are rejected from the typed-session boundary", async () => {
  const { service } = setup();
  await assert.rejects(
    async () => { await service.createSession(learner, { ...sessionInput(), cheatingLikelihood: 0.8 } as never); },
    (error: unknown) => error instanceof SessionError && error.code === "INVALID_REQUEST",
  );
  const started = await prepareStartedSession(service);
  await assert.rejects(
    async () => { await service.start(learner, { sessionId: started.session.id, policyVersionId: "version-1", mode: "voice" as never, idempotencyKey: "voice-not-f04" }); },
    (error: unknown) => error instanceof SessionError && error.code === "INVALID_REQUEST",
  );
});
