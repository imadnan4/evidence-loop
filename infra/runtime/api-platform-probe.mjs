import { createServer } from "node:http";
import { checkDependencies } from "./readiness.mjs";

const port = Number(process.env.PLATFORM_PORT ?? "3001");

createServer(async (request, response) => {
  const path = new URL(request.url ?? "/", "http://probe.local").pathname;
  if (request.method !== "GET") {
    response.writeHead(405, { Allow: "GET" });
    response.end();
    return;
  }
  if (path === "/health/live") {
    response.writeHead(200, { "cache-control": "no-store", "content-type": "application/json" });
    response.end('{"status":"live"}');
    return;
  }
  if (path === "/health/ready") {
    try {
      await checkDependencies();
      response.writeHead(200, { "cache-control": "no-store", "content-type": "application/json" });
      response.end('{"status":"ready"}');
    } catch {
      response.writeHead(503, { "cache-control": "no-store", "content-type": "application/json" });
      response.end('{"status":"unavailable"}');
    }
    return;
  }
  response.writeHead(404, { "content-type": "application/json" });
  response.end('{"error":"not_found"}');
}).listen(port, "0.0.0.0", () => console.log("platform-api-probe: listening"));
