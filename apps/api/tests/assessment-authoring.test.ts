import assert from "node:assert/strict";
import test from "node:test";

import {
  AssessmentVersionSchema,
  CreateAssessmentRequestSchema,
} from "@evidence-loop/contracts/v1";

import {
  ApiError,
  AssessmentAuthoringService,
  InMemoryAssessmentRepository,
} from "../src/assessment/index.ts";

const instructor = { userId: "instructor-1" };
const learner = { userId: "learner-1" };
const outsider = { userId: "instructor-2" };

function assessmentInput() {
  return {
    title: "Apartment price model",
    assignmentInstructions: "Explain how your model avoids leakage.",
    objectives: [
      {
        label: "Prepare data",
        description: "Describe preparation choices.",
        evidenceCriteria: "Names transformations and their purpose.",
        assessableInCheckIn: true,
      },
      {
        label: "Avoid leakage",
        description: "Explain validation boundaries.",
        evidenceCriteria: "Places fitting after a training split.",
        assessableInCheckIn: true,
      },
      {
        label: "Justify model choice",
        description: "Explain a model selection.",
        evidenceCriteria: "Connects a choice to the data.",
        assessableInCheckIn: true,
      },
    ],
    rubric: {
      criteria: [
        {
          label: "Validation reasoning",
          description: "Reason about validation.",
          evidenceCriteria: "Explains separation of evaluation data.",
        },
      ],
    },
    policy: {
      learnerFacingText: "This check-in helps you show your thinking; it does not automatically grade you.",
      aiUsePolicy: "allowed_with_disclosure" as const,
      privacySummary: "Your text response is the canonical record.",
      completionCriteria: "Answer the finite set of questions or request human follow-up.",
    },
    accommodations: {
      textCheckIn: true,
      voiceCheckIn: true,
      extraTime: true,
      pauseAndResume: true,
      alternativeAssessmentRequest: true,
    },
    questionBudget: 3,
    timeBudgetMinutes: 3,
  };
}

function setup() {
  let serial = 0;
  const service = new AssessmentAuthoringService(new InMemoryAssessmentRepository(), {
    id: () => `id-${++serial}`,
    now: () => "2026-07-18T00:00:00.000Z",
  });
  const course = service.createCourse(instructor, {
    organizationId: "org-1",
    title: "Data analysis",
    term: "Fall",
  });
  return { service, course };
}

test("only course instructors/admins can author, while course members read only published versions", () => {
  const { service, course } = setup();
  service.enroll(instructor, course.id, learner.userId, "learner");
  const created = service.createAssessment(instructor, course.id, assessmentInput());

  assert.throws(
    () => service.getVersionForAuthoring(learner, created.draft.id),
    (error: unknown) => error instanceof ApiError && error.code === "FORBIDDEN",
  );
  assert.throws(
    () => service.getPublishedVersion(learner, created.assessment.id),
    (error: unknown) => error instanceof ApiError && error.code === "NOT_FOUND",
  );
  assert.throws(
    () => service.createDraftVersion(outsider, created.assessment.id),
    (error: unknown) => error instanceof ApiError && error.code === "FORBIDDEN",
  );
  assert.throws(
    () => service.updateDraft(outsider, created.draft.id, { timeBudgetMinutes: 4 }),
    (error: unknown) => error instanceof ApiError && error.code === "FORBIDDEN",
  );
  assert.throws(
    () => service.publishVersion(outsider, created.draft.id),
    (error: unknown) => error instanceof ApiError && error.code === "FORBIDDEN",
  );

  service.publishVersion(instructor, created.draft.id);
  assert.throws(
    () => service.getPublishedVersion(outsider, created.assessment.id),
    (error: unknown) => error instanceof ApiError && error.code === "FORBIDDEN",
  );
  const learnerView = service.getPublishedVersion(learner, created.assessment.id);
  assert.equal(learnerView.status, "published");
  assert.equal(learnerView.courseId, course.id);
});

