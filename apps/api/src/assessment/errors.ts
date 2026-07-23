export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

export const badRequest = (message: string) => new ApiError("INVALID_REQUEST", message, 400);
export const forbidden = (message = "You are not authorized to access this course resource.") =>
  new ApiError("FORBIDDEN", message, 403);
export const notFound = (message = "The requested resource was not found.") =>
  new ApiError("NOT_FOUND", message, 404);
export const conflict = (message: string) => new ApiError("CONFLICT", message, 409);
