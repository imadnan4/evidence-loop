import { checkDependencies } from "./readiness.mjs";

try {
  await checkDependencies();
  console.log("platform-worker-probe: dependencies-ready; no jobs are consumed at A01");
} catch {
  console.error("platform-worker-probe: dependency-unavailable");
  process.exit(1);
}

// This is intentionally a liveness process only. A02 supplies the durable outbox
// and B04/C03/D03 supply real job handlers; this process must not drain work.
setInterval(() => {}, 60_000);
