import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const browserRequire = process.env.FORGE_QA_NODE_MODULES
  ? createRequire(path.join(process.env.FORGE_QA_NODE_MODULES, "forge-qa.cjs")) : require;
const { chromium } = browserRequire("playwright");
const { expect } = browserRequire("playwright/test");
const { build } = require("esbuild");
const webRoot = fileURLToPath(new URL("../", import.meta.url));
const outputDirectory = process.env.FORGE_QA_OUTPUT_DIR ?? await mkdtemp(path.join(tmpdir(), "forge-owner-mention-browser-"));
await mkdir(outputDirectory, { recursive: true });

// Bundle frontend modules only. No API config, runtime environment or database is loaded.
const bundled = await build({
  stdin: { contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { BrowserRouter } from 'react-router-dom';
    import { SettingsPage } from './src/pages/Settings';
    import { LarkPersonaDrawer } from './src/pages/LarkPersonaDrawer';
    import { PersonalInboxPage } from './src/pages/PersonalInbox';
    import './src/styles.css';
    const view = new URLSearchParams(location.search).get('view');
    createRoot(document.getElementById('root')).render(<BrowserRouter><main className="workspace">
      {view === 'settings' ? <SettingsPage /> : view === 'group' || view === 'p2p'
        ? <LarkPersonaDrawer chatId="oc_fixture" chatType={view === 'group' ? 'group' : 'p2p'} title="Fixture conversation" onClose={() => {}} />
        : <PersonalInboxPage />}
    </main></BrowserRouter>);
  `, resolveDir: webRoot, loader: "tsx", sourcefile: "owner-mention-browser-fixture.tsx" },
  bundle: true, write: false, outfile: "fixture.js", jsx: "automatic", format: "esm",
  define: { "process.env.NODE_ENV": '"production"' }
});
const files = new Map(bundled.outputFiles.map(file => [`/${path.basename(file.path)}`, file.contents]));
const html = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><title>Forge fixture QA</title></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>';
const serverRequests = [];
const server = createServer((request, response) => {
  const route = new URL(request.url, "http://fixture.test").pathname;
  serverRequests.push({ method: request.method, route });
  if (request.method !== "GET" || route.startsWith("/api/")) { response.writeHead(500); response.end("Unmocked request blocked"); return; }
  if (route === "/") { response.setHeader("Content-Type", "text/html; charset=utf-8"); response.end(html); return; }
  if (files.has(route)) { response.setHeader("Content-Type", route.endsWith(".css") ? "text/css" : "application/javascript"); response.end(files.get(route)); return; }
  response.writeHead(404); response.end();
});

function settingsFixture() {
  const appSettings = {
    autoReviewNewPulls: false, deploymentAdapterPath: "", issueRepairEnabled: false,
    larkMessageListenerEnabled: false, larkCodexRepliesEnabled: false, larkExecutionReceiptsEnabled: false,
    larkCodexModel: "fixture-model", larkCodexReasoningEffort: "low", larkStickerUsageMode: "natural",
    larkOwnerMentionAssistEnabled: false, larkOwnerMentionAssistOwnerId: "",
    larkTopicNativeModeEnabled: false,
    larkGroupSpontaneousRepliesEnabled: false, larkGroupSpontaneousReplyRate: 0.08,
    larkGroupSpontaneousReplyCooldownMs: 600000, larkGroupSpontaneousChatIds: [],
    larkTrustedExecutionEnabled: false, larkTurnAutoApprovalEnabled: false, larkTurnAutoApprovalModel: "fixture-model",
    larkTurnAutoApprovalDataSources: [], larkAcknowledgeReactionEmoji: "THUMBSUP",
    larkGroupMessageReactionEnabled: false, larkGroupMessageReactionEmoji: "THUMBSUP", larkGroupMessageReactionChatIds: [],
    larkGroupContextMessageLimit: 50, larkGroupContextMaxChars: 6000, pollIntervalMs: 600000
  };
  return {
    workspaceRoot: "", runtimeConfig: { workspaceRoot: "", giteaBaseUrl: "", giteaBaseUrls: [], giteaUser: "", larkExecutionApproverId: "ou_Approver1", trustedLarkCodexSenderIds: [] },
    setupComplete: true, bindHost: "127.0.0.1", giteaSync: { configured: false, missing: [], repos: [], repoCount: 0, userFilter: null },
    giteaCredential: { source: "missing", keychainAvailable: false }, pollIntervalMs: 600000, maxConcurrentCodexJobs: 0,
    codexModel: "fixture-model", codexReasoningEffort: "low", appSettings,
    larkSettingsKnown: Object.fromEntries(Object.keys(appSettings).map(key => [key, true])),
    larkMessageListener: { enabled: false, running: false, command: "", approvalRunning: false, approvalCommand: "", acknowledgeReactionEmoji: "THUMBSUP", acknowledgeReactionOptions: [] },
    runtimeStatus: { lastGiteaSyncAt: null, activeCodexJobs: 0, recentFailedJobs: 0, larkListenerRunning: false },
    larkCodexResponder: { transport: "app-server", running: false, activeTurns: 0, lastError: null, progressReminderMs: 0,
      model: "fixture-model", reasoningEffort: "low", reasoningEffortConfigurable: true, trustedExecutionConfigurable: true,
      turnAutoApprovalConfigurable: true, turnAutoApprovalModel: "fixture-model", turnAutoApprovalModelConfigurable: true,
      turnAutoApprovalDataSourcesConfigurable: true, sandbox: "read-only", approvalRecipientConfigured: true, trustedSenderCount: 0,
      native: { available: false, refreshedAt: null, configuredModelAvailable: null, models: [], skills: [], threads: [] } },
    prompts: Object.fromEntries(["larkAssistant", "prReview", "issueTriage", "issueImplementation"].map(key => [key, { value: "Fixture", defaultValue: "Fixture", customized: false }]))
  };
}

function assistFixture(id, status = "needs_owner", enabled = true) {
  return { id, lark_message_id: id, owner_id: "ou_Owner1", decision: "owner_required", status, enabled,
    reason: "Please confirm the proposed supplement", question: "May the bot add this response?", draft: `Proposed bot reply ${id}`, version: 3,
    content: `Original group request ${id}\nhttps://example.test/${"long-segment".repeat(20)}`,
    chat_id: "oc_FixtureGroup", chat_type: "group", sender_id: "ou_Requester1", message_id: `om_Original${id}`, thread_id: "om_Thread1",
    ownerResponses: [{ id: 101 + id, message_id: `om_OwnerReply${id}`, content: "Owner has already replied in the group", message_at: "2026-01-01T00:00:00Z", reply_to_message_id: `om_Original${id}` }] };
}

const report = { viewports: [], assertions: [], screenshots: [], blockedExternalRequests: [], serverClosed: false, browserClosed: false };
let browser;
try {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, ...(process.env.FORGE_QA_CHROMIUM ? { executablePath: process.env.FORGE_QA_CHROMIUM } : {}) });
  for (const viewport of [{ width: 1440, height: 1000, name: "desktop" }, { width: 375, height: 812, name: "narrow" }]) {
    const context = await browser.newContext({ viewport, serviceWorkers: "block" });
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    await page.clock.install();
    const pageErrors = [];
    const mockErrors = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    await context.addInitScript(() => localStorage.setItem("autofix.settings.section", JSON.stringify("automation")));
    const state = { settings: settingsFixture(), supported: true, ignoreSettingPatch: false, failAssists: false,
      group: { stickerUsage: { mode: "natural", effectiveMode: "natural", globalMode: "natural" },
        spontaneousReply: { mode: "global", globalEnabled: false, globallyAllowed: false, effectiveEnabled: false,
          replyRate: 0.08, cooldownMs: 600000, effectiveReplyRate: 0.08, effectiveCooldownMs: 600000, globalReplyRate: 0.08, globalCooldownMs: 600000 },
        ownerMentionAssist: { mode: "global", globalEnabled: false, effectiveEnabled: false, ownerId: "ou_Owner1" } },
      items: [assistFixture(7), assistFixture(8, "ready"), assistFixture(9, "needs_owner", false), assistFixture(10, "handling"), assistFixture(11, "reconsidering", false)], calls: [] };
    await context.route("**/*", async route => {
      try {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== origin) { report.blockedExternalRequests.push(url.origin); await route.abort(); return; }
      if (!url.pathname.startsWith("/api/")) { await route.continue(); return; }
      const method = request.method(), body = request.postDataJSON();
      state.calls.push({ path: url.pathname, method, body });
      const respond = (value, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
      if (url.pathname === "/api/settings") {
        if (method === "PATCH") {
          assert.ok(Object.keys(body).every(key => ["larkOwnerMentionAssistEnabled", "larkOwnerMentionAssistOwnerId", "larkTopicNativeModeEnabled"].includes(key)));
          if (!state.ignoreSettingPatch) Object.assign(state.settings.appSettings, body);
          return respond(state.settings.appSettings);
        }
        const value = structuredClone(state.settings);
        if (!state.supported) { delete value.larkSettingsKnown; delete value.appSettings.larkOwnerMentionAssistEnabled; delete value.appSettings.larkOwnerMentionAssistOwnerId; }
        return respond(value);
      }
      if (url.pathname === "/api/lark/chats/oc_fixture/settings") {
        if (method === "PATCH") {
          assert.deepEqual(Object.keys(body), ["ownerMentionAssistMode"]);
          state.group.ownerMentionAssist.mode = body.ownerMentionAssistMode;
          state.group.ownerMentionAssist.effectiveEnabled = body.ownerMentionAssistMode === "on";
        }
        const value = structuredClone(state.group); if (!state.supported) delete value.ownerMentionAssist;
        return respond(value);
      }
      if (url.pathname === "/api/lark/chats/oc_fixture/persona") return respond({ persona: { mode: "default", name: "", instructions: "", version: 1, updatedAt: null } });
      if (url.pathname === "/api/lark/conversations/oc_fixture/sessions") return respond({ active: [], previous: [] });
      if (url.pathname === "/api/personal-inbox" && method === "GET") return respond({ status: { enabled: false, autoReply: false, busy: false, activatedAt: "", lastSyncAt: "", canSend: false, lastError: null },
        messages: [{ id: 1, chatType: "p2p", chatName: "Fixture", senderName: "Fixture sender", content: "Legacy inbox remains available", sourceTime: "2026-01-01", status: "needs_owner", draft: "Legacy draft", summary: "", question: "", error: null, version: 1 }] });
      if (url.pathname === "/api/owner-mention-assists") return state.failAssists ? respond({ error: "Fixture unavailable" }, 503) : respond({ items: state.items });
      const decision = url.pathname.match(/^\/api\/owner-mention-assists\/(\d+)\/decision$/);
      if (decision && method === "POST") {
        assert.ok(Object.keys(body).every(key => ["action", "text", "version"].includes(key)));
        const item = state.items.find(item => item.id === Number(decision[1]));
        if (body.version !== item.version) return respond({ error: "Version changed: refresh required" }, 409);
        assert.equal(item.status, "needs_owner"); assert.equal(item.enabled, true);
        if (body.text !== undefined) item.draft = body.text;
        item.status = body.action === "send" ? "ready" : "dismissed"; item.version++;
        return respond({ item });
      }
      if (method === "GET") {
        const fixtures = {
          "/api/settings/diagnostics": [], "/api/settings/repositories/discover": [],
          "/api/settings/launchd": { supported: false }, "/api/settings/local-data": {}, "/api/settings/audit": [],
          "/api/lark/models": { models: [{ id: "fixture-model", displayName: "Fixture model", efforts: ["low"], inputModalities: ["text"] }] }
        };
        if (Object.hasOwn(fixtures, url.pathname)) return respond(fixtures[url.pathname]);
      }
      throw new Error(`Unrecognized fixture API: ${method} ${url.pathname}`);
      } catch (error) {
        mockErrors.push(String(error));
        await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Fixture contract failed" }) });
      }
    });
    const note = text => { report.assertions.push(`${viewport.name}: ${text}`); console.log(`${viewport.name}: ${text}`); };
    const screenshot = async name => {
      const filename = path.join(outputDirectory, `${viewport.name}-${name}.png`);
      await page.screenshot({ path: filename, animations: "disabled" }); report.screenshots.push(filename);
    };
    const checkOverflow = async (name, scope) => {
      const result = await page.evaluate(selector => {
        const elements = [...document.querySelectorAll(selector)].flatMap(root => [root, ...root.querySelectorAll("input,textarea,button,p,small,strong,label")]);
        return { width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
          outside: elements.filter(el => { const box = el.getBoundingClientRect(); return box.width > 0 && (box.left < -1 || box.right > innerWidth + 1); }).map(el => ({ tag: el.tagName, text: el.textContent?.slice(0, 60) })) };
      }, scope);
      assert.ok(result.scrollWidth <= result.width + 1, `${name}: page overflow ${JSON.stringify(result)}`);
      assert.deepEqual(result.outside, [], `${name}: controls outside viewport`);
      note(`${name}: no horizontal page/control overflow (${result.width}px)`);
    };

    await page.goto(`${origin}/?view=settings`);
    const toggle = page.getByRole("checkbox", { name: "协同处理群里 @本人的消息", exact: true });
    const owner = page.getByLabel("被 @对象 open_id", { exact: true });
    const saveOwner = page.getByRole("button", { name: "保存协同对象", exact: true });
    const topic = page.getByRole("checkbox", { name: "话题原生会话模式", exact: true });
    await expect(topic).not.toBeChecked(); await expect(topic).toBeEnabled();
    await page.getByText("话题原生会话模式", { exact: true }).click();
    await expect(topic).toBeChecked(); await expect(topic).toBeEnabled();
    assert.equal(state.settings.appSettings.larkTopicNativeModeEnabled, true);
    await page.reload(); await expect(topic).toBeChecked();
    await page.getByText("话题原生会话模式", { exact: true }).click();
    await expect(topic).not.toBeChecked(); await expect(topic).toBeEnabled();
    await topic.scrollIntoViewIfNeeded(); await screenshot("native-topic-settings");
    note("native topic defaults off, toggles with confirmed readback and survives page reload");
    await expect(toggle).not.toBeChecked();
    await page.getByText("协同处理群里 @本人的消息", { exact: true }).click();
    await expect(toggle).toBeChecked(); await expect(toggle).toBeEnabled();
    assert.equal(state.settings.appSettings.larkOwnerMentionAssistEnabled, true);
    await owner.fill("ou_invalid_id"); await expect(saveOwner).toBeDisabled();
    await owner.fill("ou_invalid-id"); await expect(saveOwner).toBeDisabled();
    await owner.fill("ou_Test123"); await saveOwner.click(); await expect(saveOwner).toBeDisabled();
    assert.equal(state.settings.appSettings.larkOwnerMentionAssistOwnerId, "ou_Test123");
    await owner.fill(""); await saveOwner.click(); await expect(saveOwner).toBeDisabled();
    assert.equal(state.settings.appSettings.larkOwnerMentionAssistOwnerId, "");
    await owner.fill("ou_Test123"); await saveOwner.click(); await expect(saveOwner).toBeDisabled();
    await owner.scrollIntoViewIfNeeded();
    await checkOverflow("global settings", ".settingsField:has(#ownerMentionAssistOwnerId), .toggleRow");
    await screenshot("global-settings"); note("global switch, strict alphanumeric open_id, empty fallback and GET readback succeed");
    state.supported = false; await page.reload();
    await expect(topic).toBeDisabled();
    await expect(toggle).toBeDisabled(); await expect(owner).toBeDisabled();
    await expect(page.getByText("群聊协同状态未知，当前 API / Agent 不可配置。", { exact: true })).toBeVisible();
    note("legacy API disables new settings and retains existing settings page");
    state.supported = true; state.settings.appSettings.larkOwnerMentionAssistEnabled = false; state.ignoreSettingPatch = true;
    await page.reload(); await page.getByText("协同处理群里 @本人的消息", { exact: true }).click();
    await expect(page.locator(".error")).toContainText("群聊协同配置未确认");
    await expect(toggle).not.toBeChecked(); note("ignored global PATCH is not reported as saved"); state.ignoreSettingPatch = false;
    state.ignoreSettingPatch = true;
    await page.getByText("话题原生会话模式", { exact: true }).click();
    await expect(page.locator(".error")).toContainText("话题模式配置未确认");
    await expect(topic).not.toBeChecked(); state.ignoreSettingPatch = false;

    await page.goto(`${origin}/?view=group`);
    const groupMode = page.getByRole("radiogroup", { name: "群聊协同模式", exact: true });
    await expect(groupMode.getByRole("radio", { name: "跟随全局", exact: true })).toHaveAttribute("aria-checked", "true");
    const originalPolicies = structuredClone({ stickerUsage: state.group.stickerUsage, spontaneousReply: state.group.spontaneousReply });
    for (const [mode, label] of [["on", "开启"], ["off", "关闭"], ["global", "跟随全局"]]) {
      const before = state.calls.length;
      const radio = groupMode.getByRole("radio", { name: label, exact: true });
      await radio.click(); await expect(radio).toHaveAttribute("aria-checked", "true"); await expect(radio).toBeEnabled();
      assert.equal(state.group.ownerMentionAssist.mode, mode);
      await expect(groupMode.locator("..")).toContainText(mode === "on" ? "当前开启 · 全局关闭" : "当前关闭 · 全局关闭");
      assert.deepEqual(state.calls.slice(before).filter(call => call.path === "/api/lark/chats/oc_fixture/settings").map(call => call.method), ["PATCH", "GET"]);
    }
    assert.deepEqual({ stickerUsage: state.group.stickerUsage, spontaneousReply: state.group.spontaneousReply }, originalPolicies);
    await groupMode.scrollIntoViewIfNeeded(); await checkOverflow("group tri-state", ".conversationSettingSection:has([aria-label='群聊协同模式'])");
    await screenshot("group-modes"); note("group on/off/global roundtrips; sticker/spontaneous policies unchanged");
    state.supported = false; await page.reload();
    await expect(groupMode.getByRole("radio", { name: "开启", exact: true })).toBeDisabled();
    await expect(page.getByRole("radiogroup", { name: "群聊随机插话模式" }).getByRole("radio", { name: "开启", exact: true })).toBeEnabled();
    state.supported = true; await page.goto(`${origin}/?view=p2p`); await expect(groupMode).toHaveCount(0);
    note("unsupported group assist does not disable other policies; p2p has no group assist controls");

    await page.goto(`${origin}/?view=inbox`);
    const section = page.getByRole("region", { name: "群聊协同待确认", exact: true });
    const card = id => section.locator("article").filter({ hasText: `Original group request ${id}\n` });
    await expect(card(7).getByText("Owner has already replied in the group", { exact: true })).toBeVisible();
    await expect(card(7).getByText("原因：Please confirm the proposed supplement", { exact: true })).toBeVisible();
    await expect(card(8).getByText("已确认待投递", { exact: true })).toBeVisible();
    for (const id of [8, 9, 10, 11]) {
      await expect(card(id).getByRole("button", { name: "确认机器人发送", exact: true })).toHaveCount(0);
      await expect(card(id).getByRole("button", { name: "忽略", exact: true })).toHaveCount(0);
      await expect(card(id).locator("textarea")).toHaveCount(0);
    }
    await card(7).getByLabel("机器人回复草稿").fill("Edited fixture supplement");
    await card(7).scrollIntoViewIfNeeded(); await checkOverflow("private drafts", ".ownerMentionAssists");
    await screenshot("private-draft"); note("original, owner reply, reason and edited draft render; ready/active native turn/handling/reconsidering cannot be reviewed");
    state.items.find(item => item.id === 7).enabled = false;
    await page.clock.fastForward(11000);
    await expect(card(7).getByRole("button", { name: "确认机器人发送", exact: true })).toHaveCount(0);
    await expect(card(7).getByRole("button", { name: "忽略", exact: true })).toHaveCount(0);
    state.items.find(item => item.id === 7).enabled = true;
    await page.clock.fastForward(11000);
    await expect(card(7).getByRole("button", { name: "确认机器人发送", exact: true })).toBeEnabled();
    await expect(card(7).getByLabel("机器人回复草稿")).toHaveValue("Edited fixture supplement");
    note("polling enabled=false immediately removes review actions; turn completion re-enables needs_owner without losing edits");
    await card(7).getByRole("button", { name: "确认机器人发送", exact: true }).click();
    await expect(card(7).getByText("已确认待投递", { exact: true })).toBeVisible();
    await expect(card(7).getByRole("button", { name: "确认机器人发送", exact: true })).toHaveCount(0);
    await expect(card(7).getByRole("alert")).toHaveCount(0);
    assert.deepEqual(state.calls.filter(call => call.method === "POST").at(-1), { path: "/api/owner-mention-assists/7/decision", method: "POST", body: { action: "send", text: "Edited fixture supplement", version: 3 } });
    note("human send accepts ready response as confirmed, not delivered; correct independent endpoint and version");
    const current = state.items.find(item => item.id === 7);
    current.status = "needs_owner"; current.version = 5; current.draft = "Draft before new group response";
    await section.getByRole("button", { name: "刷新群聊协同", exact: true }).click();
    await expect(card(7).getByLabel("机器人回复草稿")).toHaveValue(current.draft);
    await card(7).getByLabel("机器人回复草稿").fill("Stale edited draft");
    current.version = 6; current.draft = "Fresh draft with owner update";
    current.ownerResponses.push({ id: 999, message_id: "om_OwnerUpdate", content: "A new owner response", message_at: "2026-01-01T00:01:00Z", reply_to_message_id: "om_Original7" });
    await card(7).getByRole("button", { name: "确认机器人发送", exact: true }).click();
    await expect(card(7).getByRole("alert")).toContainText("请刷新记录后重新确认");
    await expect(card(7).getByRole("button", { name: "确认机器人发送", exact: true })).toBeDisabled();
    await expect(card(7).getByRole("button", { name: "忽略", exact: true })).toBeDisabled();
    assert.equal(current.status, "needs_owner"); assert.equal(current.draft, "Fresh draft with owner update");
    await card(7).scrollIntoViewIfNeeded(); await screenshot("version-conflict");
    await section.getByRole("button", { name: "刷新群聊协同", exact: true }).click();
    await expect(card(7).getByLabel("机器人回复草稿")).toHaveValue("Fresh draft with owner update");
    await expect(card(7).getByText("A new owner response", { exact: true })).toBeVisible();
    await expect(card(7).getByRole("button", { name: "确认机器人发送", exact: true })).toBeEnabled();
    await card(7).getByRole("button", { name: "忽略", exact: true }).click(); await expect(card(7)).toHaveCount(0);
    assert.equal(current.status, "dismissed");
    note("409 preserves server draft, locks both actions; refresh loads version 6/new owner response; dismiss succeeds");
    state.failAssists = true; await section.getByRole("button", { name: "刷新群聊协同", exact: true }).click();
    await expect(section.getByRole("alert")).toContainText("群聊协同暂不可用");
    await expect(page.getByText("Legacy inbox remains available", { exact: true })).toBeVisible();
    assert.equal(state.calls.some(call => call.method !== "GET" && call.path.startsWith("/api/personal-inbox")), false);
    note("assist loading failure preserves legacy inbox; no legacy decision mutation occurred");
    assert.deepEqual(pageErrors, []); assert.deepEqual(mockErrors, []); report.viewports.push(viewport); await context.close();
  }
  assert.deepEqual(report.blockedExternalRequests, []);
  assert.equal(serverRequests.some(request => request.route.startsWith("/api/") || request.method !== "GET"), false);
} finally {
  if (browser) { await browser.close(); report.browserClosed = true; }
  if (server.listening) { await new Promise(resolve => server.close(resolve)); report.serverClosed = true; }
  await writeFile(path.join(outputDirectory, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
}
console.log(JSON.stringify({ ...report, report: path.join(outputDirectory, "report.json") }, null, 2));