test("a course admin has the same course-scoped authoring authority as an instructor", () => {
  const { service, course } = setup();
  const courseAdmin = { userId: "course-admin-1" };
  service.enroll(instructor, course.id, courseAdmin.userId, "course_admin");

  const { assessment, draft } = service.createAssessment(courseAdmin, course.id, assessmentInput());
  const published = service.publishVersion(courseAdmin, draft.id);
  assert.equal(published.publishedBy, courseAdmin.userId);
  assert.equal(service.getPublishedVersion(courseAdmin, assessment.id).id, published.id);
});

test("a published version is deeply immutable and later drafts cannot rewrite it", () => {
  const { service, course } = setup();
  const { assessment, draft } = service.createAssessment(instructor, course.id, assessmentInput());
  const published = service.publishVersion(instructor, draft.id);

  assert.equal(Object.isFrozen(published), true);
  assert.equal(Object.isFrozen(published.objectives), true);
  assert.equal(Object.isFrozen(published.policy), true);
  assert.throws(() => {
    (published.policy as { aiUsePolicy: string }).aiUsePolicy = "allowed";
  }, TypeError);
  assert.throws(
    () => service.updateDraft(instructor, published.id, { timeBudgetMinutes: 4 }),
    (error: unknown) => error instanceof ApiError && error.code === "CONFLICT",
  );

  const nextDraft = service.createDraftVersion(instructor, assessment.id);
  const revised = service.updateDraft(instructor, nextDraft.id, { timeBudgetMinutes: 4 });
  assert.equal(revised.timeBudgetMinutes, 4);
  assert.equal(service.getPublishedVersion(instructor, assessment.id).timeBudgetMinutes, 3);
  assert.equal(service.getPublishedVersion(instructor, assessment.id).objectives[0].label, "Prepare data");
});

test("publishing requires the bounded, instructor-approved check-in setup", () => {
  const { service, course } = setup();
  const input = assessmentInput();
  input.objectives = input.objectives.slice(0, 2);
  const { draft } = service.createAssessment(instructor, course.id, input);

  assert.throws(
    () => service.publishVersion(instructor, draft.id),
    (error: unknown) =>
      error instanceof ApiError &&
      error.code === "INVALID_REQUEST" &&
      error.message.includes("3 to 5 assessable"),
  );
});

test("accessible authoring always preserves the typed route", () => {
  const { service, course } = setup();
  const voiceOnly = assessmentInput();
  voiceOnly.accommodations = { ...voiceOnly.accommodations, textCheckIn: false, voiceCheckIn: true };

  assert.throws(
    () => service.createAssessment(instructor, course.id, voiceOnly),
    (error: unknown) =>
      error instanceof ApiError &&
      error.code === "INVALID_REQUEST" &&
      error.message.includes("text fallback"),
  );

  const noTextRoute = assessmentInput();
  noTextRoute.accommodations = { ...noTextRoute.accommodations, textCheckIn: false, voiceCheckIn: false };
  assert.throws(
    () => service.createAssessment(instructor, course.id, noTextRoute),
    (error: unknown) => error instanceof ApiError && error.code === "INVALID_REQUEST",
  );
});

test("F00 public contracts validate the authoring boundary and prohibited fields", () => {
  const validRequest = {
    course_id: "course-01",
    title: "Apartment price model",
    idempotency_key: "request-01",
  };
  assert.equal(CreateAssessmentRequestSchema.safeParse(validRequest).success, true);
  assert.equal(CreateAssessmentRequestSchema.safeParse({ ...validRequest, grade: "A" }).success, false);

  // The public entry is imported above; this also verifies the published-version schema is available.
  assert.equal(AssessmentVersionSchema.version, "v1");
});

test("authoring input rejects uncontracted score and grade fields", () => {
  const { service, course } = setup();
  const unsafeInput = {
    ...assessmentInput(),
    grade: "A",
  };
  assert.throws(
    () => service.createAssessment(instructor, course.id, unsafeInput as never),
    (error: unknown) =>
      error instanceof ApiError && error.code === "INVALID_REQUEST" && error.message.includes("assessment.grade"),
  );
});
