import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import Fastify from "fastify";

if (!process.env.AGENT_FORGE_TEST_ROOT) throw new Error("Run through the isolated API test runner");
process.env.DATABASE_PATH = path.join(process.env.AGENT_FORGE_TEST_ROOT, "native-topics", "test.sqlite");
const { config } = await import("./config.js");
const { assertTestDatabaseIsolation, db, migrate, getAppSettings, updateAppSettings, updatePersistedRuntimeConfig, persistedRuntimeConfig } = await import("./db.js");
const { larkAppSettingsPatch } = await import("./larkRuntimeSettingsSync.js");
const { issueRoutes } = await import("./routes/issues.js");

test("native topic settings are default-off, strict, confirmed, reversible and backward-compatible in backups", async () => {
  assertTestDatabaseIsolation(config.databasePath); migrate(); db.prepare("DELETE FROM app_settings").run();
  const oldConfig = { ...config }, oldFetch = globalThis.fetch;
  updatePersistedRuntimeConfig({ ...persistedRuntimeConfig(), workspaceRoot: path.dirname(config.databasePath) });
  assert.equal(getAppSettings().larkTopicNativeModeEnabled, false);
  config.larkAgentUrl = "http://agent.test";
  let remote: Record<string, unknown> = { ...larkAppSettingsPatch(getAppSettings()), workspaceRoot: config.workspaceRoot,
    approverId: "ou_fixture", trustedSenderIds: [], turnAutoApprovalModelConfigurable: true };
  const methods: string[] = [];
  let mismatch = false;
  globalThis.fetch = async (url, init) => {
    if (!String(url).endsWith("/v1/settings")) return new Response("{}");
    const method = init?.method ?? "GET"; methods.push(method);
    if (method === "PATCH") remote = { ...remote, ...JSON.parse(String(init?.body)) };
    else if (mismatch && methods.at(-2) === "PATCH") { mismatch = false; return new Response(JSON.stringify({ ...remote, topicNativeModeEnabled: !remote.topicNativeModeEnabled })); }
    return new Response(JSON.stringify(remote));
  };
  const app = Fastify(); await app.register(issueRoutes);
  const save = (payload: Record<string, unknown>) => app.inject({ method: "PATCH", url: "/api/settings", payload });
  const restore = (payload: Record<string, unknown>) => app.inject({ method: "POST", url: "/api/settings/backup/restore", payload });
  try {
    for (const value of [null, "true", 1, [], {}]) assert.equal((await save({ larkTopicNativeModeEnabled: value })).statusCode, 400);
    assert.equal(methods.length, 0);
    assert.equal((await save({ larkTopicNativeModeEnabled: true })).statusCode, 200);
    assert.deepEqual(methods, ["GET", "PATCH", "GET"]); assert.equal(remote.topicNativeModeEnabled, true);
    const read = (await app.inject({ url: "/api/settings" })).json();
    assert.equal(read.appSettings.larkTopicNativeModeEnabled, true); assert.equal(read.larkSettingsKnown.larkTopicNativeModeEnabled, true);
    const backup = (await app.inject({ url: "/api/settings/backup" })).json(); assert.equal(backup.appSettings.larkTopicNativeModeEnabled, true);
    assert.equal((await save({ larkTopicNativeModeEnabled: false })).statusCode, 200);
    assert.equal((await restore(backup)).statusCode, 200); assert.equal(getAppSettings().larkTopicNativeModeEnabled, true);
    methods.length = 0; mismatch = true;
    const failed = await save({ larkTopicNativeModeEnabled: false }); assert.equal(failed.statusCode, 502, failed.body);
    assert.equal(remote.topicNativeModeEnabled, true); assert.equal(getAppSettings().larkTopicNativeModeEnabled, true);
    assert.deepEqual(methods, ["GET", "PATCH", "GET", "PATCH", "GET"]);
    delete remote.topicNativeModeEnabled;
    assert.equal((await app.inject({ url: "/api/settings" })).json().larkSettingsKnown.larkTopicNativeModeEnabled, false);
    assert.equal((await save({ larkTopicNativeModeEnabled: false })).statusCode, 409);
    assert.equal((await restore(backup)).statusCode, 400);
    const legacy = structuredClone(backup); delete legacy.appSettings.larkTopicNativeModeEnabled;
    assert.equal((await restore(legacy)).statusCode, 200); assert.equal(getAppSettings().larkTopicNativeModeEnabled, false);
    config.larkAgentUrl = "";
    assert.equal((await save({ larkTopicNativeModeEnabled: true })).statusCode, 409);
    assert.equal((await save({ larkTopicNativeModeEnabled: false })).statusCode, 409);
    assert.equal((await app.inject({ url: "/api/settings" })).json().larkSettingsKnown.larkTopicNativeModeEnabled, false);
    updateAppSettings({ larkTopicNativeModeEnabled: true });
    assert.equal((await restore(legacy)).statusCode, 200); assert.equal(getAppSettings().larkTopicNativeModeEnabled, false);
  } finally { globalThis.fetch = oldFetch; Object.assign(config, oldConfig); await app.close(); }
});
