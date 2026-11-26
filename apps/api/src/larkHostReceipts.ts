import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { config } from "./config.js";
import { db } from "./db.js";
import { requireLarkHostAuthorization } from "./larkHostAuthorization.js";

const requestIdSchema = z.string().uuid().transform(value => value.toLowerCase());
const requestHeader = "x-lark-request-id";
const maxResponseBytes = 64 * 1024;
const liveRequests = new Set<string>();
const authField = /^(?:(?:proxy[-_]?)?authorization|(?:set[-_]?)?cookie|(?:api|private)[-_]?key|(?:(?:access|refresh|auth|bearer|id|session)[-_]?)?token|password|(?:client[-_]?)?secret)$/i;

type HttpResult = { httpStatus: number; body: unknown };
type Receipt = { state: "running" | "unknown" } | ({ state: "finished" } & HttpResult);
type StoredRequest = { capability_id: string; input_hash: string; http_status: number | null; response_json: string | null };

function readRequest(requestId: string): StoredRequest | undefined {
  return db.prepare("SELECT capability_id, input_hash, http_status, response_json FROM lark_host_requests WHERE request_id = ?")
    .get(requestId) as StoredRequest | undefined;
}

function receipt(requestId: string, row: StoredRequest): Receipt {
  if (row.http_status !== null && row.response_json !== null) {
    return { state: "finished", httpStatus: row.http_status, body: JSON.parse(row.response_json) };
  }
  return { state: liveRequests.has(requestId) ? "running" : "unknown" };
}

function hashInput(body: unknown): string {
  const canonical = JSON.stringify(body, (_key, value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0))
      : value
  );
  return createHash("sha256").update(canonical).digest("hex");
}

function responseJson(body: unknown): string | null {
  const authValues = [config.larkAgentHostToken, config.larkAgentToken, config.giteaToken].filter(Boolean);
  const json = JSON.stringify(body, (key, value: unknown) => {
    if (authField.test(key) || (typeof value === "string" &&
      (authValues.some(token => token.length >= 8 ? value.includes(token) : value === token) ||
        /\b(?:Bearer|Basic) +[A-Za-z0-9._~+/=-]+/i.test(value)))) {
      throw new Error("Cannot retain an authenticated response containing credential material");
    }
    return value;
  });
  return json !== undefined && Buffer.byteLength(json) <= maxResponseBytes ? json : null;
}

export function registerLarkHostReceiptRoutes(app: FastifyInstance): void {
  const authorized = { preHandler: requireLarkHostAuthorization };
  app.get("/api/lark-agent/requests/protocol", authorized, async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    return { version: 1 };
  });
  app.get<{ Params: { requestId: string } }>("/api/lark-agent/requests/:requestId", authorized, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const parsed = requestIdSchema.safeParse(request.params.requestId);
    if (!parsed.success) return reply.code(400).send({ error: "requestId must be a UUID" });
    const row = readRequest(parsed.data);
    if (!row) return reply.code(404).send({ error: "request receipt not found" });
    return receipt(parsed.data, row);
  });
}

export async function runLarkHostCapability(
  request: FastifyRequest,
  reply: FastifyReply,
  id: string,
  execute: (body: unknown) => Promise<HttpResult>
) {
  const body = request.body ?? {};
  const header = request.headers[requestHeader];
  if (header === undefined) {
    const result = await execute(body);
    return reply.code(result.httpStatus).send(result.body);
  }
  reply.header("Cache-Control", "no-store");
  const parsed = requestIdSchema.safeParse(header);
  if (!parsed.success) return reply.code(400).send({ error: `${requestHeader} must be a UUID` });
  const requestId = parsed.data;
  const inputHash = hashInput(body);
  const inserted = db.prepare(`
    INSERT INTO lark_host_requests (request_id, capability_id, input_hash)
    VALUES (?, ?, ?) ON CONFLICT(request_id) DO NOTHING
  `).run(requestId, id, inputHash).changes;
  if (!inserted) {
    const row = readRequest(requestId);
    if (!row || row.capability_id !== id || row.input_hash !== inputHash) {
      return reply.code(409).send({ error: "request ID already belongs to another capability or input" });
    }
    const current = receipt(requestId, row);
    return reply.code(current.state === "running" ? 202 : 200).send(current);
  }

  liveRequests.add(requestId);
  const log = request.log;
  setImmediate(async () => {
    try {
      const result = await execute(body);
      const json = responseJson(result.body);
      if (json !== null) {
        db.prepare("UPDATE lark_host_requests SET http_status = ?, response_json = ? WHERE request_id = ?")
          .run(result.httpStatus, json, requestId);
      }
    } catch {
      log.warn({ larkHostRequestId: requestId, capabilityId: id }, "Lark host request finished without a retained response");
    } finally {
      // A claimed ID without a response or live owner is unknown. Never release the claim for replay.
      liveRequests.delete(requestId);
    }
  });
  return reply.code(202).send({ state: "running" });
}
