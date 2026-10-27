import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { LarkAgentResponseError, larkAgentProxyFetch } from "../larkAgentIntegration.js";

export async function personalInboxRoutes(app: FastifyInstance) {
  for (const route of [
    { method: ["GET", "PATCH"] as const, url: "/api/personal-inbox", target: "/v1/personal-inbox" },
    { method: ["POST"] as const, url: "/api/personal-inbox/sync", target: "/v1/personal-inbox/sync" },
    { method: ["POST"] as const, url: "/api/personal-inbox/:id/decision", target: "/v1/personal-inbox/:id/decision" }
  ]) {
    app.route({ method: [...route.method], url: route.url, handler: async (request, reply) => {
      if (!config.larkAgentUrl) return reply.code(503).send({ error: "个人收件箱需要先连接 Lark Agent。" });
      // Cookie-free loopback API: reject cross-origin mutation, even if a caller bypasses browser CORS.
      if (request.method !== "GET" && request.headers.origin
        && ![`http://127.0.0.1:${config.webPort}`, `http://localhost:${config.webPort}`, "http://127.0.0.1:4734"].includes(request.headers.origin)) {
        return reply.code(403).send({ error: "untrusted origin" });
      }
      const id = (request.params as { id?: string }).id;
      if (id !== undefined && !/^[1-9][0-9]*$/.test(id)) return reply.code(400).send({ error: "invalid id" });
      const target = id ? route.target.replace(":id", id) : route.target;
      try {
        return await larkAgentProxyFetch(target, { method: request.method,
          ...(request.method !== "GET" ? { headers: { "content-type": "application/json" }, body: JSON.stringify(request.body ?? {}) } : {}) });
      } catch (error) {
        if (error instanceof LarkAgentResponseError) return reply.code(error.statusCode).send(error.responseBody);
        return reply.code(502).send({ error: "个人收件箱暂时无法连接。" });
      }
    } });
  }
}
