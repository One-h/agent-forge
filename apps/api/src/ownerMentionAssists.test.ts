import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import Fastify from "fastify";

if (!process.env.AGENT_FORGE_TEST_ROOT) throw new Error("Run through the isolated API test runner");
process.env.DATABASE_PATH = path.join(process.env.AGENT_FORGE_TEST_ROOT, "owner-mention-assists", "test.sqlite");
const { config } = await import("./config.js");
const { assertTestDatabaseIsolation, db, migrate, getAppSettings, updateAppSettings, updatePersistedRuntimeConfig, persistedRuntimeConfig } = await import("./db.js");
const { larkAppSettingsPatch } = await import("./larkRuntimeSettingsSync.js");
const { issueRoutes } = await import("./routes/issues.js");
const { personalInboxRoutes } = await import("./routes/personalInbox.js");

const item = {
  id: 7, lark_message_id: 7, owner_id: "ou_owner", decision: "owner_required", status: "ready",
  reason: "Confirm the proposed reply", draft: "Proposed reply", question: "Send this reply?", version: 3,
  content: "Please review", chat_id: "oc_group", chat_type: "group", sender_id: "ou_requester",
  message_id: "om_original", thread_id: null, enabled: true,
  ownerResponses: [{ id: 8, message_id: "om_reply", content: "I am checking", message_at: "2026-01-01T00:00:00Z", reply_to_message_id: "om_original" }]
};

