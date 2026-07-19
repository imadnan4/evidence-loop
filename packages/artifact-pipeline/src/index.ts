import { createHash, createHmac, randomBytes } from "node:crypto";
import { Socket } from "node:net";
import { readdir, stat } from "node:fs/promises";

export const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;
const TYPES: Readonly<Record<string, string>> = Object.freeze({ ".txt": "text/plain", ".py": "text/x-python", ".csv": "text/csv", ".ipynb": "application/x-ipynb+json", ".pdf": "application/pdf" });
export type SafeReason = "scanner_unavailable" | "scanner_timeout" | "scanner_error" | "scanner_invalid" | "scanner_stale" | "malware_detected" | "parser_unavailable" | "parser_timeout" | "parser_error" | "upload_mismatch" | "unsupported_type";
export type ScanResult = Readonly<{ verdict: "clean" | "infected" | "blocked"; reason?: SafeReason; version?: string }>;
export function sha256(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
export function capabilityDigest(value: string): string { return sha256(Buffer.from(value, "utf8")); }
export function newCapability(): string { return randomBytes(32).toString("base64url"); }
export function opaqueQuarantineKey(organizationId: string, artifactId: string): string { return `q/${organizationId}/${artifactId}/${randomBytes(18).toString("hex")}`; }
export function validateUploadMetadata(fileName: unknown, contentType: unknown, byteSize: unknown, digest: unknown) {
  if (typeof fileName !== "string" || fileName.length < 1 || fileName.length > 160 || /[\\/\u0000\r\n]/.test(fileName)) throw new Error("invalid_metadata");
  const extension = /\.[A-Za-z0-9]+$/.exec(fileName)?.[0]?.toLowerCase();
  if (!extension || !Object.hasOwn(TYPES, extension) || typeof contentType !== "string" || TYPES[extension] !== contentType || typeof byteSize !== "number" || !Number.isInteger(byteSize) || byteSize < 1 || byteSize > MAX_ARTIFACT_BYTES || typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) throw new Error("invalid_metadata");
  return Object.freeze({ extension, contentType, byteSize, digest });
}
export function validateBytes(extension: string, bytes: Buffer) {
  if (bytes.length > MAX_ARTIFACT_BYTES) throw new Error("upload_mismatch");
  if (extension === ".pdf" && !bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new Error("unsupported_type");
  if (extension !== ".pdf" && bytes.includes(0)) throw new Error("unsupported_type");
  if ([".txt", ".py", ".csv", ".ipynb"].includes(extension)) { try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new Error("unsupported_type"); } }
}
export interface ArtifactStorage { putQuarantine(key: string, bytes: Buffer, contentType: string): Promise<void>; readQuarantine(key: string): Promise<Buffer>; deleteQuarantine(key: string): Promise<void>; putClean(key: string, bytes: Buffer, contentType: string): Promise<void>; putDerived(key: string, bytes: Buffer): Promise<void>; }
type S3Options = Readonly<{ endpoint: URL; region: string; accessKeyId: string; secretAccessKey: string; buckets: { quarantine: string; clean: string; derived: string } }>;
function hmac(key: Buffer | string, text: string): Buffer { return createHmac("sha256", key).update(text).digest(); }
/** Minimal fixed-operation SigV4 adapter. Runtime callers cannot choose bucket/prefix. */
export class PrivateS3Storage implements ArtifactStorage {
  private readonly options: S3Options;
  constructor(options: S3Options) { this.options = options; }
  async putQuarantine(key: string, bytes: Buffer, contentType: string) { if (!key.startsWith("q/")) throw new Error("storage_scope"); await this.request("PUT", this.options.buckets.quarantine, key, bytes, contentType, true); }
  async readQuarantine(key: string) { if (!key.startsWith("q/")) throw new Error("storage_scope"); return this.request("GET", this.options.buckets.quarantine, key); }
  async deleteQuarantine(key: string) { if (!key.startsWith("q/")) throw new Error("storage_scope"); await this.request("DELETE", this.options.buckets.quarantine, key); }
  async putClean(key: string, bytes: Buffer, contentType: string) { if (!key.startsWith("c/")) throw new Error("storage_scope"); await this.request("PUT", this.options.buckets.clean, key, bytes, contentType, true); }
  async putDerived(key: string, bytes: Buffer) { if (!key.startsWith("d/")) throw new Error("storage_scope"); await this.request("PUT", this.options.buckets.derived, key, bytes, "text/plain; charset=utf-8", true); }
  private async request(method: "GET" | "PUT" | "DELETE", bucket: string, key: string, body?: Buffer, contentType?: string, conditional = false): Promise<Buffer> {
    const host = this.options.endpoint.host; const path = `/${bucket}/${key.split("/").map(encodeURIComponent).join("/")}`; const now = new Date(); const amzDate = now.toISOString().replace(/[-:]|\.\d{3}/g, ""); const day = amzDate.slice(0, 8); const payloadHash = sha256(body ?? Buffer.alloc(0));
    const headers: Record<string, string> = { host, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate }; if (contentType) headers["content-type"] = contentType; if (conditional) headers["if-none-match"] = "*";
    const signed = Object.keys(headers).sort(); const canonicalHeaders = signed.map((name) => `${name}:${headers[name]}\n`).join(""); const canonicalRequest = `${method}\n${path}\n\n${canonicalHeaders}\n${signed.join(";")}\n${payloadHash}`; const scope = `${day}/${this.options.region}/s3/aws4_request`; const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256(Buffer.from(canonicalRequest))}`;
    const signingKey = hmac(hmac(hmac(hmac(`AWS4${this.options.secretAccessKey}`, day), this.options.region), "s3"), "aws4_request"); headers.authorization = `AWS4-HMAC-SHA256 Credential=${this.options.accessKeyId}/${scope}, SignedHeaders=${signed.join(";")}, Signature=${hmac(signingKey, stringToSign).toString("hex")}`;
    const response = await fetch(new URL(path, this.options.endpoint), body ? { method, headers, body: new Uint8Array(body) } : { method, headers }); if (response.status === 412 && conditional) throw new Error("storage_exists"); if (response.status === 404) throw new Error("storage_absent"); if (!response.ok) throw new Error("storage_unavailable"); return Buffer.from(await response.arrayBuffer());
  }
}
export class UnavailableScanner { async scan(_bytes: Buffer): Promise<ScanResult> { return { verdict: "blocked", reason: "scanner_unavailable" }; } }
export class UnavailableParser { async parse(): Promise<never> { throw Object.assign(new Error("parser unavailable"), { code: "parser_unavailable" }); } }
/** ClamAV INSTREAM client; it accepts only a local Unix-domain socket, never TCP. */
export type ClamAvScannerOptions = Readonly<{ socketPath: string; signatureDirectory: string; maxSignatureAgeMs?: number; timeoutMs?: number; now?: () => number }>;
/**
 * ClamAV is usable only when a recent local signature database is readable.
 * A socket that says OK with absent/stale signatures is an indeterminate result,
 * not a clean verdict.
 */
export class ClamAvSocketScanner {
  private readonly socketPath: string; private readonly signatureDirectory: string; private readonly maxSignatureAgeMs: number; private readonly timeoutMs: number; private readonly now: () => number;
  constructor(options: ClamAvScannerOptions) {
    this.socketPath = options.socketPath;
    this.signatureDirectory = options.signatureDirectory;
    this.maxSignatureAgeMs = options.maxSignatureAgeMs ?? 86_400_000;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.now = options.now ?? Date.now;
    if (!this.socketPath.startsWith("/") || !this.signatureDirectory.startsWith("/") || !Number.isSafeInteger(this.maxSignatureAgeMs) || this.maxSignatureAgeMs < 60_000 || this.maxSignatureAgeMs > 7 * 86_400_000 || !Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 120_000) throw new Error("invalid ClamAV scanner options");
  }
  private async signaturesFresh(): Promise<boolean> {
    try {
      const files = await readdir(this.signatureDirectory);
      const ages = await Promise.all(files.filter((file) => /\.(cvd|cld)$/i.test(file)).map(async (file) => (await stat(`${this.signatureDirectory}/${file}`)).mtimeMs));
      return ages.length > 0 && Math.max(...ages) >= this.now() - this.maxSignatureAgeMs;
    } catch { return false; }
  }
  async scan(bytes: Buffer): Promise<ScanResult> {
    if (!await this.signaturesFresh()) return { verdict: "blocked", reason: "scanner_stale" };
    return new Promise((resolve) => {
    const socket = new Socket(); let reply = ""; let done = false;
    const timer = setTimeout(() => finish({ verdict: "blocked", reason: "scanner_timeout" }), this.timeoutMs);
    const finish = (result: ScanResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.once("error", () => { clearTimeout(timer); finish({ verdict: "blocked", reason: "scanner_unavailable" }); });
    socket.connect({ path: this.socketPath }, () => {
      socket.write(Buffer.from("zINSTREAM\0"));
      for (let start = 0; start < bytes.length; start += 64 * 1024) { const chunk = bytes.subarray(start, start + 64 * 1024); const n = Buffer.alloc(4); n.writeUInt32BE(chunk.length); socket.write(n); socket.write(chunk); }
      socket.write(Buffer.alloc(4));
    });
    socket.on("data", (data) => { reply += data.toString("utf8"); if (!reply.includes("\0") && !reply.includes("\n")) return; clearTimeout(timer); if (/^[^\r\n\0]+: OK[\r\n\0]*$/.test(reply)) finish({ verdict: "clean" }); else if (/^[^\r\n\0]+: [^\r\n\0]+ FOUND[\r\n\0]*$/.test(reply)) finish({ verdict: "infected", reason: "malware_detected" }); else finish({ verdict: "blocked", reason: "scanner_invalid" }); });
  }); }
}
