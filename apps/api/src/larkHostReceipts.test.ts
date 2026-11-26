import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import test from "node:test";
import Fastify from "fastify";
import { config } from "./config.js";
import { db, migrate } from "./db.js";
import { requireLarkHostAuthorization } from "./larkHostAuthorization.js";
import { registerLarkHostReceiptRoutes, runLarkHostCapability } from "./larkHostReceipts.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test("Forge claims a durable receipt before detached execution and never replays a claimed ID", async () => {
  migrate();
  const app = Fastify();
  const previousToken = config.larkAgentHostToken;
  const token = "fixture-receipt-host-credential";
  config.larkAgentHostToken = token;
  const authorization = `Bearer ${token}`;
  const requestId = randomUUID();
  const history = db.prepare("SELECT * FROM lark_host_requests WHERE request_id = ?");
  const started = deferred<unknown>();
  const settle = deferred<void>();
  let calls = 0;
  registerLarkHostReceiptRoutes(app);
  app.post<{ Params: { id: string } }>("/api/lark-agent/capabilities/:id", { preHandler: requireLarkHostAuthorization }, (request, reply) =>
    runLarkHostCapability(request, reply, request.params.id, async body => {
      calls++;
      switch ((body as { input: { kind?: string } }).input.kind) {
        case "oversized": return { httpStatus: 200, body: "x".repeat(64 * 1024) };
        case "secret": return { httpStatus: 200, body: { echoed: token } };
        case "no-response": throw new Error("fixture failed to produce an HTTP response");
      }
      started.resolve(history.get(requestId));
      await settle.promise;
      return { httpStatus: 409, body: ["adapter reported an error", null] };
    }));

  const payload = { input: { a: "not retained", b: [1, 2] }, context: { larkMessageId: 1 } };
  const post = (key: string, data = payload, id = "forge.fixture") => app.inject({
    method: "POST", url: `/api/lark-agent/capabilities/${id}`, headers: { authorization, "x-lark-request-id": key }, payload: data
  });
  const get = (key: string, headers: Record<string, string> = { authorization }) =>
    app.inject({ method: "GET", url: `/api/lark-agent/requests/${key}`, headers });
  async function terminal(key: string) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const response = await get(key);
      assert.equal(response.statusCode, 200);
      const result = response.json();
      if (result.state !== "running") return result;
      await setTimeout(10);
    }
    assert.fail("receipt did not settle");
  }

  try {
    assert.equal((await get("protocol", {})).statusCode, 401);
    assert.deepEqual((await get("protocol")).json(), { version: 1 });
    assert.equal((await get(requestId, { authorization: "Bearer forged" })).statusCode, 401);
    assert.equal((await get(requestId)).statusCode, 404);
    assert.equal((await post("not-a-uuid")).statusCode, 400);
    assert.equal((await app.inject({
      method: "POST", url: "/api/lark-agent/capabilities/forge.fixture", headers: { "x-lark-request-id": requestId }, payload
    })).statusCode, 401);
    assert.equal(history.get(requestId), undefined);

    const [first, second] = await Promise.all([post(requestId), post(requestId.toUpperCase())]);
    for (const response of [first, second]) {
      assert.equal(response.statusCode, 202);
      assert.deepEqual(response.json(), { state: "running" });
    }
    const row = await started.promise;
    assert.deepEqual(row, {
      request_id: requestId, capability_id: "forge.fixture", input_hash: (row as { input_hash: string }).input_hash,
      http_status: null, response_json: null
    });
    assert.match((row as { input_hash: string }).input_hash, /^[a-f0-9]{64}$/);
    assert.equal(calls, 1);
    assert.deepEqual((await get(requestId)).json(), { state: "running" });
    const reordered = { context: payload.context, input: { b: payload.input.b, a: payload.input.a } };
    assert.equal((await post(requestId, reordered)).statusCode, 202);
    assert.equal((await post(requestId, { ...payload, input: { ...payload.input, b: [2, 1] } })).statusCode, 409);
    assert.equal((await post(requestId, { ...payload, context: { larkMessageId: 2 } })).statusCode, 409);
    assert.equal((await post(requestId, payload, "forge.other")).statusCode, 409);
    settle.resolve();
    const failed = { state: "finished", httpStatus: 409, body: ["adapter reported an error", null] };
    assert.deepEqual(await terminal(requestId), failed);
    const duplicate = await post(requestId);
    assert.equal(duplicate.statusCode, 200);
    assert.deepEqual(duplicate.json(), failed);
    assert.equal(calls, 1);

    const orphan = randomUUID();
    // Model a prior process that committed its claim but disappeared before saving a result.
    db.prepare(`INSERT INTO lark_host_requests (request_id, capability_id, input_hash)
      SELECT ?, capability_id, input_hash FROM lark_host_requests WHERE request_id = ?`).run(orphan, requestId);
    assert.deepEqual((await get(orphan)).json(), { state: "unknown" });
    const orphanDuplicate = await post(orphan);
    assert.equal(orphanDuplicate.statusCode, 200);
    assert.deepEqual(orphanDuplicate.json(), { state: "unknown" });
    assert.equal(calls, 1);

    for (const kind of ["oversized", "secret", "no-response"]) {
      const key = randomUUID();
      const input = { ...payload, input: { ...payload.input, kind } };
      assert.equal((await post(key, input)).statusCode, 202);
      assert.deepEqual(await terminal(key), { state: "unknown" });
      assert.deepEqual((await post(key, input)).json(), { state: "unknown" });
      assert.equal((history.get(key) as { response_json: string | null }).response_json, null);
    }
    assert.equal(calls, 4);
  } finally {
    settle.resolve();
    await app.close();
    config.larkAgentHostToken = previousToken;
  }
});
