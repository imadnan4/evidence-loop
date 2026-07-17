import { createHash } from "node:crypto";
import { ARTIFACT_POLICY, ArtifactPolicyError } from "./policy.js";
import { sha256 } from "./storage.js";

export class ParserSandbox {
  async normalize(_input) { throw new Error("Not implemented"); }
}

/**
 * Deterministic, data-only parser for text, Python, notebook, and CSV uploads.
 * It never invokes a shell, interpreter, notebook kernel, browser, or parser
 * plugin from the upload. PDF extraction is delegated to an injected isolated
 * page-text service because PDF parsing must not run in the API process.
 */
export class MvpParserSandbox extends ParserSandbox {
  #pdfPageExtractor;

  constructor({ pdfPageExtractor } = {}) {
    super();
    this.#pdfPageExtractor = pdfPageExtractor;
  }

  async normalize({ artifact, bytes }) {
    if (!Buffer.isBuffer(bytes)) throw new ArtifactPolicyError("Parser received invalid bytes.", "parser_input_invalid");
    switch (artifact.extension) {
      case ".txt":
      case ".py":
        return textFragments(artifact, decodeUtf8(bytes));
      case ".csv":
        return csvFragments(artifact, decodeUtf8(bytes));
      case ".ipynb":
        return notebookFragments(artifact, decodeUtf8(bytes));
      case ".pdf":
        return this.#normalizePdf(artifact, bytes);
      default:
        throw new ArtifactPolicyError("No parser is available for this file type.", "parser_unavailable");
    }
  }

  async #normalizePdf(artifact, bytes) {
    if (!this.#pdfPageExtractor || typeof this.#pdfPageExtractor.extractPages !== "function") {
      throw new ArtifactPolicyError("PDF processing is temporarily unavailable. Submit text or request an alternative route.", "pdf_parser_unavailable");
    }
    // The adapter must be a separately sandboxed service: it receives bytes as
    // data only and returns plain page text, never executable output.
    const pages = await this.#pdfPageExtractor.extractPages({ bytes: Buffer.from(bytes), artifactId: artifact.id });
    if (!Array.isArray(pages) || pages.length === 0 || !pages.every((page) => typeof page === "string")) {
      throw new ArtifactPolicyError("The PDF could not be converted into readable pages.", "pdf_parse_failed");
    }
    return ensureFragmentLimit(pages.map((page, index) => fragment(artifact, {
      kind: "page",
      locator: `page:${index + 1}`,
      pageStart: index + 1,
      pageEnd: index + 1,
      content: page,
    })));
  }
}

function decodeUtf8(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
  } catch {
    throw new ArtifactPolicyError("Text uploads must use UTF-8 encoding.", "invalid_text_encoding");
  }
}

function textFragments(artifact, text) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  return groupRecords(artifact, lines.map((content, index) => ({ content, lineStart: index + 1, lineEnd: index + 1 })), ARTIFACT_POLICY.textLinesPerFragment, "line");
}

function csvFragments(artifact, text) {
  const rows = parseCsvRecords(text);
  return groupRecords(artifact, rows, ARTIFACT_POLICY.csvRowsPerFragment, "csv_row");
}

function groupRecords(artifact, records, perFragment, kind) {
  const fragments = [];
  for (let i = 0; i < records.length; i += perFragment) {
    const group = records.slice(i, i + perFragment);
    const lineStart = group[0]?.lineStart ?? 1;
    const lineEnd = group.at(-1)?.lineEnd ?? lineStart;
    fragments.push(fragment(artifact, {
      kind,
      locator: `lines:${lineStart}-${lineEnd}`,
      lineStart,
      lineEnd,
      content: group.map((record) => record.content).join("\n"),
    }));
  }
  return ensureFragmentLimit(fragments);
}

function notebookFragments(artifact, text) {
  let notebook;
  try {
    notebook = JSON.parse(text);
  } catch {
    throw new ArtifactPolicyError("The notebook is not valid JSON.", "invalid_notebook");
  }
  if (!notebook || !Array.isArray(notebook.cells)) {
    throw new ArtifactPolicyError("The notebook has no cells to cite.", "invalid_notebook");
  }
  if (notebook.cells.length > ARTIFACT_POLICY.maxNotebookCells) {
    throw new ArtifactPolicyError("The notebook has too many cells for this assessment.", "notebook_too_large");
  }

  return ensureFragmentLimit(notebook.cells.map((cell, index) => {
    if (!cell || !["code", "markdown", "raw"].includes(cell.cell_type)) {
      throw new ArtifactPolicyError("The notebook contains an unsupported cell type.", "unsupported_notebook_cell");
    }
    const content = cellSource(cell.source);
    // An absent Jupyter cell id gets a deterministic content-and-position ID;
    // it is stable for this immutable original and never executes cell output.
    const cellId = typeof cell.id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(cell.id)
      ? cell.id
      : `cell-${index + 1}-${shortHash(`${index}\0${content}`)}`;
    return fragment(artifact, {
      kind: "notebook_cell",
      locator: `cell:${cellId}`,
      cellId,
      cellType: cell.cell_type,
      content,
    });
  }));
}

function cellSource(source) {
  if (typeof source === "string") return source;
  if (Array.isArray(source) && source.every((part) => typeof part === "string")) return source.join("");
  throw new ArtifactPolicyError("A notebook cell has invalid source content.", "invalid_notebook_cell");
}

/** @param {string} text */
function parseCsvRecords(text) {
  const rows = [];
  let field = "";
  let row = [];
  let raw = "";
  let quoted = false;
  let line = 1;
  let rowStart = 1;

  const endRow = () => {
    row.push(field);
    rows.push({ content: raw, lineStart: rowStart, lineEnd: line });
    field = ""; row = []; raw = ""; rowStart = line + 1;
  };

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '"') {
      raw += char;
      if (quoted && text[i + 1] === '"') { field += '"'; raw += text[++i]; }
      else quoted = !quoted;
    } else if (char === "," && !quoted) {
      field += char; raw += char; row.push(field); field = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && text[i + 1] === "\n") i += 1;
      endRow(); line += 1;
    } else {
      field += char; raw += char;
      if (char === "\n") line += 1;
    }
  }
  if (quoted) throw new ArtifactPolicyError("The CSV has an unclosed quoted field.", "invalid_csv");
  if (raw || field || row.length) endRow();
  return rows;
}

function fragment(artifact, details) {
  const contentHash = sha256(Buffer.from(details.content, "utf8"));
  const id = `fragment_${shortHash(`${artifact.id}\0${details.locator}\0${contentHash}`)}`;
  return Object.freeze({
    id,
    artifactId: artifact.id,
    ...details,
    contentHash,
  });
}

function shortHash(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function ensureFragmentLimit(fragments) {
  if (fragments.length > ARTIFACT_POLICY.maxFragmentsPerArtifact) {
    throw new ArtifactPolicyError("The artifact produces too many citation fragments.", "too_many_fragments");
  }
  return Object.freeze(fragments);
}