test("assist proxy is isolated, authenticated, strict and preserves Agent conflicts", async () => {
  const previous = { ...config }, fetch = globalThis.fetch;
  config.larkAgentUrl = "http://agent.test"; config.larkAgentToken = "fixture-token";
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  let conflict = false;
  globalThis.fetch = async (url, init) => {
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fixture-token");
    calls.push({ url: String(url), method: init?.method ?? "GET", ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    return new Response(JSON.stringify(conflict ? { error: "version changed" } : init?.method === "POST" ? { item: { ...item, status: "sent" } } : { items: [item] }), { status: conflict ? 409 : 200 });
  };
  const app = Fastify(); await app.register(personalInboxRoutes);
  try {
    const list = await app.inject({ method: "GET", url: "/api/owner-mention-assists" });
    assert.deepEqual(list.json(), { items: [item] });
    const decision = (payload: Record<string, unknown> | undefined, id = "7", origin?: string) => app.inject({ method: "POST", url: `/api/owner-mention-assists/${id}/decision`, payload, headers: origin ? { origin } : {} });
    const before = calls.length;
    for (const payload of [undefined, {}, { action: "approve", version: 3 }, { action: "send", version: "3" }, { action: "send", version: -1 },
      { action: "send", version: 1.5 }, { action: "send", version: Number.MAX_SAFE_INTEGER + 1 }, { action: "send", version: 3, requesterId: "ou_other" },
      { action: "dismiss", text: 2, version: 3 }, { action: "send", text: "x".repeat(20_001), version: 3 }]) {
      assert.equal((await decision(payload)).statusCode, 400);
    }
    for (const id of ["0", "-1", "abc", "7%2Fdecision"]) assert.equal((await decision({ action: "send", version: 3 }, id)).statusCode, 400);
    assert.equal((await decision({ action: "send", version: 3 }, "7", "https://foreign.test")).statusCode, 403);
    assert.equal(calls.length, before);
    assert.equal((await decision({ action: "send", text: "Edited reply", version: 3 }, "7", `http://localhost:${config.webPort}`)).statusCode, 200);
    assert.deepEqual(calls.at(-1), { url: "http://agent.test/v1/owner-mention-assists/7/decision", method: "POST", body: { action: "send", text: "Edited reply", version: 3 } });
    conflict = true;
    const stale = await decision({ action: "dismiss", version: 2 });
    assert.equal(stale.statusCode, 409); assert.deepEqual(stale.json(), { error: "version changed" });
    assert.equal(calls.some(call => call.url.includes("personal-inbox")), false);
    config.larkAgentUrl = "";
    assert.equal((await decision({ action: "dismiss", version: 3 })).statusCode, 503);
  } finally { globalThis.fetch = fetch; Object.assign(config, previous); await app.close(); }
});

test("chat assist mode rejects unsupported Agent, validates strictly and requires independent readback", async () => {
  const previous = { ...config }, fetch = globalThis.fetch;
  config.larkAgentUrl = "http://agent.test";
  const base = { stickerUsage: { mode: "natural" }, spontaneousReply: { mode: "off" } };
  let remote: Record<string, unknown> = { ...base };
  let mismatch = false;
  let expectedMode = "on";
  const methods: string[] = [];
  globalThis.fetch = async (_url, init) => {
    methods.push(init?.method ?? "GET");
    if (init?.method === "PATCH") {
      assert.deepEqual(JSON.parse(String(init.body)), { ownerMentionAssistMode: expectedMode });
      const result = { ...base, ownerMentionAssist: { mode: expectedMode, globalEnabled: false, effectiveEnabled: expectedMode === "on", ownerId: "ou_owner" } };
      if (!mismatch) remote = result;
      return new Response(JSON.stringify(result));
    }
    return new Response(JSON.stringify(remote));
  };
  const app = Fastify(); await app.register(issueRoutes);
  const save = (payload: Record<string, unknown>) => app.inject({ method: "PATCH", url: "/api/lark/chats/oc_group/settings", payload });
  try {
    for (const payload of [{ ownerMentionAssistMode: "maybe" }, { ownerMentionAssistMode: "on", ownerId: "ou_other" }, {}]) assert.equal((await save(payload)).statusCode, 400);
    assert.equal(methods.length, 0);
    assert.equal((await save({ ownerMentionAssistMode: "on" })).statusCode, 409);
    assert.deepEqual(methods, ["GET"]);
    remote.ownerMentionAssist = { mode: "global", globalEnabled: false, effectiveEnabled: false, ownerId: "ou_owner" };
    methods.length = 0; mismatch = true;
    assert.equal((await save({ ownerMentionAssistMode: "on" })).statusCode, 502);
    assert.deepEqual(methods, ["GET", "PATCH", "GET"]);
    methods.length = 0; mismatch = false;
    const result = await save({ ownerMentionAssistMode: "on" });
    assert.equal(result.statusCode, 200); assert.deepEqual(methods, ["GET", "PATCH", "GET"]);
    assert.deepEqual(result.json().stickerUsage, base.stickerUsage); assert.deepEqual(result.json().spontaneousReply, base.spontaneousReply);
    for (const mode of ["off", "global"]) {
      expectedMode = mode;
      const changed = await save({ ownerMentionAssistMode: mode });
      assert.equal(changed.statusCode, 200); assert.equal(changed.json().ownerMentionAssist.mode, mode);
    }
  } finally { globalThis.fetch = fetch; Object.assign(config, previous); await app.close(); }
});

test("global assist defaults, strict fields, backup restore and compensation use confirmed runtime values", async () => {
  const previous = { ...config }, fetch = globalThis.fetch;
  assertTestDatabaseIsolation(config.databasePath); migrate();
  db.prepare("DELETE FROM app_settings").run();
  assert.equal(getAppSettings().larkOwnerMentionAssistEnabled, false); assert.equal(getAppSettings().larkOwnerMentionAssistOwnerId, "");
  updatePersistedRuntimeConfig({ ...persistedRuntimeConfig(), workspaceRoot: path.dirname(config.databasePath) });
  config.larkAgentUrl = "http://agent.test";
  let remote: Record<string, unknown> = { ...larkAppSettingsPatch(getAppSettings()), workspaceRoot: config.workspaceRoot, approverId: "ou_approver", trustedSenderIds: ["ou_approver"], turnAutoApprovalModelConfigurable: true };
  const methods: string[] = [];
  let mismatch = false, patched = false;
  globalThis.fetch = async (url, init) => {
    if (!String(url).endsWith("/v1/settings")) return new Response("{}");
    methods.push(init?.method ?? "GET");
    if (init?.method === "PATCH") {
      remote = { ...remote, ...JSON.parse(String(init.body)) }; patched = true;
      return new Response(JSON.stringify(remote));
    }
    if (mismatch && patched) { mismatch = false; return new Response(JSON.stringify({ ...remote, ownerMentionAssistOwnerId: "ou_wrong" })); }
    return new Response(JSON.stringify(remote));
  };
  const app = Fastify(); await app.register(issueRoutes);
  const save = (payload: Record<string, unknown>) => app.inject({ method: "PATCH", url: "/api/settings", payload });
  const restore = (payload: Record<string, unknown>) => app.inject({ method: "POST", url: "/api/settings/backup/restore", payload });
  const enabled = { larkOwnerMentionAssistEnabled: true, larkOwnerMentionAssistOwnerId: "ou_owner" };
  try {
    for (const payload of [{ larkOwnerMentionAssistEnabled: "true" }, { larkOwnerMentionAssistOwnerId: "someone@example.test" }, { larkOwnerMentionAssistOwnerId: "ou_a", unexpected: true }]) assert.equal((await save(payload)).statusCode, 400);
    assert.equal(methods.length, 0);
    assert.equal((await save(enabled)).statusCode, 200); assert.deepEqual(methods, ["GET", "PATCH", "GET"]);
    const exported = (await app.inject({ method: "GET", url: "/api/settings/backup" })).json();
    assert.equal(exported.appSettings.larkOwnerMentionAssistEnabled, true); assert.equal(exported.appSettings.larkOwnerMentionAssistOwnerId, "ou_owner");
    for (const invalid of [{ larkOwnerMentionAssistEnabled: "true" }, { larkOwnerMentionAssistOwnerId: "not-an-open-id" }]) {
      const corrupted = structuredClone(exported); Object.assign(corrupted.appSettings, invalid);
      assert.equal((await restore(corrupted)).statusCode, 400);
    }
    await save({ larkOwnerMentionAssistEnabled: false, larkOwnerMentionAssistOwnerId: "" });
    methods.length = 0; patched = false; mismatch = true;
    const failedRestore = await restore(exported);
    assert.equal(failedRestore.statusCode, 400); assert.match(failedRestore.body, /readback.*previous remote .* restored/);
    assert.equal(getAppSettings().larkOwnerMentionAssistEnabled, false); assert.equal(getAppSettings().larkOwnerMentionAssistOwnerId, "");
    assert.equal(remote.ownerMentionAssistEnabled, false); assert.equal(remote.ownerMentionAssistOwnerId, "");
    assert.deepEqual(methods, ["GET", "PATCH", "GET", "PATCH", "GET"]);
    methods.length = 0;
    assert.equal((await restore(exported)).statusCode, 200);
    assert.deepEqual(methods, ["GET", "PATCH", "GET"]);
    assert.equal(getAppSettings().larkOwnerMentionAssistEnabled, true);
    const read = (await app.inject({ method: "GET", url: "/api/settings" })).json();
    assert.equal(read.appSettings.larkOwnerMentionAssistOwnerId, "ou_owner"); assert.equal(read.larkSettingsKnown.larkOwnerMentionAssistEnabled, true);
    delete remote.ownerMentionAssistEnabled; delete remote.ownerMentionAssistOwnerId;
    const unknown = (await app.inject({ method: "GET", url: "/api/settings" })).json();
    assert.equal(unknown.larkSettingsKnown.larkOwnerMentionAssistEnabled, false); assert.equal(unknown.larkSettingsKnown.larkOwnerMentionAssistOwnerId, false);
    assert.equal((await save(enabled)).statusCode, 409);
    const unsupportedRestore = await restore(exported);
    assert.equal(unsupportedRestore.statusCode, 400); assert.match(unsupportedRestore.body, /does not support.*ownerMentionAssist/);
    const legacy = structuredClone(exported); delete legacy.appSettings.larkOwnerMentionAssistEnabled; delete legacy.appSettings.larkOwnerMentionAssistOwnerId;
    assert.equal((await restore(legacy)).statusCode, 200);
    assert.equal(getAppSettings().larkOwnerMentionAssistEnabled, false); assert.equal(getAppSettings().larkOwnerMentionAssistOwnerId, "");
    config.larkAgentUrl = "";
    assert.equal((await save({ larkOwnerMentionAssistEnabled: false })).statusCode, 409);
    updateAppSettings({ larkOwnerMentionAssistEnabled: true });
    assert.equal((await restore(legacy)).statusCode, 200); assert.equal(getAppSettings().larkOwnerMentionAssistEnabled, false);
  } finally { globalThis.fetch = fetch; Object.assign(config, previous); await app.close(); }
});

test("assist bot IDs persist normalized unique IDs, validate strictly, mirror Agent state and reset to empty", async () => {
  const previous = { ...config }, fetch = globalThis.fetch;
  assertTestDatabaseIsolation(config.databasePath); migrate();
  db.prepare("DELETE FROM app_settings").run();
  assert.deepEqual(getAppSettings().larkOwnerMentionAssistBotIds, []);
  updatePersistedRuntimeConfig({ ...persistedRuntimeConfig(), workspaceRoot: path.dirname(config.databasePath) });
  config.larkAgentUrl = "http://agent.test";
  let remote: Record<string, unknown> = { ...larkAppSettingsPatch(getAppSettings()), workspaceRoot: config.workspaceRoot, approverId: "", trustedSenderIds: [], turnAutoApprovalModelConfigurable: true };
  const calls: Array<{ method: string; body?: unknown }> = [];
  globalThis.fetch = async (url, init) => {
    if (!String(url).endsWith("/v1/settings")) return new Response("{}");
    calls.push({ method: init?.method ?? "GET", ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (init?.method === "PATCH") remote = { ...remote, ...JSON.parse(String(init.body)) };
    return new Response(JSON.stringify(remote));
  };
  const app = Fastify(); await app.register(issueRoutes);
  const save = (value: unknown) => app.inject({ method: "PATCH", url: "/api/settings", payload: { larkOwnerMentionAssistBotIds: value } });
  const restore = (payload: Record<string, unknown>) => app.inject({ method: "POST", url: "/api/settings/backup/restore", payload });
  try {
    for (const value of [null, "ou_bot", {}, [1], [null], [""], [" "], ["oc_chat"], ["ou_"], ["ou_bad-id"], [`ou_${"x".repeat(198)}`], Array.from({ length: 101 }, (_, i) => `ou_bot${i}`)]) {
      assert.equal((await save(value)).statusCode, 400, JSON.stringify(value));
    }
    assert.equal((await app.inject({ method: "PATCH", url: "/api/settings", payload: { larkOwnerMentionAssistBotIds: [], unexpected: true } })).statusCode, 400);
    assert.deepEqual(calls, []);
    const saved = await save([" ou_botB \n", "ou_botA", "ou_botB"]);
    assert.equal(saved.statusCode, 200, saved.body);
    assert.deepEqual(saved.json().larkOwnerMentionAssistBotIds, ["ou_botB", "ou_botA"]);
    assert.deepEqual(calls, [{ method: "GET" }, { method: "PATCH", body: { ownerMentionAssistBotIds: ["ou_botB", "ou_botA"] } }, { method: "GET" }]);
    const backup = (await app.inject({ method: "GET", url: "/api/settings/backup" })).json();
    assert.deepEqual(backup.appSettings.larkOwnerMentionAssistBotIds, ["ou_botB", "ou_botA"]);
    const invalidBackup = structuredClone(backup); invalidBackup.appSettings.larkOwnerMentionAssistBotIds = ["bad"];
    const beforeInvalidRestore = calls.length;
    assert.equal((await restore(invalidBackup)).statusCode, 400);
    assert.equal(calls.length, beforeInvalidRestore);
    remote.ownerMentionAssistBotIds = ["ou_remote"];
    const read = (await app.inject({ method: "GET", url: "/api/settings" })).json();
    assert.deepEqual(read.appSettings.larkOwnerMentionAssistBotIds, ["ou_remote"]);
    assert.equal(read.larkSettingsKnown.larkOwnerMentionAssistBotIds, true);
    assert.deepEqual(getAppSettings().larkOwnerMentionAssistBotIds, ["ou_botB", "ou_botA"], "GET must not persist remote state");
    assert.equal((await save([])).statusCode, 200);
    assert.deepEqual(remote.ownerMentionAssistBotIds, []);
    assert.deepEqual(getAppSettings().larkOwnerMentionAssistBotIds, []);
    assert.equal((await restore(backup)).statusCode, 200);
    assert.deepEqual(remote.ownerMentionAssistBotIds, ["ou_botB", "ou_botA"]);
    const boundary = Array.from({ length: 100 }, (_, i) => i === 0 ? `ou_${"x".repeat(197)}` : `ou_bot${i}`);
    assert.equal((await save(boundary)).statusCode, 200);
    assert.deepEqual(getAppSettings().larkOwnerMentionAssistBotIds, boundary);
    const legacy = structuredClone(backup); delete legacy.appSettings.larkOwnerMentionAssistBotIds;
    assert.equal((await restore(legacy)).statusCode, 200);
    assert.deepEqual(remote.ownerMentionAssistBotIds, [], "old backup resets a supported Agent to empty");
    assert.deepEqual(getAppSettings().larkOwnerMentionAssistBotIds, []);
  } finally { globalThis.fetch = fetch; Object.assign(config, previous); await app.close(); }
});

test("assist bot sync confirms sets and rolls back both empty and populated lists after echo, readback or local failures", async () => {
  const previous = { ...config }, fetch = globalThis.fetch;
  assertTestDatabaseIsolation(config.databasePath); migrate();
  config.larkAgentUrl = "http://agent.test";
  const app = Fastify(); await app.register(issueRoutes);
  try {
    for (const before of [[], ["ou_previous"]]) {
      for (const failure of ["echo", "readback", "local"] as const) {
        updateAppSettings({ larkOwnerMentionAssistBotIds: before });
        let remote = [...before];
        const patches: Array<{ ownerMentionAssistBotIds: string[] }> = [];
        const methods: string[] = [];
        globalThis.fetch = async (_url, init) => {
          assert.deepEqual(getAppSettings().larkOwnerMentionAssistBotIds, before, "no local commit before readback or during compensation");
          methods.push(init?.method ?? "GET");
          if (init?.method === "PATCH") {
            const patch = JSON.parse(String(init.body)); patches.push(patch);
            remote = patch.ownerMentionAssistBotIds;
            if (failure === "echo" && patches.length === 1) return new Response(JSON.stringify({ ownerMentionAssistBotIds: ["ou_wrong"] }));
          } else if (failure === "readback" && patches.length === 1) {
            return new Response(JSON.stringify({ ownerMentionAssistBotIds: ["ou_wrong"] }));
          }
          return new Response(JSON.stringify({ ownerMentionAssistBotIds: remote }));
        };
        if (failure === "local") db.exec("CREATE TEMP TRIGGER reject_bot_ids BEFORE UPDATE ON app_settings WHEN NEW.key = 'larkOwnerMentionAssistBotIds' BEGIN SELECT RAISE(FAIL, 'local bot save failed'); END");
        try {
          const desired = before.length ? [] : ["ou_next"];
          const result = await app.inject({ method: "PATCH", url: "/api/settings", payload: { larkOwnerMentionAssistBotIds: desired } });
          assert.equal(result.statusCode, failure === "local" ? 500 : 502, result.body);
          assert.match(result.body, /previous remote runtime settings restored/);
          assert.deepEqual(patches, [{ ownerMentionAssistBotIds: desired }, { ownerMentionAssistBotIds: before }]);
          assert.deepEqual(methods, failure === "echo" ? ["GET", "PATCH", "PATCH", "GET"] : ["GET", "PATCH", "GET", "PATCH", "GET"]);
          assert.deepEqual(remote, before);
          assert.deepEqual(getAppSettings().larkOwnerMentionAssistBotIds, before);
        } finally { if (failure === "local") db.exec("DROP TRIGGER reject_bot_ids"); }
      }
    }
    const methods: string[] = [];
    globalThis.fetch = async (_url, init) => {
      methods.push(init?.method ?? "GET");
      return new Response(JSON.stringify({ ownerMentionAssistBotIds: init?.method === "PATCH" || methods.length > 1 ? ["ou_b", "ou_a"] : [] }));
    };
    const reordered = await app.inject({ method: "PATCH", url: "/api/settings", payload: { larkOwnerMentionAssistBotIds: ["ou_a", "ou_b"] } });
    assert.equal(reordered.statusCode, 200, reordered.body);
    assert.deepEqual(methods, ["GET", "PATCH", "GET"]);
  } finally { globalThis.fetch = fetch; Object.assign(config, previous); await app.close(); }
});

test("legacy Agents reject explicit bot edits and nonempty restores but accept missing empty backup defaults", async () => {
  const previous = { ...config }, fetch = globalThis.fetch;
  assertTestDatabaseIsolation(config.databasePath); migrate();
  db.prepare("DELETE FROM app_settings").run();
  updatePersistedRuntimeConfig({ ...persistedRuntimeConfig(), workspaceRoot: path.dirname(config.databasePath) });
  updateAppSettings({ larkOwnerMentionAssistEnabled: true, larkOwnerMentionAssistOwnerId: "ou_owner", larkOwnerMentionAssistBotIds: ["ou_bot"] });
  config.larkAgentUrl = "http://agent.test";
  let remote: Record<string, unknown> = { ...larkAppSettingsPatch(getAppSettings()), workspaceRoot: config.workspaceRoot, approverId: "", trustedSenderIds: [], turnAutoApprovalModelConfigurable: true };
  delete remote.ownerMentionAssistBotIds;
  const patches: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (url, init) => {
    if (!String(url).endsWith("/v1/settings")) return new Response("{}");
    if (init?.method === "PATCH") { const patch = JSON.parse(String(init.body)); patches.push(patch); remote = { ...remote, ...patch }; }
    return new Response(JSON.stringify(remote));
  };
  const app = Fastify(); await app.register(issueRoutes);
  const save = (value: unknown) => app.inject({ method: "PATCH", url: "/api/settings", payload: { larkOwnerMentionAssistBotIds: value } });
  const restore = (payload: Record<string, unknown>) => app.inject({ method: "POST", url: "/api/settings/backup/restore", payload });
  try {
    const backup = (await app.inject({ method: "GET", url: "/api/settings/backup" })).json();
    const legacy = structuredClone(backup); delete legacy.appSettings.larkOwnerMentionAssistBotIds;
    assert.equal((await app.inject({ method: "GET", url: "/api/settings" })).json().larkSettingsKnown.larkOwnerMentionAssistBotIds, false);
    for (const value of [[], ["ou_next"]]) assert.equal((await save(value)).statusCode, 409);
    assert.equal((await restore(backup)).statusCode, 400);
    assert.deepEqual(patches, []);
    assert.deepEqual(getAppSettings().larkOwnerMentionAssistBotIds, ["ou_bot"]);
    const restored = await restore(legacy);
    assert.equal(restored.statusCode, 200, restored.body);
    assert.equal(Object.hasOwn(patches.at(-1)!, "ownerMentionAssistBotIds"), false);
    assert.equal(getAppSettings().larkOwnerMentionAssistEnabled, true, "bot-list compatibility must not require disabling existing assist");
    assert.deepEqual(getAppSettings().larkOwnerMentionAssistBotIds, []);
    for (const malformed of [null, "ou_bot", ["bad"], Array(101).fill("ou_bot")]) {
      remote.ownerMentionAssistBotIds = malformed;
      assert.equal((await app.inject({ method: "GET", url: "/api/settings" })).json().larkSettingsKnown.larkOwnerMentionAssistBotIds, false);
      const count: number = patches.length;
      assert.equal((await save([])).statusCode, 409);
      assert.equal((await restore(legacy)).statusCode, 400, "malformed is not an absent legacy field");
      assert.equal(patches.length, count);
    }
    config.larkAgentUrl = "";
    for (const value of [[], ["ou_bot"]]) assert.equal((await save(value)).statusCode, 409);
    assert.equal((await restore(backup)).statusCode, 400);
    Object.assign(legacy.appSettings, { larkOwnerMentionAssistEnabled: false, larkOwnerMentionAssistOwnerId: "" });
    assert.equal((await restore(legacy)).statusCode, 200);
    assert.deepEqual(getAppSettings().larkOwnerMentionAssistBotIds, []);
  } finally { globalThis.fetch = fetch; Object.assign(config, previous); await app.close(); }
});
