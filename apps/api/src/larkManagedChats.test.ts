import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import Fastify, { type FastifyInstance } from "fastify";

if (!process.env.AGENT_FORGE_TEST_ROOT) throw new Error("Run through the isolated API test runner");
process.env.DATABASE_PATH = path.join(process.env.AGENT_FORGE_TEST_ROOT, "managed-chats", "test.sqlite");
const { config } = await import("./config.js");
const { issueRoutes } = await import("./routes/issues.js");

const route = "/api/lark/managed-chats";
const target = "https://lark-agent.test/v1/managed-chats";
const requestId = "1d36ce04-da32-4ab4-9191-7fbbf7247778";
const input = { requestId, name: "Private group" };
const persona = { mode: "custom", name: "Reviewer", instructions: "Review only what was requested." };
const execution = { engineId: "codex", model: "fixture-model" };
const defaultEngine = { engineId: "dsh", model: null };
const item = { ...input, status: "ready", chatId: "oc_fixture", openUrl: null, createdAt: "2026-11-21T00:00:00Z",
  error: null, persona: null, execution: null };

async function withRoute(run: (app: FastifyInstance) => Promise<void>) {
  const originalFetch = globalThis.fetch;
  const { larkAgentUrl, larkAgentToken } = config;
  config.larkAgentUrl = "https://lark-agent.test";
  config.larkAgentToken = "fixture-token";
  const app = Fastify();
  try {
    globalThis.fetch = async () => { throw new Error("Unmocked upstream request"); };
    await app.register(issueRoutes);
    await run(app);
  } finally {
    await app.close();
    Object.assign(config, { larkAgentUrl, larkAgentToken });
    globalThis.fetch = originalFetch;
  }
}

test("managed chats proxy only the authenticated registry route and preserve creation inputs", () => withRoute(async app => {
  const catalog = [{ id: "codex", label: "Codex", models: [execution.model] }, { id: "dsh", label: "DSH", models: [] }];
  const upstreamRequests: Array<{ url: string; method?: string; body?: unknown; auth: string | null }> = [];
  globalThis.fetch = async (url, init) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    assert.equal(init?.redirect, "error");
    const headers = new Headers(init?.headers);
    if (init?.method === "POST") assert.equal(headers.get("content-type"), "application/json");
    upstreamRequests.push({ url: String(url), method: init?.method, body, auth: headers.get("authorization") });
    return Response.json(body ? { item: { ...item, ...body } } : { items: [{ ...item, execution: defaultEngine }], engines: catalog });
  };
  const list = await app.inject({ method: "GET", url: `${route}?includeAll=true` });
  assert.equal(list.statusCode, 200);
  assert.deepEqual(list.json(), { items: [{ ...item, execution: defaultEngine }], engines: catalog });
  for (const payload of [input, { ...input, persona, execution }, { ...input, execution: defaultEngine }]) {
    const result = await app.inject({ method: "POST", url: route, payload });
    assert.equal(result.statusCode, 200, result.body);
    assert.deepEqual(result.json(), { item: { ...item, ...payload } });
  }
  assert.deepEqual(upstreamRequests, [
    { url: target, method: "GET", body: undefined, auth: "Bearer fixture-token" },
    { url: target, method: "POST", body: input, auth: "Bearer fixture-token" },
    { url: target, method: "POST", body: { ...input, persona, execution }, auth: "Bearer fixture-token" },
    { url: target, method: "POST", body: { ...input, execution: defaultEngine }, auth: "Bearer fixture-token" }
  ]);
}));

test("managed chats reject invalid input, non-local callers and missing credentials without forwarding", () => withRoute(async app => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({}); };
  for (const payload of [
    { ...input, requestId: "not-a-uuid" }, { ...input, name: " " }, { ...input, ownerId: "ou_other" },
    { ...input, memberIds: ["ou_other"] }, { ...input, botId: "cli_other" },
    { ...input, persona: { ...persona, mode: "default" } }, { ...input, execution: { ...execution, model: " " } },
    { ...input, execution: { engineId: "dsh" } }
  ]) {
    const result = await app.inject({ method: "POST", url: route, payload });
    assert.equal(result.statusCode, 400, result.body);
    assert.equal(result.json().code, "VALIDATION_FAILED");
  }
  for (const request of [
    { headers: { origin: "https://untrusted.test" } }, { headers: { host: "untrusted.test" } },
    { remoteAddress: "192.0.2.12" }
  ]) {
    const result = await app.inject({ method: "POST", url: route, payload: input, ...request });
    assert.equal(result.statusCode, 403, result.body);
    assert.equal(result.json().code, "LARK_MANAGED_CHATS_LOCAL_ONLY");
  }
  config.larkAgentToken = "";
  const unconfigured = await app.inject(route);
  assert.equal(unconfigured.statusCode, 503);
  assert.equal(unconfigured.json().code, "LARK_AGENT_NOT_CONFIGURED");
  assert.equal(calls, 0);
}));

test("managed chats surface typed upstream errors and reject unconfirmed successes", () => withRoute(async app => {
  const error = { code: "LARK_MANAGED_CHAT_CONFLICT", message: "Request is already in progress", traceId: "fixture-trace" };
  globalThis.fetch = async () => Response.json(error, { status: 409 });
  const post = () => app.inject({ method: "POST", url: route, payload: input });
  const conflict = await post();
  assert.equal(conflict.statusCode, 409);
  assert.deepEqual(conflict.json(), error);

  globalThis.fetch = async () => Response.json({ item: { ...item, requestId: "517e61e3-7265-41fc-80c2-fbfcb75cbf69" } });
  const unconfirmed = await post();
  assert.equal(unconfirmed.statusCode, 502);
  assert.equal(unconfirmed.json().code, "LARK_AGENT_UPSTREAM_FAILED");

  globalThis.fetch = async () => { throw new Error("fixture transport error"); };
  const unavailable = await app.inject(route);
  assert.equal(unavailable.statusCode, 502);
  assert.equal(unavailable.json().code, "LARK_AGENT_UNAVAILABLE");
  assert.equal(typeof unavailable.json().traceId, "string");
}));
