import { spawn } from "node:child_process";

const commands = [
  ["pnpm", ["--filter", "@evidence-loop/contracts", "check"]],
  ["pnpm", ["--filter", "@evidence-loop/config", "check"]],
  ["pnpm", ["--filter", "@evidence-loop/db", "check"]],
  ["pnpm", ["--filter", "@evidence-loop/artifact-pipeline", "check"]],
  ["pnpm", ["--filter", "@evidence-loop/api", "check"]],
  ["pnpm", ["--filter", "@evidence-loop/worker", "check"]],
  ["pnpm", ["--filter", "@evidence-loop/web-shell", "check"]],
  ["pnpm", ["--filter", "@evidence-loop/ui", "check"]],
  [process.execPath, ["scripts/release-smoke.mjs"]],
];

for (const [command, args] of commands) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code}`)));
  });
}

console.log("Workspace checks passed, including database package unit checks and apps/api/tests/session-state-machine.test.ts.");
