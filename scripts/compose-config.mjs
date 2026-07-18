import { spawn } from "node:child_process";

const child = spawn("docker", ["compose", "--env-file", "infra/env/.env.example", "config", "--quiet"], {
  stdio: "inherit",
  env: {
    ...process.env,
    EVIDENCE_LOOP_ENV_FILE: "infra/env/.env.example",
    EVIDENCE_LOOP_RUNTIME_ENV_FILE: "infra/env/.env.runtime.example",
  },
});
child.once("error", (error) => {
  console.error(`Compose configuration could not start: ${error.code ?? "unknown-error"}`);
  process.exitCode = 1;
});
child.once("exit", (code) => { process.exitCode = code ?? 1; });
