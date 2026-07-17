import { randomUUID } from "node:crypto";

import { AssessmentVersionSchema } from "@evidence-loop/contracts/v1";

import { badRequest, conflict, forbidden, notFound } from "./errors.ts";
import type {
  AccommodationOptions,
  Actor,
  Assessment,
  AssessmentPolicy,
  AssessmentRepository,
  AssessmentVersion,
  AssessmentVersionStatus,
  Course,
  CourseRole,
  CreateAssessmentInput,
  CreateCourseInput,
  Enrollment,
  Objective,
  ObjectiveInput,
  Rubric,
  RubricCriterion,
  UpdateDraftInput,
} from "./types.ts";
import {
  allowedKeys,
  exactBoolean,
  immutable,
  optionalText,
  requiredText,
  wholeNumberInRange,
} from "./value.ts";

type Dependencies = Readonly<{
  id?: () => string;
  now?: () => string;
}>;

/**
 * Course-scoped assessment authoring. HTTP handlers should construct Actor
 * from authenticated server-side identity, never request body fields.
 */
export class AssessmentAuthoringService {
  private readonly repository: AssessmentRepository;
  private readonly id: () => string;
  private readonly now: () => string;

  constructor(repository: AssessmentRepository, dependencies: Dependencies = {}) {
    this.repository = repository;
    this.id = dependencies.id ?? randomUUID;
    this.now = dependencies.now ?? (() => new Date().toISOString());
  }

  createCourse(actor: Actor, input: CreateCourseInput): Course {
    const actorId = this.actorId(actor);
    const raw = allowedKeys(input, "course", ["organizationId", "title", "term"]);
    const course: Course = immutable({
      id: this.id(),
      organizationId: requiredText(raw.organizationId, "course.organizationId"),
      title: requiredText(raw.title, "course.title"),
      term: requiredText(raw.term, "course.term"),
      createdBy: actorId,
      createdAt: this.now(),
    });
    this.repository.saveCourse(course);
    this.repository.saveEnrollment(
      immutable({ courseId: course.id, userId: actorId, role: "instructor", createdAt: this.now() }),
    );
    return course;
  }

  enroll(actor: Actor, courseId: string, userId: string, role: Exclude<CourseRole, "system_admin">): Enrollment {
    this.assertManager(actor, courseId);
    const rawRole = this.validateEnrollmentRole(role);
    const enrollment: Enrollment = immutable({
      courseId: requiredText(courseId, "courseId"),
      userId: requiredText(userId, "userId"),
      role: rawRole,
      createdAt: this.now(),
    });
    this.repository.saveEnrollment(enrollment);
    return enrollment;
  }

  createAssessment(actor: Actor, courseId: string, input: CreateAssessmentInput): {
    assessment: Assessment;
    draft: AssessmentVersion;
  } {
    const actorId = this.assertManager(actor, courseId);
    const course = this.requireCourse(courseId);
    const normalized = this.normalizeAssessmentInput(input, actorId);
    const timestamp = this.now();
    const assessment: Assessment = immutable({
      id: this.id(),
      courseId: course.id,
      title: normalized.title,
      createdBy: actorId,
      createdAt: timestamp,
      currentPublishedVersionId: null,
    });
    const draft = this.buildVersion({
      assessment,
      versionNumber: 1,
      status: "draft",
      createdBy: actorId,
      createdAt: timestamp,
      ...normalized,
    });
    this.repository.saveAssessment(assessment);
    this.repository.saveVersion(draft);
    return { assessment, draft };
  }

