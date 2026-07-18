import { execFileSync } from "node:child_process";

try {
  execFileSync("git", ["diff", "--check", "HEAD"], { stdio: "inherit" });
  console.log("Whitespace check passed.");
} catch {
  process.exitCode = 1;
}
