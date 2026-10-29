import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "../config.js";
import { LarkAgentResponseError, larkAgentProxyFetch } from "../larkAgentIntegration.js";

const ownerMentionAssistDecisionSchema = z.object({
  action: z.enum(["send", "dismiss"]),
  text: z.string().max(20_000).optional(),
  version: z.number().int().safe().nonnegative()
}).strict();

export async function personalInboxRoutes(app: FastifyInstance) {
  for (const route of [
    { method: ["GET", "PATCH"] as const, url: "/api/personal-inbox", target: "/v1/personal-inbox" },
    { method: ["POST"] as const, url: "/api/personal-inbox/sync", target: "/v1/personal-inbox/sync" },
    { method: ["POST"] as const, url: "/api/personal-inbox/:id/decision", target: "/v1/personal-inbox/:id/decision" },
    { method: ["GET"] as const, url: "/api/owner-mention-assists", target: "/v1/owner-mention-assists" },
    { method: ["POST"] as const, url: "/api/owner-mention-assists/:id/decision", target: "/v1/owner-mention-assists/:id/decision" }
  ]) {
    app.route({ method: [...route.method], url: route.url, handler: async (request, reply) => {
      const feature = route.target.startsWith("/v1/owner-mention-assists") ? "群聊协同" : "个人收件箱";
      if (!config.larkAgentUrl) return reply.code(503).send({ error: `${feature}需要先连接 Lark Agent。` });
      // Cookie-free loopback API: reject cross-origin mutation, even if a caller bypasses browser CORS.
      if (request.method !== "GET" && request.headers.origin
        && ![`http://127.0.0.1:${config.webPort}`, `http://localhost:${config.webPort}`, "http://127.0.0.1:4734"].includes(request.headers.origin)) {
        return reply.code(403).send({ error: "untrusted origin" });
      }
      const id = (request.params as { id?: string }).id;
      if (id !== undefined && !/^[1-9][0-9]*$/.test(id)) return reply.code(400).send({ error: "invalid id" });
      let body = request.body ?? {};
      if (route.target === "/v1/owner-mention-assists/:id/decision") {
        const parsed = ownerMentionAssistDecisionSchema.safeParse(request.body);
        if (!parsed.success) return reply.code(400).send({ error: "invalid owner mention assist decision" });
        body = parsed.data;
      }
      const target = id ? route.target.replace(":id", id) : route.target;
      try {
        return await larkAgentProxyFetch(target, { method: request.method,
          ...(request.method !== "GET" ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) });
      } catch (error) {
        if (error instanceof LarkAgentResponseError) return reply.code(error.statusCode).send(error.responseBody);
        return reply.code(502).send({ error: `${feature}暂时无法连接。` });
      }
    } });
  }
}