  /** Creates a new draft from a published snapshot without altering that snapshot. */
  createDraftVersion(actor: Actor, assessmentId: string): AssessmentVersion {
    const { assessment, actorId } = this.requireManagedAssessment(actor, assessmentId);
    const publishedVersionId = assessment.currentPublishedVersionId;
    if (!publishedVersionId) throw conflict("Publish the first version before creating another draft.");
    const published = this.requireVersion(publishedVersionId);
    const nextVersionNumber = Math.max(...this.repository.listVersions(assessment.id).map((item) => item.versionNumber)) + 1;
    const draft = this.buildVersion({
      assessment,
      versionNumber: nextVersionNumber,
      status: "draft",
      title: published.title,
      assignmentInstructions: published.assignmentInstructions,
      objectives: published.objectives.map((objective) => ({
        label: objective.label,
        description: objective.description,
        evidenceCriteria: objective.evidenceCriteria,
        assessableInCheckIn: objective.assessableInCheckIn,
      })),
      rubric: published.rubric,
      policy: published.policy,
      accommodations: published.accommodations,
      questionBudget: published.questionBudget,
      timeBudgetMinutes: published.timeBudgetMinutes,
      createdBy: actorId,
      createdAt: this.now(),
    });
    this.repository.saveVersion(draft);
    return draft;
  }

  updateDraft(actor: Actor, versionId: string, input: UpdateDraftInput): AssessmentVersion {
    const draft = this.requireVersion(versionId);
    const actorId = this.assertManager(actor, draft.courseId);
    this.assertDraft(draft);
    const raw = allowedKeys(input, "draft", [
      "title",
      "assignmentInstructions",
      "objectives",
      "rubric",
      "policy",
      "accommodations",
      "questionBudget",
      "timeBudgetMinutes",
    ]);
    if (Object.keys(raw).length === 0) throw badRequest("Provide at least one draft field to update.");

    const updated = this.buildVersion({
      assessment: this.requireAssessment(draft.assessmentId),
      versionNumber: draft.versionNumber,
      status: "draft",
      title: optionalText(raw.title, "draft.title") ?? draft.title,
      assignmentInstructions:
        optionalText(raw.assignmentInstructions, "draft.assignmentInstructions") ?? draft.assignmentInstructions,
      objectives:
        raw.objectives === undefined
          ? draft.objectives.map((objective) => ({
              label: objective.label,
              description: objective.description,
              evidenceCriteria: objective.evidenceCriteria,
              assessableInCheckIn: objective.assessableInCheckIn,
            }))
          : this.normalizeObjectives(raw.objectives, actorId),
      rubric: raw.rubric === undefined ? draft.rubric : this.normalizeRubric(raw.rubric),
      policy: raw.policy === undefined ? draft.policy : this.normalizePolicy(raw.policy),
      accommodations:
        raw.accommodations === undefined
          ? draft.accommodations
          : this.normalizeAccommodations(raw.accommodations),
      questionBudget:
        raw.questionBudget === undefined
          ? draft.questionBudget
          : wholeNumberInRange(raw.questionBudget, "draft.questionBudget", 3, 5),
      timeBudgetMinutes:
        raw.timeBudgetMinutes === undefined
          ? draft.timeBudgetMinutes
          : wholeNumberInRange(raw.timeBudgetMinutes, "draft.timeBudgetMinutes", 3, 8),
      createdBy: draft.createdBy,
      createdAt: draft.createdAt,
      id: draft.id,
    });
    this.repository.saveVersion(updated);
    return updated;
  }

  publishVersion(actor: Actor, versionId: string): AssessmentVersion {
    const draft = this.requireVersion(versionId);
    const actorId = this.assertManager(actor, draft.courseId);
    this.assertDraft(draft);
    this.validatePublishable(draft);
    const published: AssessmentVersion = immutable({
      ...draft,
      status: "published",
      publishedBy: actorId,
      publishedAt: this.now(),
    });
    this.assertSharedVersionContract(published);
    const assessment = this.requireAssessment(draft.assessmentId);
    this.repository.saveVersion(published);
    this.repository.saveAssessment(
      immutable({ ...assessment, title: published.title, currentPublishedVersionId: published.id }),
    );
    return published;
  }

  /** Authoring views include drafts and are limited to instructors/course admins. */
  getVersionForAuthoring(actor: Actor, versionId: string): AssessmentVersion {
    const version = this.requireVersion(versionId);
    this.assertManager(actor, version.courseId);
    return version;
  }

