import assert from "node:assert/strict";
import { createServer, type Socket } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ClamAvSocketScanner, UnavailableScanner } from "../src/index.ts";

async function socketServer(reply: string | null) {
  const dir = await mkdtemp(join(tmpdir(), "clamd-"));
  const path = join(dir, "clamd.sock");
  const signatureDirectory = join(dir, "signatures");
  await (await import("node:fs/promises")).mkdir(signatureDirectory);
  await writeFile(join(signatureDirectory, "daily.cld"), "synthetic signatures");
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("data", (data) => { if (reply !== null && data.toString("binary").includes("\0\0\0\0")) socket.end(reply); });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return { path, signatureDirectory, close: async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve) => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); } };
}
function scanner(path: string, signatureDirectory: string, options: Partial<ConstructorParameters<typeof ClamAvSocketScanner>[0]> = {}) {
  return new ClamAvSocketScanner({ socketPath: path, signatureDirectory, ...options });
}

test("ClamAV EICAR FOUND remains infected", async () => {
  const fake = await socketServer("stream: Eicar-Signature FOUND\0");
  try { assert.deepEqual(await scanner(fake.path, fake.signatureDirectory).scan(Buffer.from("X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*")), { verdict: "infected", reason: "malware_detected" }); } finally { await fake.close(); }
});
test("scanner unavailable and malformed responses block", async () => {
  assert.equal((await new UnavailableScanner().scan(Buffer.from("x"))).verdict, "blocked");
  const fake = await socketServer("unexpected\0");
  try { assert.equal((await scanner(fake.path, fake.signatureDirectory).scan(Buffer.from("x"))).verdict, "blocked"); } finally { await fake.close(); }
});
test("scanner timeout blocks and closes its socket", async () => {
  const fake = await socketServer(null);
  try { assert.deepEqual(await scanner(fake.path, fake.signatureDirectory, { timeoutMs: 5 }).scan(Buffer.from("x")), { verdict: "blocked", reason: "scanner_timeout" }); } finally { await fake.close(); }
});
test("missing or stale signature data blocks before the scanner socket can clean", async () => {
  const fake = await socketServer("stream: OK\0");
  try {
    assert.deepEqual(await scanner(fake.path, join(fake.signatureDirectory, "missing")).scan(Buffer.from("x")), { verdict: "blocked", reason: "scanner_stale" });
    assert.deepEqual(await scanner(fake.path, fake.signatureDirectory, { now: () => Date.now() + 86_400_001, maxSignatureAgeMs: 86_400_000 }).scan(Buffer.from("x")), { verdict: "blocked", reason: "scanner_stale" });
  } finally { await fake.close(); }
});
