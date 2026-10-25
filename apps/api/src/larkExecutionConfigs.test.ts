import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import path from "node:path";

if (!process.env.AGENT_FORGE_TEST_ROOT) throw new Error("Run through the isolated API test runner");
process.env.DATABASE_PATH = path.join(process.env.AGENT_FORGE_TEST_ROOT, "execution-configs", "test.sqlite");
const { config } = await import("./config.js");
const { issueRoutes } = await import("./routes/issues.js");

test("message execution configs pass through without consulting current settings or loading logs", async () => {
  const previousUrl = config.larkAgentUrl; const originalFetch = globalThis.fetch;
  config.larkAgentUrl = "http://lark-agent.test";
  const requests: string[] = [];
  const snapshot = {schemaVersion: 1, threadId: "thread", turnId: "turn", model: "old-model", reasoningEffort: "high", source: "accepted-request"};
  globalThis.fetch = async url => {
    const target = String(url); requests.push(target);
    return new Response(JSON.stringify(target.endsWith("/artifacts")
      ? {executionConfigs: [snapshot], approvals: []}
      : {id: 1, message_id: "om", direction: "inbound", executionConfigs: [snapshot]}));
  };
  const app = Fastify(); await app.register(issueRoutes);
  try {
    const detail = await app.inject({method: "GET", url: "/api/lark/messages/1"});
    assert.equal(detail.statusCode, 200);
    assert.deepEqual(detail.json().executionConfigs, [snapshot]);
    assert.deepEqual(requests, ["http://lark-agent.test/v1/messages/1"]);
    const artifacts = await app.inject({method: "GET", url: "/api/lark/messages/1/artifacts"});
    assert.deepEqual(artifacts.json().executionConfigs, [snapshot]);
    globalThis.fetch = async () => new Response(JSON.stringify({id: 2, direction: "inbound"}));
    const historical = await app.inject({method: "GET", url: "/api/lark/messages/2/artifacts"});
    assert.deepEqual(historical.json().executionConfigs, []);
  } finally { await app.close(); globalThis.fetch = originalFetch; config.larkAgentUrl = previousUrl; }
});
