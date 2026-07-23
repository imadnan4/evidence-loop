export class AssessmentHttpError extends Error {
  readonly statusCode: number;
  readonly code: string;
  constructor(statusCode: number, code: string, message: string) { super(message); this.statusCode = statusCode; this.code = code; }
}
export class ValidationError extends AssessmentHttpError {
  constructor(message: string) { super(400, "validation", message); }
}
