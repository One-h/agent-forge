import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "./config.js";

export async function requireLarkHostAuthorization(request: FastifyRequest, reply: FastifyReply) {
  if (!config.larkAgentHostToken || request.headers.authorization !== `Bearer ${config.larkAgentHostToken}`) {
    return reply.code(401).send({ error: "host capability authorization required" });
  }
}