  /** Learners/TAs can read only the currently published version of their own course. */
  getPublishedVersion(actor: Actor, assessmentId: string): AssessmentVersion {
    const assessment = this.requireAssessment(assessmentId);
    this.assertCourseMember(actor, assessment.courseId);
    if (!assessment.currentPublishedVersionId) throw notFound("This assessment is not published.");
    return this.requireVersion(assessment.currentPublishedVersionId);
  }

  private buildVersion(input: {
    assessment: Assessment;
    versionNumber: number;
    status: AssessmentVersionStatus;
    title: string;
    assignmentInstructions: string;
    objectives: readonly ObjectiveInput[] | readonly Objective[];
    rubric: Rubric;
    policy: AssessmentPolicy;
    accommodations: AccommodationOptions;
    questionBudget: number;
    timeBudgetMinutes: number;
    createdBy: string;
    createdAt: string;
    id?: string;
  }): AssessmentVersion {
    const version: AssessmentVersion = {
      id: input.id ?? this.id(),
      assessmentId: input.assessment.id,
      courseId: input.assessment.courseId,
      versionNumber: input.versionNumber,
      status: input.status,
      title: requiredText(input.title, "assessment.title"),
      assignmentInstructions: requiredText(input.assignmentInstructions, "assessment.assignmentInstructions"),
      objectives: this.normalizeObjectives(this.toObjectiveInputs(input.objectives), input.createdBy),
      rubric: this.normalizeRubric(this.toRubricInput(input.rubric)),
      policy: this.normalizePolicy(input.policy),
      accommodations: this.normalizeAccommodations(input.accommodations),
      questionBudget: wholeNumberInRange(input.questionBudget, "assessment.questionBudget", 3, 5),
      timeBudgetMinutes: wholeNumberInRange(input.timeBudgetMinutes, "assessment.timeBudgetMinutes", 3, 8),
      createdBy: input.createdBy,
      createdAt: input.createdAt,
      publishedBy: null,
      publishedAt: null,
    };
    this.assertSharedVersionContract(version);
    return immutable(version);
  }

  private normalizeAssessmentInput(input: CreateAssessmentInput, actorId: string) {
    const raw = allowedKeys(input, "assessment", [
      "title",
      "assignmentInstructions",
      "objectives",
      "rubric",
      "policy",
      "accommodations",
      "questionBudget",
      "timeBudgetMinutes",
    ]);
    return {
      title: requiredText(raw.title, "assessment.title"),
      assignmentInstructions: requiredText(raw.assignmentInstructions, "assessment.assignmentInstructions"),
      objectives: this.normalizeObjectives(raw.objectives, actorId),
      rubric: this.normalizeRubric(raw.rubric),
      policy: this.normalizePolicy(raw.policy),
      accommodations: this.normalizeAccommodations(raw.accommodations),
      questionBudget: wholeNumberInRange(raw.questionBudget, "assessment.questionBudget", 3, 5),
      timeBudgetMinutes: wholeNumberInRange(raw.timeBudgetMinutes, "assessment.timeBudgetMinutes", 3, 8),
    };
  }

  private toObjectiveInputs(value: readonly ObjectiveInput[] | readonly Objective[]): readonly ObjectiveInput[] {
    return value.map((objective) => ({
      label: objective.label,
      description: objective.description,
      evidenceCriteria: objective.evidenceCriteria,
      assessableInCheckIn: objective.assessableInCheckIn,
    }));
  }

  private toRubricInput(rubric: Rubric): { criteria: readonly { label: string; description: string; evidenceCriteria: string }[] } {
    return {
      criteria: rubric.criteria.map((criterion) => ({
        label: criterion.label,
        description: criterion.description,
        evidenceCriteria: criterion.evidenceCriteria,
      })),
    };
  }

