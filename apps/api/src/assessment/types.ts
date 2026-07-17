import type { AiUsePolicy } from "@evidence-loop/contracts/v1";

/**
 * F02 course authorization and mutable authoring state. Shared wire/domain
 * invariants are validated against the F00 v1 contracts at service boundaries.
 * These types deliberately contain no grade, score, misconduct, behavioral,
 * or voice-derived fields.
 */
export const COURSE_ROLES = [
  "learner",
  "instructor",
  "teaching_assistant",
  "course_admin",
  "system_admin",
] as const;

export type CourseRole = (typeof COURSE_ROLES)[number];
export type Actor = Readonly<{ userId: string; role?: CourseRole }>;

export type Course = Readonly<{
  id: string;
  organizationId: string;
  title: string;
  term: string;
  createdBy: string;
  createdAt: string;
}>;

export type Enrollment = Readonly<{
  courseId: string;
  userId: string;
  role: Exclude<CourseRole, "system_admin">;
  createdAt: string;
}>;

export type AssessmentPolicy = Readonly<{
  learnerFacingText: string;
  aiUsePolicy: AiUsePolicy;
  privacySummary: string;
  completionCriteria: string;
}>;

export type AccommodationOptions = Readonly<{
  textCheckIn: boolean;
  voiceCheckIn: boolean;
  extraTime: boolean;
  pauseAndResume: boolean;
  alternativeAssessmentRequest: boolean;
}>;

export type RubricCriterion = Readonly<{
  id: string;
  label: string;
  description: string;
  evidenceCriteria: string;
}>;

export type Rubric = Readonly<{ criteria: readonly RubricCriterion[] }>;

export type Objective = Readonly<{
  id: string;
  label: string;
  description: string;
  evidenceCriteria: string;
  assessableInCheckIn: boolean;
  approvedBy: string;
  approvedAt: string;
}>;

export type Assessment = Readonly<{
  id: string;
  courseId: string;
  title: string;
  createdBy: string;
  createdAt: string;
  currentPublishedVersionId: string | null;
}>;

export type AssessmentVersionStatus = "draft" | "published";

export type AssessmentVersion = Readonly<{
  id: string;
  assessmentId: string;
  courseId: string;
  versionNumber: number;
  status: AssessmentVersionStatus;
  title: string;
  assignmentInstructions: string;
  objectives: readonly Objective[];
  rubric: Rubric;
  policy: AssessmentPolicy;
  accommodations: AccommodationOptions;
  questionBudget: number;
  timeBudgetMinutes: number;
  createdBy: string;
  createdAt: string;
  publishedBy: string | null;
  publishedAt: string | null;
}>;

export type CreateCourseInput = Readonly<{
  organizationId: string;
  title: string;
  term: string;
}>;

export type CreateAssessmentInput = Readonly<{
  title: string;
  assignmentInstructions: string;
  objectives: readonly ObjectiveInput[];
  rubric: RubricInput;
  policy: AssessmentPolicyInput;
  accommodations: AccommodationOptionsInput;
  questionBudget: number;
  timeBudgetMinutes: number;
}>;

export type ObjectiveInput = Readonly<{
  label: string;
  description: string;
  evidenceCriteria: string;
  assessableInCheckIn: boolean;
}>;

export type RubricInput = Readonly<{
  criteria: readonly RubricCriterionInput[];
}>;

export type RubricCriterionInput = Readonly<{
  label: string;
  description: string;
  evidenceCriteria: string;
}>;

export type AssessmentPolicyInput = Readonly<{
  learnerFacingText: string;
  aiUsePolicy: AiUsePolicy;
  privacySummary: string;
  completionCriteria: string;
}>;

export type AccommodationOptionsInput = AccommodationOptions;

export type UpdateDraftInput = Readonly<{
  title?: string;
  assignmentInstructions?: string;
  objectives?: readonly ObjectiveInput[];
  rubric?: RubricInput;
  policy?: AssessmentPolicyInput;
  accommodations?: AccommodationOptionsInput;
  questionBudget?: number;
  timeBudgetMinutes?: number;
}>;

export interface AssessmentRepository {
  saveCourse(course: Course): void;
  getCourse(courseId: string): Course | undefined;
  saveEnrollment(enrollment: Enrollment): void;
  getEnrollment(courseId: string, userId: string): Enrollment | undefined;
  saveAssessment(assessment: Assessment): void;
  getAssessment(assessmentId: string): Assessment | undefined;
  saveVersion(version: AssessmentVersion): void;
  getVersion(versionId: string): AssessmentVersion | undefined;
  listVersions(assessmentId: string): readonly AssessmentVersion[];
}
