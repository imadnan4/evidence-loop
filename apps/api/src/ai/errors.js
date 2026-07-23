export class AiValidationError extends Error {
  constructor(message, code = "ai_output_invalid") {
    super(message);
    this.name = "AiValidationError";
    this.code = code;
  }
}

export class AiConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "AiConfigurationError";
  }
}

export class AiModelError extends Error {
  constructor(message, code = "model_request_failed") {
    super(message);
    this.name = "AiModelError";
    this.code = code;
  }
}