  private normalizeObjectives(value: unknown, approvedBy: string): readonly Objective[] {
    if (!Array.isArray(value) || value.length === 0 || value.length > 10) {
      throw badRequest("assessment.objectives must contain between 1 and 10 objectives.");
    }
    const approvedAt = this.now();
    return value.map((item, index) => {
      const raw = allowedKeys(item, `assessment.objectives[${index}]`, [
        "label",
        "description",
        "evidenceCriteria",
        "assessableInCheckIn",
      ]);
      return immutable({
        id: this.id(),
        label: requiredText(raw.label, `assessment.objectives[${index}].label`),
        description: requiredText(raw.description, `assessment.objectives[${index}].description`),
        evidenceCriteria: requiredText(raw.evidenceCriteria, `assessment.objectives[${index}].evidenceCriteria`),
        assessableInCheckIn: exactBoolean(
          raw.assessableInCheckIn,
          `assessment.objectives[${index}].assessableInCheckIn`,
        ),
        // Objectives enter this bounded authoring API only through an authorized instructor action.
        approvedBy,
        approvedAt,
      });
    });
  }

  private normalizeRubric(value: unknown): Rubric {
    const raw = allowedKeys(value, "assessment.rubric", ["criteria"]);
    if (!Array.isArray(raw.criteria) || raw.criteria.length === 0 || raw.criteria.length > 12) {
      throw badRequest("assessment.rubric.criteria must contain between 1 and 12 criteria.");
    }
    const criteria: RubricCriterion[] = raw.criteria.map((item, index) => {
      const criterion = allowedKeys(item, `assessment.rubric.criteria[${index}]`, [
        "label",
        "description",
        "evidenceCriteria",
      ]);
      return immutable({
        id: this.id(),
        label: requiredText(criterion.label, `assessment.rubric.criteria[${index}].label`),
        description: requiredText(criterion.description, `assessment.rubric.criteria[${index}].description`),
        evidenceCriteria: requiredText(
          criterion.evidenceCriteria,
          `assessment.rubric.criteria[${index}].evidenceCriteria`,
        ),
      });
    });
    return immutable({ criteria });
  }

  private normalizePolicy(value: unknown): AssessmentPolicy {
    const raw = allowedKeys(value, "assessment.policy", [
      "learnerFacingText",
      "aiUsePolicy",
      "privacySummary",
      "completionCriteria",
    ]);
    if (
      raw.aiUsePolicy !== "allowed" &&
      raw.aiUsePolicy !== "allowed_with_disclosure" &&
      raw.aiUsePolicy !== "not_allowed"
    ) {
      throw badRequest("assessment.policy.aiUsePolicy is invalid.");
    }
    return immutable({
      learnerFacingText: requiredText(raw.learnerFacingText, "assessment.policy.learnerFacingText"),
      aiUsePolicy: raw.aiUsePolicy,
      privacySummary: requiredText(raw.privacySummary, "assessment.policy.privacySummary"),
      completionCriteria: requiredText(raw.completionCriteria, "assessment.policy.completionCriteria"),
    });
  }

  private normalizeAccommodations(value: unknown): AccommodationOptions {
    const raw = allowedKeys(value, "assessment.accommodations", [
      "textCheckIn",
      "voiceCheckIn",
      "extraTime",
      "pauseAndResume",
      "alternativeAssessmentRequest",
    ]);
    const accommodations = {
      textCheckIn: exactBoolean(raw.textCheckIn, "assessment.accommodations.textCheckIn"),
      voiceCheckIn: exactBoolean(raw.voiceCheckIn, "assessment.accommodations.voiceCheckIn"),
      extraTime: exactBoolean(raw.extraTime, "assessment.accommodations.extraTime"),
      pauseAndResume: exactBoolean(raw.pauseAndResume, "assessment.accommodations.pauseAndResume"),
      alternativeAssessmentRequest: exactBoolean(
        raw.alternativeAssessmentRequest,
        "assessment.accommodations.alternativeAssessmentRequest",
      ),
    };
    // Text is the equivalent, canonical route. Voice may be offered only as an opt-in addition.
    if (!accommodations.textCheckIn) {
      throw badRequest("assessment.accommodations.textCheckIn must be enabled as the text fallback.");
    }
    return immutable(accommodations);
  }

