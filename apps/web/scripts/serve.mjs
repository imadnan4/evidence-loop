import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

const appRoot = resolve(import.meta.dirname, "..");
const uiRoot = resolve(appRoot, "../../packages/ui/src");
const port = Number(process.env.PORT || 3000);
const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

function safePath(root, relativePath) {
  const candidate = resolve(root, relativePath.replace(/^\/+/, ""));
  return candidate === root || candidate.startsWith(`${root}${sep}`) ? candidate : null;
}

function routeFile(pathname) {
  if (pathname === "/") return resolve(appRoot, "index.html");
  if (pathname === "/instructor" || pathname === "/instructor/") return resolve(appRoot, "instructor/index.html");
  if (pathname === "/learner" || pathname === "/learner/") return resolve(appRoot, "learner/index.html");
  if (pathname.startsWith("/assets/")) return safePath(appRoot, pathname);
  if (pathname.startsWith("/ui/")) return safePath(uiRoot, pathname.slice("/ui/".length));
  return null;
}

createServer(async (request, response) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" });
    response.end("Method not allowed");
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url, `http://${request.headers.host || "localhost"}`).pathname);
  } catch {
    response.writeHead(400);
    response.end("Bad request");
    return;
  }

  const file = routeFile(pathname);
  if (!file) {
    response.writeHead(404);
    response.end("Not found");
    return;
  }

  try {
    const fileStats = await stat(file);
    if (!fileStats.isFile()) throw new Error("Not a file");
    const headers = { "Content-Type": contentTypes[extname(file)] || "application/octet-stream", "X-Content-Type-Options": "nosniff" };
    response.writeHead(200, headers);
    if (request.method === "HEAD") return response.end();
    response.end(await readFile(file));
  } catch {
    response.writeHead(404);
    response.end("Not found");
  }
}).listen(port, () => {
  console.log(`Evidence Loop shell is available at http://localhost:${port}`);
});
