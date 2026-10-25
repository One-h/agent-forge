import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import path from "node:path";
import { fileURLToPath } from "node:url";

const port = Number(process.env.AUTOFIX_COMPANION_PORT || 4734);
const defaultApiOrigin = process.env.AUTOFIX_API_ORIGIN || "http://127.0.0.1:4731";
const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist");
const allowedMethods = "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS";
const excludedResponseHeaders = new Set(["connection", "content-length", "transfer-encoding", "vary"]);
const types = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".svg", "image/svg+xml"],
]);

function cors(request, response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", allowedMethods);
  response.setHeader("Access-Control-Allow-Headers", request.headers["access-control-request-headers"] || "content-type");
  response.setHeader("Access-Control-Max-Age", "600");
  response.setHeader("Vary", "Origin, Access-Control-Request-Headers, Access-Control-Request-Private-Network");
  if (request.headers["access-control-request-private-network"] === "true") {
    response.setHeader("Access-Control-Allow-Private-Network", "true");
  }
}

export function createCompanionServer({ apiOrigin = defaultApiOrigin, root = defaultRoot } = {}) {
  return createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url || "/", `http://127.0.0.1:${port}`);
      cors(request, response);
      if (request.method === "OPTIONS" && requestUrl.pathname.startsWith("/api/")) {
        response.writeHead(204).end();
        return;
      }
      if (requestUrl.pathname === "/health") {
        response.end("ok");
        return;
      }
      if (requestUrl.pathname === "/" || requestUrl.pathname === "/todos") {
        response.writeHead(200, {
          "cache-control": "no-store",
          "content-type": "text/html; charset=utf-8",
        });
        response.end("<!doctype html><html><head><meta charset=\"UTF-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><link rel=\"stylesheet\" href=\"/assets/style.css\"></head><body><div id=\"root\"></div><script type=\"module\" src=\"/assets/embed-main.js\"></script></body></html>");
        return;
      }
      if (requestUrl.pathname.startsWith("/api/")) {
        const upstream = await fetch(`${apiOrigin}${requestUrl.pathname}${requestUrl.search}`, {
          method: request.method,
          headers: Object.fromEntries(Object.entries(request.headers).filter(([name]) => name !== "host")),
          body: request.method === "GET" || request.method === "HEAD" ? undefined : request,
          duplex: request.method === "GET" || request.method === "HEAD" ? undefined : "half",
        });
        response.writeHead(upstream.status, Object.fromEntries([...upstream.headers].filter(([name]) => {
          const normalized = name.toLowerCase();
          return !excludedResponseHeaders.has(normalized) && !normalized.startsWith("access-control-");
        })));
        if (!upstream.body) response.end();
        else Readable.fromWeb(upstream.body).pipe(response);
        return;
      }
      const relative = requestUrl.pathname.replace(/^\/+/, "");
      const file = path.resolve(root, relative);
      if (!file.startsWith(`${root}${path.sep}`) && file !== path.join(root, "index.html")) throw new Error("invalid path");
      const info = await stat(file).catch(() => null);
      if (!info?.isFile()) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { "content-type": types.get(path.extname(file)) || "application/octet-stream" });
      createReadStream(file).pipe(response);
    } catch (error) {
      response.writeHead(502).end(String(error));
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createCompanionServer().listen(port, "127.0.0.1", () => console.log(`Agent Forge companion web: http://127.0.0.1:${port}`));
}