  /** Validates the contract-shaped snapshot emitted from F02's authoring model. */
  private assertSharedVersionContract(version: AssessmentVersion): void {
    const accommodationPaths: ("text" | "extended_time" | "human_follow_up")[] = ["text"];
    if (version.accommodations.extraTime) accommodationPaths.push("extended_time");
    if (version.accommodations.alternativeAssessmentRequest) accommodationPaths.push("human_follow_up");

    AssessmentVersionSchema.parse({
      id: version.id,
      assessment_id: version.assessmentId,
      version: version.versionNumber,
      state: version.status,
      policy: {
        policy_text: version.policy.learnerFacingText,
        ai_use_policy: version.policy.aiUsePolicy,
        accommodations: accommodationPaths,
        retention_summary: version.policy.privacySummary,
      },
      objectives: version.objectives.map((objective) => ({
        id: objective.id,
        assessment_version_id: version.id,
        label: objective.label,
        description: objective.description,
        evidence_criteria: [objective.evidenceCriteria],
        assessable_in_check_in: objective.assessableInCheckIn,
      })),
      rubric: version.rubric.criteria.map((criterion) => ({
        id: criterion.id,
        label: criterion.label,
        description: criterion.description,
        objective_ids: version.objectives.map((objective) => objective.id),
      })),
      question_budget: version.questionBudget,
      time_budget_minutes: version.timeBudgetMinutes,
      created_at: version.createdAt,
      published_at: version.publishedAt,
    });
  }

  private validatePublishable(version: AssessmentVersion): void {
    const assessable = version.objectives.filter((objective) => objective.assessableInCheckIn);
    if (assessable.length < 3 || assessable.length > 5) {
      throw badRequest("A published assessment needs 3 to 5 assessable, instructor-approved objectives.");
    }
    if (assessable.some((objective) => !objective.approvedBy || !objective.approvedAt)) {
      throw badRequest("Every assessable objective must be instructor-approved before publishing.");
    }
  }

  private requireManagedAssessment(actor: Actor, assessmentId: string): { assessment: Assessment; actorId: string } {
    const assessment = this.requireAssessment(assessmentId);
    return { assessment, actorId: this.assertManager(actor, assessment.courseId) };
  }

  private requireCourse(courseId: string): Course {
    return this.repository.getCourse(requiredText(courseId, "courseId")) ?? notFound("Course not found.");
  }

  private requireAssessment(assessmentId: string): Assessment {
    return this.repository.getAssessment(requiredText(assessmentId, "assessmentId")) ?? notFound("Assessment not found.");
  }

  private requireVersion(versionId: string): AssessmentVersion {
    return this.repository.getVersion(requiredText(versionId, "versionId")) ?? notFound("Assessment version not found.");
  }

  private assertManager(actor: Actor, courseId: string): string {
    const actorId = this.actorId(actor);
    this.requireCourse(courseId);
    if (actor.role === "system_admin") return actorId;
    const enrollment = this.repository.getEnrollment(courseId, actorId);
    if (!enrollment || (enrollment.role !== "instructor" && enrollment.role !== "course_admin")) {
      throw forbidden();
    }
    return actorId;
  }

  private assertCourseMember(actor: Actor, courseId: string): string {
    const actorId = this.actorId(actor);
    this.requireCourse(courseId);
    if (actor.role === "system_admin" || this.repository.getEnrollment(courseId, actorId)) return actorId;
    throw forbidden();
  }

  private assertDraft(version: AssessmentVersion): void {
    if (version.status !== "draft") throw conflict("Published assessment versions are immutable.");
  }

  private actorId(actor: Actor): string {
    return requiredText(actor?.userId, "authenticated actor.userId");
  }

  private validateEnrollmentRole(role: unknown): Exclude<CourseRole, "system_admin"> {
    if (role === "learner" || role === "instructor" || role === "teaching_assistant" || role === "course_admin") {
      return role;
    }
    throw badRequest("Enrollment role is invalid.");
  }
}
