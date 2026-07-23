import type { Sql, TransactionSql } from "postgres";
import type { ResolvedTextCheckInContext, TrustedSessionResolver } from "./types.ts";

type SubmissionRow = {
  id: string;
  organization_id: string;
  course_id: string;
  assessment_id: string;
  assessment_version_id: string;
  learner_id: string;
  state: string;
};

type VersionRow = {
  id: string;
  course_id: string;
  state: "published";
  learner_facing_text: string;
  ai_use_policy: "allowed" | "allowed_with_disclosure" | "not_allowed";
  privacy_summary: string;
  completion_criteria: string;
  text_check_in: boolean;
  voice_check_in: boolean;
  extra_time: boolean;
  pause_and_resume: boolean;
  question_budget: number;
  time_budget_minutes: number;
};

type ObjectiveRow = {
  id: string;
  label: string;
  assessable_in_check_in: boolean;
  approved_by: string;
  approved_at: Date;
};

type FragmentRow = {
  id: string;
  submission_id: string;
  locator: { kind: string; [key: string]: unknown };
};

/**
 * Server-resolved, published check-in context. It joins the learner's
 * submission, its published assessment version, the assessable objectives, and
 * the current-submission artifact fragments, and never trusts any value from a
 * learner request. The returned context is validated by
 * `TextCheckInSessionService.normalizeResolvedContext`.
 */
export class DurableTrustedSessionResolver implements TrustedSessionResolver {
  private readonly _client: Sql<{}>;
  private tx: TransactionSql | null = null;

  constructor(client: Sql<{}>) {
    this._client = client;
  }

  /** Binds the resolver to the caller's open tenant transaction so reads run on
   * the same connection and inherit the transaction-local organization GUC. */
  bind(transaction: TransactionSql | null): void {
    this.tx = transaction;
  }

  private get client(): TransactionSql {
    const bound = this.tx;
    if (!bound) throw new Error("DurableTrustedSessionResolver used outside a tenant transaction.");
    return bound;
  }

  async resolveForLearner(actorId: string, submissionId: string): Promise<ResolvedTextCheckInContext | undefined> {
    // The actor identity and organization come from the caller's open tenant
    // transaction (GUCs). We read on the bound connection so RLS uses the
    // correct organization and the submission/version/objective/fragment joins
    // stay consistent within the same snapshot.
    const submission = await this.loadSubmission(submissionId);
    if (!submission) return undefined;
    const version = await this.loadVersion(submission.assessment_version_id);
    if (!version) return undefined;
    const objectives = await this.loadObjectives(submission.assessment_version_id);
    const fragments = await this.loadFragments(submission.id);

    const objectiveFragmentIds = objectives
      .filter((objective) => objective.assessable_in_check_in)
      .map((objective) => ({
        objectiveId: objective.id,
        fragmentIds: fragments.map((fragment) => fragment.id),
      }));

    return {
      submissionId: submission.id,
      learnerId: submission.learner_id,
      submissionCourseId: submission.course_id,
      assessmentCourseId: version.course_id,
      submissionState: "ready",
      assessmentVersionId: submission.assessment_version_id,
      assessmentVersionState: version.state,
      policyVersionId: submission.assessment_version_id,
      policy: {
        learnerFacingText: version.learner_facing_text,
        aiUsePolicy: version.ai_use_policy,
        privacySummary: version.privacy_summary,
        completionCriteria: version.completion_criteria,
      },
      questionBudget: version.question_budget,
      timeBudgetMinutes: version.time_budget_minutes,
      pauseAndResume: version.pause_and_resume,
      voiceCheckInEnabled: version.voice_check_in,
      objectives: objectives.map((objective) => ({
        id: objective.id,
        label: objective.label,
        assessableInCheckIn: objective.assessable_in_check_in,
        approvedBy: objective.approved_by,
        approvedAt: objective.approved_at.toISOString(),
      })),
      objectiveFragmentIds,
      fragments: fragments.map((fragment) => ({
        id: fragment.id,
        submissionId: fragment.submission_id,
        locator: JSON.stringify(fragment.locator),
      })),
    };
  }

  private async loadSubmission(submissionId: string): Promise<SubmissionRow | undefined> {
    const rows = await this.client<SubmissionRow[]>`
      SELECT id, organization_id, course_id, assessment_id, assessment_version_id, learner_id, state
      FROM submissions WHERE id = ${submissionId} AND state = 'ready'`;
    return rows[0];
  }

  private async loadVersion(versionId: string): Promise<VersionRow | undefined> {
    const rows = await this.client<VersionRow[]>`
      SELECT id, course_id, state, learner_facing_text, ai_use_policy, privacy_summary, completion_criteria,
        text_check_in, voice_check_in, extra_time, pause_and_resume, question_budget, time_budget_minutes
      FROM assessment_versions WHERE id = ${versionId} AND state = 'published'`;
    return rows[0];
  }

  private async loadObjectives(versionId: string): Promise<ObjectiveRow[]> {
    return this.client<ObjectiveRow[]>`
      SELECT id, label, assessable_in_check_in, approved_by, approved_at
      FROM assessment_objectives WHERE assessment_version_id = ${versionId} ORDER BY position`;
  }

  private async loadFragments(submissionId: string): Promise<FragmentRow[]> {
    return this.client<FragmentRow[]>`
      SELECT id, submission_id, locator FROM artifact_fragments WHERE submission_id = ${submissionId} ORDER BY ordinal`;
  }
}
