import path from "node:path";

/**
 * Artifact ingestion policy. These limits are intentionally small for the MVP;
 * callers should expose the limits and an alternative assessment route before
 * asking a learner to upload work.
 */
export const ARTIFACT_POLICY = Object.freeze({
  maxBytes: 10 * 1024 * 1024,
  maxArtifactsPerSubmission: 5,
  maxTextBytes: 2 * 1024 * 1024,
  maxPdfBytes: 10 * 1024 * 1024,
  maxNotebookCells: 1_000,
  maxFragmentsPerArtifact: 2_000,
  uploadIntentTtlMs: 15 * 60 * 1_000,
  textLinesPerFragment: 80,
  csvRowsPerFragment: 100,
});

const TYPES_BY_EXTENSION = Object.freeze({
  ".pdf": ["application/pdf"],
  ".txt": ["text/plain"],
  ".py": ["text/plain", "text/x-python", "application/x-python-code"],
  ".ipynb": ["application/x-ipynb+json", "application/json"],
  ".csv": ["text/csv", "application/csv", "text/plain"],
});

export const ACCEPTED_ARTIFACT_TYPES = Object.freeze(
  Object.entries(TYPES_BY_EXTENSION).map(([extension, contentTypes]) =>
    Object.freeze({ extension, contentTypes: Object.freeze(contentTypes) }),
  ),
);

export class ArtifactPolicyError extends Error {
  constructor(message, code = "artifact_policy_violation") {
    super(message);
    this.name = "ArtifactPolicyError";
    this.code = code;
  }
}

/** @param {{ fileName: string, contentType: string, byteSize: number }} input */
export function validateArtifactMetadata(input) {
  const fileName = String(input.fileName ?? "");
  const contentType = String(input.contentType ?? "").toLowerCase().split(";", 1)[0];
  const byteSize = input.byteSize;
  const extension = path.extname(fileName).toLowerCase();
  const allowedContentTypes = TYPES_BY_EXTENSION[extension];

  if (!fileName || fileName !== path.basename(fileName) || /[\0\r\n]/.test(fileName)) {
    throw new ArtifactPolicyError("Use a simple file name without path characters.", "invalid_file_name");
  }
  if (!allowedContentTypes) {
    throw new ArtifactPolicyError("This file type is not supported. Use PDF, text, Python, notebook, or CSV.", "unsupported_file_type");
  }
  if (!allowedContentTypes.includes(contentType)) {
    throw new ArtifactPolicyError("The file type does not match the selected upload format.", "content_type_mismatch");
  }
  if (!Number.isSafeInteger(byteSize) || byteSize <= 0 || byteSize > ARTIFACT_POLICY.maxBytes) {
    throw new ArtifactPolicyError(`Files must be between 1 byte and ${ARTIFACT_POLICY.maxBytes} bytes.`, "file_size_invalid");
  }
  if ((extension === ".pdf" && byteSize > ARTIFACT_POLICY.maxPdfBytes) ||
      (extension !== ".pdf" && byteSize > ARTIFACT_POLICY.maxTextBytes)) {
    throw new ArtifactPolicyError("This file exceeds the limit for its format.", "format_size_limit");
  }

  return Object.freeze({ fileName, contentType, byteSize, extension });
}

/** @param {Buffer} bytes @param {string} expectedContentType */
export function validateUploadBytes(bytes, expectedContentType) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
    throw new ArtifactPolicyError("The uploaded file was empty.", "empty_upload");
  }

  // This is only a cheap reject check. The scanner and parser remain the
  // authority; content types are never trusted merely because of this check.
  if (expectedContentType === "application/pdf" && !bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
    throw new ArtifactPolicyError("The uploaded file is not a valid PDF header.", "content_signature_mismatch");
  }
  if (expectedContentType !== "application/pdf" && bytes.includes(Buffer.from("\0"))) {
    throw new ArtifactPolicyError("Binary files are not accepted for this artifact format.", "binary_content_rejected");
  }
}
