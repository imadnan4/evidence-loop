import type {
  Assessment,
  AssessmentRepository,
  AssessmentVersion,
  Course,
  Enrollment,
} from "./types.ts";
import { clone, immutable } from "./value.ts";

/**
 * A test/local adapter. A production database adapter must enforce the same
 * course relationship checks at query time; the service never accepts a
 * resource without resolving its course first.
 */
export class InMemoryAssessmentRepository implements AssessmentRepository {
  #courses = new Map<string, Course>();
  #enrollments = new Map<string, Enrollment>();
  #assessments = new Map<string, Assessment>();
  #versions = new Map<string, AssessmentVersion>();

  saveCourse(course: Course): void {
    this.#courses.set(course.id, immutable(course));
  }

  getCourse(courseId: string): Course | undefined {
    const course = this.#courses.get(courseId);
    return course ? immutable(course) : undefined;
  }

  saveEnrollment(enrollment: Enrollment): void {
    this.#enrollments.set(this.enrollmentKey(enrollment.courseId, enrollment.userId), immutable(enrollment));
  }

  getEnrollment(courseId: string, userId: string): Enrollment | undefined {
    const enrollment = this.#enrollments.get(this.enrollmentKey(courseId, userId));
    return enrollment ? immutable(enrollment) : undefined;
  }

  saveAssessment(assessment: Assessment): void {
    this.#assessments.set(assessment.id, immutable(assessment));
  }

  getAssessment(assessmentId: string): Assessment | undefined {
    const assessment = this.#assessments.get(assessmentId);
    return assessment ? immutable(assessment) : undefined;
  }

  saveVersion(version: AssessmentVersion): void {
    this.#versions.set(version.id, immutable(version));
  }

  getVersion(versionId: string): AssessmentVersion | undefined {
    const version = this.#versions.get(versionId);
    return version ? immutable(version) : undefined;
  }

  listVersions(assessmentId: string): readonly AssessmentVersion[] {
    return [...this.#versions.values()]
      .filter((version) => version.assessmentId === assessmentId)
      .sort((left, right) => left.versionNumber - right.versionNumber)
      .map((version) => immutable(clone(version)));
  }

  private enrollmentKey(courseId: string, userId: string): string {
    return `${courseId}:${userId}`;
  }
}
