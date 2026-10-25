import assert from "node:assert/strict";
import Fastify from "fastify";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { CodexAppServerClient, codexAppServerArgs, codexAppServerStderrError } from "./codexAppServer.js";
import { resolveCodexExecutable } from "./codexExecutable.js";
import { codexSessionIdFromInput } from "./codexSessions.js";
import { configurablePrompt, configurablePromptSettings } from "./promptSettings.js";
import {
  buildInteractiveCodexArgs,
  buildCodexJobThreadParams,
  buildPrReviewContext,
  buildTriageContext,
  codexSessionDiagnostics,
  extractCodexSessionIdFromJsonl,
  isCodexHookTrustPrompt,
  isCodexAppServerActiveWriterError,
  isCodexRecoveryGraceElapsed,
  isCodexSessionStalled,
  isAutoFixSessionForTask,
  lastCodexJsonlTimestamp,
  preparedReviewPackageContext,
  promptTemplatePath,
  reconcilePrReviewRunArtifacts,
  reviewRunOutcomeFromArtifacts
} from "./codexRunner.js";
import {
  buildLarkCodexPrompt,
  buildLarkCodexDeltaPrompt,
  extractLarkReplyMedia,
  buildLarkCodexThreadParams,
  buildLarkCodexUserInput,
  approvalRequestDetails,
  extractAgentMessageEventsFromCodexJsonl,
  extractAgentMessageFromCodexJsonLine,
  extractStreamableAgentMessageEventsFromCodexJsonl,
  formatLarkApprovalBatchOperation,
  formatRecentLarkMessages,
  larkFileResourcesFromMessage,
  larkImageResourceFromMessage,
  larkCodexCompletedMessageEvent,
  larkCodexTaskPaths,
  larkCodexTerminalStatus,
  isLarkBotSender,
  formatLarkFinalReply,
  trustedLarkCodexSenderIds,
  isLarkCodexAuthenticationFailure,
  isLarkNoReplyDecision,
  larkCwdRecoveryStrategy,
  loadLarkGroupContext,
  loadRecentLarkChatMessages,
  readLarkCodexAnswer,
  reconcileOrphanedLarkCodexRuns,
  sanitizeLarkCodexReply,
  decideLarkExecutionApprovalFromCard,
  shouldRetryLarkTurnWithoutCwd,
  shouldRecoverLarkStartupStall,
  shouldReuseLarkTurnApproval
} from "./larkCodexResponder.js";
import { buildLarkExecutionApprovalCard, buildLarkExecutionApprovalResultCard, buildLarkImagePostReplyArgs, buildLarkMediaReplyArgs, buildLarkReactionArgs, larkAtTag, larkReplyIdempotencyKey } from "./larkReply.js";
import { isAtMeMessage, larkBotOpenIdFromAuthStatus, parseLarkExecutionApprovalAction, shouldStartSpontaneousLarkReply } from "./larkWorker.js";
import { larkReactionEmojiTypes } from "./larkReactionEmojis.js";
import {
  acquireRepoSetupLock,
  assertTestDatabaseIsolation,
  cleanupExpiredRepoSetupLocks,
  db,
  getAppSettings,
  migrate,
  releaseRepoSetupLock,
  setAppSettingValue,
  updateAppSettings,
  type RepairJobRow
} from "./db.js";
import { syncGiteaIssues } from "./gitea.js";
import { remoteMatchesConfiguredGitea } from "./localRepos.js";
import { findLarkContactByAlias, larkContactAliases, larkContactSearchFromCliOutput, upsertLarkContact } from "./larkContacts.js";
import { issueRoutes } from "./routes/issues.js";
import { jobRoutes } from "./routes/jobs.js";
import { stickerRoutes } from "./routes/stickers.js";
import { todoRoutes } from "./routes/todos.js";
import { detectStickerImage, ensureLarkStickerSelection, larkStickerPrompt, listLarkStickers, stageLarkStickerSelection } from "./larkStickers.js";
import { taskPackageSummary } from "./taskPackages.js";
import { nowIso } from "./time.js";
import { registerForgeLarkAgentCapabilities } from "./larkAgentIntegration.js";
import { larkAppSettingFields, larkAppSettingsPatch, larkRuntimeSettingsSchema, syncLarkRuntimeSettings } from "./larkRuntimeSettingsSync.js";
import { persistedRuntimeConfig, updatePersistedRuntimeConfig } from "./db.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function resetTables(): void {
  assertTestDatabaseIsolation(config.databasePath);
  migrate();
  config.giteaFullSyncIntervalMs = 0;
  config.giteaSearchSyncLookbackMs = 0;
  db.exec(`
    DELETE FROM lark_execution_approvals;
    DELETE FROM lark_sticker_sends;
    DELETE FROM lark_messages;
    DELETE FROM lark_stickers;
    DELETE FROM lark_codex_sessions;
    DELETE FROM lark_group_context_cursors;
    DELETE FROM lark_contact_aliases;
    DELETE FROM lark_contacts;
    DELETE FROM codex_todos;
    DELETE FROM notifications;
    DELETE FROM pr_review_runs;
    DELETE FROM job_events;
    DELETE FROM repair_jobs;
    DELETE FROM issues;
    DELETE FROM repo_setup_locks;
    DELETE FROM app_settings;
    DELETE FROM local_audit_events;
  `);
}

// Keep existing approval fixtures focused on approval behavior with a modern runtime.
function withRuntimeSettings(fetcher: typeof fetch): typeof fetch {
  const { turnAutoApprovalEnabled: _enabled, turnAutoApprovalModel: _model, ...settings } = larkAppSettingsPatch(getAppSettings());
  let runtime: Record<string, unknown> = { ...settings, workspaceRoot: config.workspaceRoot, trustedExecutionEnabled: false, approverId: "", trustedSenderIds: [] };
  return async (url, init) => {
    if (String(url).endsWith("/v1/settings")) {
      if (init?.method === "PATCH") {
        const patch = JSON.parse(String(init.body));
        const response = await fetcher(url, init);
        if (!response.ok) return response;
        const body = await response.json() as Record<string, unknown> | null;
        runtime = { ...runtime, ...Object.fromEntries(Object.entries(patch).filter(([key]) => Object.hasOwn(runtime, key))) };
        // Keep deliberate bad/missing echoes intact so failure cases remain meaningful.
        return new Response(JSON.stringify(body && Object.keys(body).length > 0 ? { ...runtime, ...body } : body));
      } else {
        const response = await fetcher(url, init);
        if (response.ok) return new Response(JSON.stringify({ ...runtime, ...await response.json() as object }));
        return response;
      }
    }
    return fetcher(url, init);
  };
}

test("test database is isolated from persistent runtime data", () => {
  assert.match(config.databasePath, /agent-forge-api-test-[^/]+\/test\.sqlite$/);
  assert.doesNotThrow(() => assertTestDatabaseIsolation(config.databasePath));
  assert.throws(
    () => assertTestDatabaseIsolation(path.join(repoRoot, "apps", "api", "data", "autofix.sqlite")),
    /Refusing to open a non-isolated database/
  );
});

test("Codex session inputs accept thread deep links without storing the URL", () => {
  const sessionId = "01a06680-be7e-7430-9983-d90376a82dde";
  assert.equal(codexSessionIdFromInput(sessionId), sessionId);
  assert.equal(codexSessionIdFromInput(`codex://threads/${sessionId}`), sessionId);
  assert.equal(codexSessionIdFromInput(` codex://threads/${sessionId}/ `), sessionId);
  assert.equal(codexSessionIdFromInput("https://example.com/threads/invalid"), null);
  assert.equal(codexSessionIdFromInput("codex://threads/not-a-session"), null);
});

test("migration is idempotent", () => {
  migrate();
  migrate();
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>;
  assert.deepEqual(
    tables.map((table) => table.name).filter((name) => !name.startsWith("sqlite_")),
    ["app_settings", "codex_todos", "issues", "job_events", "lark_codex_sessions", "lark_contact_aliases", "lark_contacts", "lark_execution_approvals", "lark_group_context_cursors", "lark_messages", "lark_sticker_sends", "lark_stickers", "local_audit_events", "notifications", "pr_review_runs", "repair_jobs", "repo_setup_locks"]
  );
  const sessionColumns = db.prepare("PRAGMA table_info(lark_codex_sessions)").all() as Array<{ name: string }>;
  assert.deepEqual(sessionColumns.map((column) => column.name), ["session_key", "chat_id", "trust_scope", "codex_session_id", "created_at", "updated_at"]);
});

test("Lark contacts store aliases for later directed sends", () => {
  resetTables();
  assert.deepEqual(larkContactAliases("林小夏（测试）"), ["林小夏（测试）", "测试", "林小夏"]);
  upsertLarkContact({
    openId: "ou_exampleowner",
    userId: "user_exampleowner",
    name: "林小夏（测试）",
    enterpriseEmail: "example@example.com",
    department: "研发部",
    p2pChatId: "oc_exampleowner",
    hasChatted: true,
    source: "test"
  });
  assert.equal(findLarkContactByAlias("林小夏")?.open_id, "ou_exampleowner");
  assert.equal(findLarkContactByAlias("测试")?.p2p_chat_id, "oc_exampleowner");
  assert.equal(findLarkContactByAlias("example")?.name, "林小夏（测试）");
});

test("Lark chatted-contact search parses CLI output and reports more matches", () => {
  const page = larkContactSearchFromCliOutput(JSON.stringify({
    code: 0,
    data: {
      has_more: true,
      users: [{ open_id: "ou_a", name: "林小夏" }]
    }
  }));
  assert.equal(page.users.length, 1);
  assert.equal(page.hasMore, true);
  assert.throws(
    () => larkContactSearchFromCliOutput(JSON.stringify({ ok: false, error: { message: "missing scope" } })),
    /missing scope/
  );
});

test("Todo API supports manual Codex todos and status updates", async () => {
  resetTables();
  const app = Fastify({ logger: false });
  const completedTaskDir = fs.mkdtempSync(path.join(os.tmpdir(), "autofix-archived-todo-"));
  fs.writeFileSync(path.join(completedTaskDir, "done"), "");
  await app.register(todoRoutes);
  try {
    const created = await app.inject({
      method: "POST",
      url: "/api/todos",
      payload: {
        title: "整理 Codex 会话",
        description: "跟进修复进度",
        codexSessionId: "019f402f-fd28-75e2-af27-53fa2a0c70da",
        codexTaskDir: completedTaskDir
      }
    });
    assert.equal(created.statusCode, 201);
    const todo = JSON.parse(created.body);
    assert.equal(todo.status, "todo");
    assert.equal(todo.source_type, "manual");
    assert.equal(todo.codex_thread_url, "codex://threads/019f402f-fd28-75e2-af27-53fa2a0c70da");
    assert.equal(todo.runner_state, "completed");

    const updated = await app.inject({
      method: "PATCH",
      url: `/api/todos/${todo.id}`,
      payload: { status: "monitoring" }
    });
    assert.equal(updated.statusCode, 200);
    assert.equal(JSON.parse(updated.body).status, "monitoring");

    const archived = await app.inject({
      method: "PATCH",
      url: `/api/todos/${todo.id}`,
      payload: { status: "archived" }
    });
    assert.equal(archived.statusCode, 200);
    assert.equal(JSON.parse(archived.body).runner_state, "unknown");
    assert.equal(JSON.parse(archived.body).codex_unread, false);

    const duplicate = await app.inject({
      method: "POST",
      url: "/api/todos",
      payload: {
        title: "重复会话",
        codexSessionId: "019f402f-fd28-75e2-af27-53fa2a0c70da"
      }
    });
    assert.equal(duplicate.statusCode, 409);

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/todos/${todo.id}`
    });
    assert.equal(removed.statusCode, 204);

    const list = await app.inject({
      method: "GET",
      url: "/api/todos"
    });
    assert.equal(JSON.parse(list.body).length, 0);
  } finally {
    await app.close();
    fs.rmSync(completedTaskDir, { recursive: true, force: true });
  }
});

test("Forge host capability endpoint delegates todo creation", async () => {
  resetTables();
  const previousToken = config.larkAgentHostToken;
  config.larkAgentHostToken = "test-host-token";
  const app = Fastify({ logger: false });
  await app.register(todoRoutes);
  await app.register(issueRoutes);
  try {
    const denied = await app.inject({ method: "POST", url: "/api/lark-agent/capabilities/forge.todo.create", payload: { input: { title: "denied" } } });
    assert.equal(denied.statusCode, 401);
    const response = await app.inject({ method: "POST", url: "/api/lark-agent/capabilities/forge.todo.create", headers: { authorization: "Bearer test-host-token" }, payload: { input: { title: "来自 Lark Agent 的待办" } } });
    assert.equal(response.statusCode, 201);
    assert.equal((response.json() as { title: string }).title, "来自 Lark Agent 的待办");
    assert.equal((response.json() as { _receipt: { status: string } })._receipt.status, "verified");
  } finally { config.larkAgentHostToken = previousToken; await app.close(); }
});

test("deployment uses only an explicitly configured local adapter and never invents verification", async () => {
  resetTables();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "forge-deployment-adapter-"));
  const previousConfig = { ...config };
  config.workspaceRoot = root; config.larkAgentHostToken = "fixture-host-token";
  const app = Fastify({ logger: false }); await app.register(issueRoutes);
  const headers = { authorization: "Bearer fixture-host-token" };
  const invoke = (action: string) => app.inject({ method: "POST", url: `/api/lark-agent/capabilities/forge.deploy.${action}`, headers,
    payload: { input: { repo: "demo", apps: ["demo"], expectedRevision: "a".repeat(40), timeout: 30 } } });
  try {
    assert.equal((await invoke("inspect")).statusCode, 409);
    const script = path.join(root, "adapter.mjs");
    updateAppSettings({ deploymentAdapterPath: script });
    fs.writeFileSync(script, 'console.log(JSON.stringify({result:"inspected",args:process.argv.slice(2)}));');
    const inspected = await invoke("inspect"); assert.equal(inspected.statusCode, 200, inspected.body);
    assert.equal(inspected.json().args.includes("--execute"), false);
    assert.equal(inspected.json()._receipt.status, "queried");
    fs.writeFileSync(script, 'console.log(JSON.stringify({result:"deployed"}));');
    assert.equal((await invoke("production")).json()._receipt.status, "executed");
    fs.writeFileSync(script, 'console.log(JSON.stringify({result:"deployed",fresh:true,args:process.argv.slice(2)}));');
    const deployed = await invoke("production"); assert.equal(deployed.statusCode, 200, deployed.body);
    assert.equal(deployed.json()._receipt.status, "verified"); assert.equal(deployed.json().args.includes("--execute"), true);
    fs.writeFileSync(script, 'console.log("plain text is not verification");');
    assert.equal((await invoke("production")).statusCode, 409);
    updateAppSettings({ deploymentAdapterPath: "" }); assert.equal((await invoke("production")).statusCode, 409);
  } finally { Object.assign(config, previousConfig); await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("issue repair job creation creates a Codex todo", async () => {
  resetTables();
  const app = Fastify({ logger: false });
  await app.register(issueRoutes);
  await app.register(todoRoutes);
  try {
    const now = nowIso();
    const issueId = Number(db.prepare(`
      INSERT INTO issues (
        source, external_id, kind, repo_owner, repo_name, title, body, url, state,
        assignee, author, reviewers, labels, head_sha, status, created_at, updated_at
      )
      VALUES ('gitea', '42', 'issue', 'acme', 'api', '修复登录失败', 'body', 'https://git.example/acme/api/issues/42', 'open',
        'codex', 'teammate', '[]', '[]', NULL, 'open', ?, ?)
    `).run(now, now).lastInsertRowid);

    const response = await app.inject({
      method: "POST",
      url: `/api/issues/${issueId}/repair`,
      payload: { mode: "issue_triage", repoHint: "api" }
    });
    assert.equal(response.statusCode, 200);
    const job = JSON.parse(response.body) as RepairJobRow;

    const todos = JSON.parse((await app.inject({ method: "GET", url: "/api/todos" })).body);
    assert.equal(todos.length, 1);
    assert.equal(todos[0].source_type, "issue_repair");
    assert.equal(todos[0].source_id, String(job.id));
    assert.equal(todos[0].job_id, job.id);
    assert.equal(todos[0].issue_id, issueId);
    assert.equal(todos[0].status, "todo");
    assert.match(todos[0].title, /Issue #42/);
    assert.equal(todos[0].issue_repo_owner, "acme");
    assert.equal(todos[0].runner_state, "unknown");

    db.prepare("UPDATE repair_jobs SET status = 'running' WHERE id = ?").run(job.id);
    const runningTodos = JSON.parse((await app.inject({ method: "GET", url: "/api/todos" })).body);
    assert.equal(runningTodos[0].runner_state, "running");

    db.prepare("UPDATE repair_jobs SET status = 'done' WHERE id = ?").run(job.id);
    const completedTodos = JSON.parse((await app.inject({ method: "GET", url: "/api/todos" })).body);
    assert.equal(completedTodos[0].runner_state, "completed");
  } finally {
    await app.close();
  }
});

test("Gitea sync upserts assigned issues and autofix-labelled pull requests", async () => {
  resetTables();
  config.giteaBaseUrl = "https://git.example";
  config.giteaToken = "test";
  config.giteaUser = "codex";
  config.giteaRepos = [{ owner: "acme", name: "api" }];
  const originalFetch = globalThis.fetch;

  try {
    let call = 0;
    globalThis.fetch = async (input) => {
      const url = String(input);
      call += 1;
      if (url.includes("/pulls/8")) {
        return new Response(
          JSON.stringify({
            number: 8,
            title: "Review stuck PR",
            body: "please review @codex",
            html_url: "https://git.example/acme/api/pulls/8",
            state: "open",
            user: { login: "teammate" },
            head: { sha: "sha-pr-8" },
            requested_reviewers: [{ login: "codex" }],
            labels: []
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/pulls/10")) {
        return new Response(
          JSON.stringify({
            number: 10,
            title: "Review by someone else",
            body: "not for this user",
            html_url: "https://git.example/acme/api/pulls/10",
            state: "open",
            user: { login: "teammate" },
            head: { sha: "sha-pr-10" },
            requested_reviewers: [{ login: "someone-else" }],
            labels: []
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/pulls/11")) {
        return new Response(
          JSON.stringify({
            number: 11,
            title: "Authored by current user",
            body: "my own PR",
            html_url: "https://git.example/acme/api/pulls/11",
            state: "open",
            user: { login: "codex" },
            head: { sha: "sha-pr-11" },
            requested_reviewers: [],
            labels: []
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/issues/comments")) {
        return new Response(
          JSON.stringify([
            {
              id: 1001,
              issue_url: "https://git.example/api/v1/repos/acme/api/issues/7",
              body: "ping @codex for details",
              user: { login: "teammate" }
            },
            {
              id: 1002,
              issue_url: "https://git.example/api/v1/repos/acme/api/issues/10",
              body: "ping @someone-else",
              user: { login: "teammate" }
            }
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/pulls?")) {
        return new Response(
          JSON.stringify([
            {
              number: 8,
              title: "Review stuck PR",
              html_url: "https://git.example/acme/api/pulls/8",
              state: "open",
              labels: []
            },
            {
              number: 10,
              title: "Review by someone else",
              html_url: "https://git.example/acme/api/pulls/10",
              state: "open",
              labels: []
            },
            {
              number: 11,
              title: "Authored by current user",
              html_url: "https://git.example/acme/api/pulls/11",
              state: "open",
              labels: []
            }
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify([
          {
            number: 7,
            title: "Repair encoder",
            body: "fails on empty payload @codex",
            html_url: "https://git.example/acme/api/issues/7",
            state: "open",
            assignees: [{ login: "codex" }],
            labels: [{ name: "bug" }]
          },
          {
            number: 9,
            title: "Ignore unrelated",
            assignees: [{ login: "someone-else" }],
            labels: []
          }
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };
    const first = await syncGiteaIssues();
    const second = await syncGiteaIssues();
    assert.equal(call, 12);
    assert.equal(first.scanned, 5);
    assert.equal(first.upserted, 4);
    assert.equal(first.filtered, 1);
    assert.equal(first.commentsScanned, 2);
    assert.equal(first.mentionsNotified, 3);
    assert.equal(second.scanned, 5);
    assert.equal(second.upserted, 4);
    assert.equal(second.filtered, 1);
    assert.equal(second.commentsScanned, 2);
    assert.equal(second.mentionsNotified, 0);
    assert.equal(first.autoReviewJobsStarted, 0);
    assert.equal(second.autoReviewJobsStarted, 0);
    const rows = db.prepare("SELECT kind, external_id, title, head_sha FROM issues ORDER BY CAST(external_id AS INTEGER)").all();
    assert.deepEqual(rows, [
      { kind: "issue", external_id: "7", title: "Repair encoder", head_sha: null },
      { kind: "pr", external_id: "8", title: "Review stuck PR", head_sha: "sha-pr-8" },
      { kind: "pr", external_id: "10", title: "Review by someone else", head_sha: "sha-pr-10" },
      { kind: "pr", external_id: "11", title: "Authored by current user", head_sha: "sha-pr-11" }
    ]);
    const notifications = db.prepare("SELECT type, title FROM notifications ORDER BY id").all();
    assert.deepEqual(notifications, [
      { type: "new_issue", title: "New ISSUE acme/api#7" },
      { type: "mention", title: "Mentioned in ISSUE acme/api#7" },
      { type: "new_pr", title: "New PR acme/api#8" },
      { type: "mention", title: "Mentioned in PR acme/api#8" },
      { type: "mention", title: "Mentioned in ISSUE acme/api#7" }
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Gitea search sync uses review-requested and since queries without repo-wide comments", async () => {
  resetTables();
  config.giteaBaseUrl = "https://git.example";
  config.giteaToken = "test";
  config.giteaUser = "codex";
  config.giteaRepos = [{ owner: "acme", name: "api" }];
  config.giteaFullSyncIntervalMs = 3_600_000;
  updateAppSettings({ autoReviewNewPulls: true });
  const checkpoint = nowIso();
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES ('giteaFullSyncAt', ?, ?), ('giteaSearchSyncAt', ?, ?)
  `).run(checkpoint, checkpoint, checkpoint, checkpoint);
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];

  try {
    globalThis.fetch = async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/repos/issues/search") && url.includes("type=pulls") && url.includes("review_requested=true")) {
        return new Response(
          JSON.stringify([
            {
              number: 8,
              title: "Needs my review",
              body: "please review",
              html_url: "https://git.example/acme/api/pulls/8",
              state: "open",
              repository: { full_name: "acme/api" },
              user: { login: "teammate" },
              labels: []
            }
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/repos/issues/search") && url.includes("type=pulls") && url.includes("since=")) {
        return new Response(
          JSON.stringify([
            {
              number: 9,
              title: "Changed but not mine",
              body: "body",
              html_url: "https://git.example/acme/api/pulls/9",
              state: "open",
              repository: { full_name: "acme/api" },
              user: { login: "teammate" },
              labels: []
            }
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/repos/issues/search") && url.includes("type=issues") && url.includes("since=")) {
        return new Response(
          JSON.stringify([
            {
              number: 7,
              title: "Assigned issue changed",
              body: "please check",
              html_url: "https://git.example/acme/api/issues/7",
              state: "open",
              repository: { full_name: "acme/api" },
              assignees: [{ login: "codex" }],
              labels: []
            }
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/pulls/8")) {
        return new Response(
          JSON.stringify({
            number: 8,
            title: "Needs my review",
            body: "please review",
            html_url: "https://git.example/acme/api/pulls/8",
            state: "open",
            user: { login: "teammate" },
            head: { sha: "sha-pr-8" },
            requested_reviewers: [{ login: "codex" }],
            labels: []
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/pulls/9")) {
        return new Response(
          JSON.stringify({
            number: 9,
            title: "Changed but not mine",
            body: "body",
            html_url: "https://git.example/acme/api/pulls/9",
            state: "open",
            user: { login: "teammate" },
            head: { sha: "sha-pr-9" },
            requested_reviewers: [{ login: "someone-else" }],
            labels: []
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
    };

    const result = await syncGiteaIssues();
    assert.equal(result.mode, "search");
    assert.equal(result.scanned, 3);
    assert.equal(result.upserted, 3);
    assert.equal(result.commentsScanned, 0);
    assert.equal(result.autoReviewJobsStarted, 1);
    assert.equal(calls.some((url) => url.includes("/issues/comments")), false);
    assert.equal(calls.some((url) => url.includes("/repos/acme/api/issues?")), false);
    assert.equal(calls.some((url) => url.includes("/repos/acme/api/pulls?")), false);
    const changedPullSearchUrl = calls.find((url) => url.includes("/repos/issues/search") && url.includes("type=pulls") && url.includes("since="));
    assert.ok(changedPullSearchUrl);
    const since = new URL(changedPullSearchUrl).searchParams.get("since");
    assert.ok(since);
    assert.ok(Date.parse(checkpoint) - Date.parse(since) >= getAppSettings().pollIntervalMs);
    const rows = db.prepare("SELECT kind, external_id, title, head_sha FROM issues ORDER BY CAST(external_id AS INTEGER)").all();
    assert.deepEqual(rows, [
      { kind: "issue", external_id: "7", title: "Assigned issue changed", head_sha: null },
      { kind: "pr", external_id: "8", title: "Needs my review", head_sha: "sha-pr-8" },
      { kind: "pr", external_id: "9", title: "Changed but not mine", head_sha: "sha-pr-9" }
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Gitea sync retries transient fetch failures", async () => {
  resetTables();
  config.giteaBaseUrl = "https://git.example";
  config.giteaToken = "test";
  config.giteaUser = "codex";
  config.giteaRepos = [{ owner: "acme", name: "api" }];
  const originalFetch = globalThis.fetch;
  let call = 0;

  try {
    globalThis.fetch = async (input) => {
      call += 1;
      if (call === 1) {
        throw new TypeError("fetch failed");
      }
      const url = String(input);
      if (url.includes("/pulls?") || url.includes("/issues/comments")) {
        return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(
        JSON.stringify([
          {
            number: 7,
            title: "Repair encoder",
            body: "fails on empty payload",
            html_url: "https://git.example/acme/api/issues/7",
            state: "open",
            assignees: [{ login: "codex" }],
            labels: []
          }
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };

    const result = await syncGiteaIssues();
    assert.equal(result.upserted, 1);
    assert.equal(call > 3, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("new pull request sync auto-starts review jobs when enabled", async () => {
  resetTables();
  config.giteaBaseUrl = "https://git.example";
  config.giteaToken = "test";
  config.giteaUser = "codex";
  config.giteaRepos = [{ owner: "acme", name: "api" }];
  updateAppSettings({ autoReviewNewPulls: true });
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes("/pulls/8")) {
        return new Response(
          JSON.stringify({
            number: 8,
            title: "Review stuck PR",
            body: "please review",
            html_url: "https://git.example/acme/api/pulls/8",
            state: "open",
            user: { login: "teammate" },
            head: { sha: "sha-pr-8" },
            requested_reviewers: [{ login: "codex" }],
            labels: []
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/issues/comments")) {
        return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/pulls?")) {
        return new Response(
          JSON.stringify([
            {
              number: 8,
              title: "Review stuck PR",
              html_url: "https://git.example/acme/api/pulls/8",
              state: "open",
              labels: []
            }
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
    };

    const first = await syncGiteaIssues();
    const second = await syncGiteaIssues();
    assert.equal(first.autoReviewJobsStarted, 1);
    assert.equal(second.autoReviewJobsStarted, 0);
    const jobs = db.prepare("SELECT mode, phase, status FROM repair_jobs").all();
    assert.deepEqual(jobs, [{ mode: "review_only", phase: "review", status: "queued" }]);
    const runs = db.prepare("SELECT review_key, status FROM pr_review_runs").all();
    assert.deepEqual(runs, [{ review_key: "acme/api#pr-8@sha-pr-8", status: "pending" }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("new pull request sync does not auto-start when current user is not a reviewer", async () => {
  resetTables();
  config.giteaBaseUrl = "https://git.example";
  config.giteaToken = "test";
  config.giteaUser = "codex";
  config.giteaRepos = [{ owner: "acme", name: "api" }];
  updateAppSettings({ autoReviewNewPulls: true });
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes("/pulls/8")) {
        return new Response(
          JSON.stringify({
            number: 8,
            title: "Not for me",
            body: "please review",
            html_url: "https://git.example/acme/api/pulls/8",
            state: "open",
            user: { login: "teammate" },
            head: { sha: "sha-pr-8" },
            requested_reviewers: [{ login: "someone-else" }],
            labels: []
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/issues/comments")) {
        return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/pulls?")) {
        return new Response(
          JSON.stringify([
            {
              number: 8,
              title: "Not for me",
              html_url: "https://git.example/acme/api/pulls/8",
              state: "open",
              labels: []
            }
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
    };

    assert.equal((await syncGiteaIssues()).autoReviewJobsStarted, 0);
    const jobCount = db.prepare("SELECT COUNT(*) count FROM repair_jobs").get() as { count: number };
    assert.equal(jobCount.count, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("existing pull request auto-starts review when current user is assigned later", async () => {
  resetTables();
  config.giteaBaseUrl = "https://git.example";
  config.giteaToken = "test";
  config.giteaUser = "codex";
  config.giteaRepos = [{ owner: "acme", name: "api" }];
  updateAppSettings({ autoReviewNewPulls: true });
  const originalFetch = globalThis.fetch;
  let requestedReviewers = [{ login: "someone-else" }];

  try {
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes("/pulls/8")) {
        return new Response(
          JSON.stringify({
            number: 8,
            title: "Assign reviewer later",
            body: "please review",
            html_url: "https://git.example/acme/api/pulls/8",
            state: "open",
            user: { login: "teammate" },
            head: { sha: "sha-pr-8" },
            requested_reviewers: requestedReviewers,
            labels: []
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/issues/comments")) {
        return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/pulls?")) {
        return new Response(
          JSON.stringify([
            {
              number: 8,
              title: "Assign reviewer later",
              html_url: "https://git.example/acme/api/pulls/8",
              state: "open",
              labels: []
            }
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
    };

    assert.equal((await syncGiteaIssues()).autoReviewJobsStarted, 0);
    requestedReviewers = [{ login: "codex" }];
    assert.equal((await syncGiteaIssues()).autoReviewJobsStarted, 1);
    assert.equal((await syncGiteaIssues()).autoReviewJobsStarted, 0);
    const runs = db.prepare("SELECT review_key, status FROM pr_review_runs").all();
    assert.deepEqual(runs, [{ review_key: "acme/api#pr-8@sha-pr-8", status: "pending" }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("pull request head changes auto-start a fresh review job after the active one finishes", async () => {
  resetTables();
  config.giteaBaseUrl = "https://git.example";
  config.giteaToken = "test";
  config.giteaUser = "codex";
  config.giteaRepos = [{ owner: "acme", name: "api" }];
  updateAppSettings({ autoReviewNewPulls: true });
  const originalFetch = globalThis.fetch;
  let headSha = "sha-pr-1";
  const issueId = Number(db.prepare(`
    INSERT INTO issues (
      source, external_id, kind, repo_owner, repo_name, title, body, url, state,
      assignee, author, reviewers, labels, head_sha, status, created_at, updated_at
    )
    VALUES ('gitea', '8', 'pr', 'acme', 'api', 'Review changing PR', 'please review', 'https://git.example/acme/api/pulls/8',
      'open', NULL, 'teammate', '[]', '[]', 'sha-pr-1', 'open', ?, ?)
  `).run(nowIso(), nowIso()).lastInsertRowid);

  try {
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes("/pulls/8")) {
        return new Response(
          JSON.stringify({
            number: 8,
            title: "Review changing PR",
            body: "please review",
            html_url: "https://git.example/acme/api/pulls/8",
            state: "open",
            user: { login: "teammate" },
            head: { sha: headSha },
            requested_reviewers: [{ login: "codex" }],
            labels: []
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/issues/comments")) {
        return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/pulls?")) {
        return new Response(
          JSON.stringify([
            {
              number: 8,
              title: "Review changing PR",
              html_url: "https://git.example/acme/api/pulls/8",
              state: "open",
              labels: []
            }
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
    };

    assert.equal((await syncGiteaIssues()).autoReviewJobsStarted, 1);
    db.prepare("UPDATE pr_review_runs SET status = 'succeeded', posted = 1, finished_at = ? WHERE issue_id = ?").run(nowIso(), issueId);
    headSha = "sha-pr-2";
    assert.equal((await syncGiteaIssues()).autoReviewJobsStarted, 1);
    assert.equal((await syncGiteaIssues()).autoReviewJobsStarted, 0);
    const runs = db.prepare("SELECT review_key, status FROM pr_review_runs ORDER BY id").all();
    assert.deepEqual(runs, [
      { review_key: "acme/api#pr-8@sha-pr-1", status: "succeeded" },
      { review_key: "acme/api#pr-8@sha-pr-2", status: "pending" }
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("settings API persists auto-review toggle", async () => {
  resetTables();
  const app = Fastify({ logger: false });
  await app.register(issueRoutes);
  try {
    assert.equal(getAppSettings().autoReviewNewPulls, false);
    const updated = await app.inject({
      method: "PATCH",
      url: "/api/settings",
      payload: { autoReviewNewPulls: true }
    });
    assert.equal(updated.statusCode, 200);
    assert.deepEqual(JSON.parse(updated.body), {
      autoReviewNewPulls: true,
      deploymentAdapterPath: "",
      issueRepairEnabled: true,
      larkMessageListenerEnabled: false,
      larkCodexRepliesEnabled: false,
      larkExecutionReceiptsEnabled: true,
      larkCodexModel: config.larkCodexModel,
      larkCodexReasoningEffort: "low",
      larkStickerUsageMode: "natural",
      larkGroupSpontaneousRepliesEnabled: false,
      larkGroupSpontaneousReplyRate: config.larkGroupSpontaneousReplyRate,
      larkGroupSpontaneousReplyCooldownMs: config.larkGroupSpontaneousReplyCooldownMs,
      larkGroupSpontaneousChatIds: [],
      larkTrustedExecutionEnabled: false,
      larkTurnAutoApprovalEnabled: false,
      larkTurnAutoApprovalModel: "gpt-6.1-sol",
      larkTurnAutoApprovalDataSources: [],
      larkAcknowledgeReactionEmoji: "THUMBSUP",
      larkGroupMessageReactionEnabled: false,
      larkGroupMessageReactionEmoji: "THUMBSUP",
      larkGroupMessageReactionChatIds: [],
      larkGroupContextMessageLimit: config.larkRecentMessageFetchLimit,
      larkGroupContextMaxChars: config.larkRecentMessageContextMaxChars,
      pollIntervalMs: config.pollIntervalMs
    });

    const settings = await app.inject({ method: "GET", url: "/api/settings" });
    assert.equal(settings.statusCode, 200);
    const body = JSON.parse(settings.body);
    assert.equal(body.appSettings.autoReviewNewPulls, true);
    assert.equal(body.appSettings.issueRepairEnabled, true);
    assert.equal(body.appSettings.larkTrustedExecutionEnabled, false);
    assert.equal(body.appSettings.larkGroupContextMessageLimit, config.larkRecentMessageFetchLimit);
    assert.equal(body.appSettings.larkGroupContextMaxChars, config.larkRecentMessageContextMaxChars);
    assert.equal(body.pollIntervalMs, config.pollIntervalMs);
    assert.equal(body.appSettings.pollIntervalMs, config.pollIntervalMs);
    assert.equal(body.larkMessageListener.acknowledgeReactionEmoji, "THUMBSUP");
    assert.match(body.larkMessageListener.approvalCommand, /card\.action\.trigger/);
    assert.equal(Object.hasOwn(body.larkMessageListener, "fixedReplyText"), false);

    const interval = await app.inject({
      method: "PATCH",
      url: "/api/settings",
      payload: { pollIntervalMs: 300000 }
    });
    assert.equal(interval.statusCode, 200);
    assert.equal(JSON.parse(interval.body).pollIntervalMs, 300000);
    const refreshed = JSON.parse((await app.inject({ method: "GET", url: "/api/settings" })).body);
    assert.equal(refreshed.pollIntervalMs, 300000);
    const groupContext = await app.inject({
      method: "PATCH",
      url: "/api/settings",
      payload: { larkGroupContextMessageLimit: 50, larkGroupContextMaxChars: 6000 }
    });
    assert.equal(groupContext.statusCode, 200);
    assert.deepEqual(JSON.parse(groupContext.body).larkGroupContextMessageLimit, 50);
    assert.deepEqual(JSON.parse(groupContext.body).larkGroupContextMaxChars, 6000);
  } finally {
    await app.close();
  }
});

test("settings API persists Lark listener toggle and lists messages", async () => {
  resetTables();
  const previousRuntimeFlag = process.env.LARK_MESSAGE_LISTENER_RUNTIME;
  process.env.LARK_MESSAGE_LISTENER_RUNTIME = "false";
  const app = Fastify({ logger: false });
  await app.register(issueRoutes);
  try {
    assert.equal(getAppSettings().larkMessageListenerEnabled, false);
    const updated = await app.inject({
      method: "PATCH",
      url: "/api/settings",
      payload: { larkMessageListenerEnabled: true }
    });
    assert.equal(updated.statusCode, 200);
    assert.equal(JSON.parse(updated.body).larkMessageListenerEnabled, true);
    assert.equal(getAppSettings().larkMessageListenerEnabled, true);

    db.prepare(`
      INSERT INTO lark_messages (
        event_id, message_id, chat_id, chat_type, sender_id, message_type, content,
        reply_to_message_id, reply_to_message_type, reply_to_content, reply_to_raw_json,
        mentioned, reply_status, reply_error, raw_json, received_at, created_at
      )
      VALUES ('evt-1', 'om_1', 'oc_1', 'p2p', 'ou_sender', 'text', 'hello @bot',
        'om_parent', 'image', '[Image: img_1]', '{"message_id":"om_parent"}',
        1, 'sent', NULL, '{}', ?, ?)
    `).run(nowIso(), nowIso());
    const listed = await app.inject({ method: "GET", url: "/api/lark/messages" });
    assert.equal(listed.statusCode, 200);
    const [message] = JSON.parse(listed.body);
    assert.equal(message.message_id, "om_1");
    assert.equal(message.reply_to_message_id, "om_parent");
    assert.equal(message.reply_to_content, "[Image: img_1]");
    assert.equal(message.direction, "inbound");
    assert.equal(message.senderType, null);
    assert.equal(message.recipientId, null);
    assert.equal(message.messageAt, message.received_at);
    assert.equal(message.outboundSource, null);
    assert.equal(message.raw_json, undefined);
  } finally {
    if (previousRuntimeFlag === undefined) {
      delete process.env.LARK_MESSAGE_LISTENER_RUNTIME;
    } else {
      process.env.LARK_MESSAGE_LISTENER_RUNTIME = previousRuntimeFlag;
    }
    updateAppSettings({ larkMessageListenerEnabled: false });
    await app.close();
  }
});

test("conversation settings proxy forwards persona and sticker policies with authentication", async () => {
  const previousUrl = config.larkAgentUrl;
  const previousToken = config.larkAgentToken;
  const originalFetch = globalThis.fetch;
  config.larkAgentUrl = "http://lark-agent.test";
  config.larkAgentToken = "test-secret";
  const calls: Array<{ url: string; method?: string; auth: string | null; body: string }> = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method, auth: new Headers(init?.headers).get("authorization"), body: String(init?.body ?? "") });
    return new Response(JSON.stringify({ persona: { mode: "default", version: 0 }, effectiveInstructions: "preview" }), { status: 200 });
  };
  const app = Fastify({ logger: false });
  await app.register(issueRoutes);
  try {
    const url = "/api/lark/chats/oc_group/persona";
    assert.equal((await app.inject({ method: "GET", url })).statusCode, 200);
    assert.equal((await app.inject({ method: "POST", url: url + "/preview", payload: { mode: "custom", name: "test", instructions: "hello" } })).statusCode, 200);
    assert.equal((await app.inject({ method: "PUT", url, payload: { mode: "default" } })).statusCode, 200);
    const settingsUrl = "/api/lark/chats/oc_group/settings";
    assert.equal((await app.inject({ method: "GET", url: settingsUrl })).statusCode, 200);
    assert.equal((await app.inject({ method: "PATCH", url: settingsUrl, payload: { stickerUsageMode: "always" } })).statusCode, 200);
    assert.equal((await app.inject({ method: "PATCH", url: settingsUrl, payload: { spontaneousMode: "on", spontaneousReplyRate: 0.4, spontaneousReplyCooldownMs: 90_000 } })).statusCode, 200);
    assert.equal((await app.inject({ method: "PATCH", url: settingsUrl, payload: { stickerUsageMode: "sometimes" } })).statusCode, 400);
    assert.equal((await app.inject({ method: "PATCH", url: settingsUrl, payload: { spontaneousReplyRate: 2 } })).statusCode, 400);
    assert.deepEqual(calls.map((call) => call.method), ["GET", "POST", "PUT", "GET", "PATCH", "PATCH"]);
    assert.ok(calls.every((call) => call.auth === "Bearer test-secret"));
    assert.equal(calls[1].url, "http://lark-agent.test/v1/chats/oc_group/persona/preview");
    assert.deepEqual(JSON.parse(calls[2].body), { mode: "default" });
    assert.equal(calls[4].url, "http://lark-agent.test/v1/chats/oc_group/settings");
    assert.deepEqual(JSON.parse(calls[4].body), { stickerUsageMode: "always" });
    assert.deepEqual(JSON.parse(calls[5].body), { spontaneousMode: "on", spontaneousReplyRate: 0.4, spontaneousReplyCooldownMs: 90_000 });
    assert.equal((await app.inject({ method: "GET", url: "/api/lark/chats/invalid/persona" })).statusCode, 400);
    config.larkAgentUrl = "";
    assert.equal((await app.inject({ method: "GET", url })).statusCode, 503);
  } finally { await app.close(); config.larkAgentUrl = previousUrl; config.larkAgentToken = previousToken; globalThis.fetch = originalFetch; }
});

test("approval history proxy validates filters and forwards authenticated read-only requests", async () => {
  const previousUrl = config.larkAgentUrl;
  const previousToken = config.larkAgentToken;
  const originalFetch = globalThis.fetch;
  config.larkAgentUrl = "http://lark-agent.test";
  config.larkAgentToken = "test-secret";
  const calls: Array<{ url: string; auth: string | null }> = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
    if (String(url).endsWith("/auto/999")) return new Response('{"error":"not found"}',{status:404});
    return new Response(JSON.stringify({ items: [], total: 0 }), { status: 200 });
  };
  const app = Fastify({ logger: false });
  await app.register(issueRoutes);
  try {
    const response = await app.inject({ method: "GET", url: "/api/lark/approval-history?kind=auto&source=history&status=approved&q=PR&limit=25&offset=25" });
    assert.equal(response.statusCode,200);
    assert.deepEqual(calls[0],{url:"http://lark-agent.test/v1/approval-history?kind=auto&source=history&status=approved&q=PR&limit=25&offset=25",auth:"Bearer test-secret"});
    assert.equal((await app.inject({method:"GET",url:"/api/lark/approval-history/auto/1"})).statusCode,200);
    assert.equal(calls[1].url,"http://lark-agent.test/v1/approval-history/auto/1");
    assert.equal((await app.inject({method:"GET",url:"/api/lark/approval-history/auto/999"})).statusCode,404);
    for (const url of ["/api/lark/approval-history?kind=bad","/api/lark/approval-history?source=bad","/api/lark/approval-history?status=bad","/api/lark/approval-history?limit=101","/api/lark/approval-history?offset=-1","/api/lark/approval-history/bad/1","/api/lark/approval-history/auto/0"]) assert.equal((await app.inject({method:"GET",url})).statusCode,400);
    assert.equal(calls.length,3);
    config.larkAgentUrl = "";
    assert.equal((await app.inject({method:"GET",url:"/api/lark/approval-history"})).statusCode,503);
    config.larkAgentUrl = "http://lark-agent.test";
    globalThis.fetch = async () => { throw new Error("offline"); };
    assert.equal((await app.inject({method:"GET",url:"/api/lark/approval-history"})).statusCode,502);
  } finally { await app.close(); config.larkAgentUrl=previousUrl; config.larkAgentToken=previousToken; globalThis.fetch=originalFetch; }
});

test("Lark model catalog proxy returns supported reasoning efforts", async () => {
  const previousUrl = config.larkAgentUrl;
  const previousToken = config.larkAgentToken;
  const originalFetch = globalThis.fetch;
  config.larkAgentUrl = "http://lark-agent.test";
  config.larkAgentToken = "test-secret";
  const calls: Array<{ url: string; auth: string | null }> = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
    return new Response(JSON.stringify({ models: [{ id: "gpt-5.6-terra", displayName: "Terra", efforts: ["low", "medium"], inputModalities: ["text"] }] }), { status: 200 });
  };
  const app = Fastify({ logger: false });
  await app.register(issueRoutes);
  try {
    const response = await app.inject({ method: "GET", url: "/api/lark/models" });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().models[0].efforts, ["low", "medium"]);
    assert.deepEqual(calls, [{ url: "http://lark-agent.test/v1/models", auth: "Bearer test-secret" }]);
  } finally {
    await app.close();
    config.larkAgentUrl = previousUrl;
    config.larkAgentToken = previousToken;
    globalThis.fetch = originalFetch;
  }
});

test("Lark message proxy preserves outbound metadata and normalizes invalid directions", async () => {
  resetTables();
  const previousLarkAgentUrl = config.larkAgentUrl;
  const originalFetch = globalThis.fetch;
  config.larkAgentUrl = "http://lark-agent.test";
  globalThis.fetch = async (input) => {
    const url = String(input);
    const outboundMessage = {
      id: 7,
      message_id: "om_outbound",
      chat_id: "oc_recipient",
      chat_type: "p2p",
      sender_id: null,
      content: "主动通知",
      direction: "outbound",
      senderType: "bot",
      recipientId: "ou_recipient",
      recipientName: "测试接收人",
      messageAt: "2026-09-03T08:09:10.000Z",
      outboundSource: "proactive"
    };
    return new Response(JSON.stringify(url.endsWith("/v1/messages/7") ? outboundMessage : [outboundMessage,
      {
        id: 8,
        direction: "unexpected",
        received_at: "2026-09-03T09:10:11.000Z"
      }
    ]), { status: 200, headers: { "content-type": "application/json" } });
  };

  const app = Fastify({ logger: false });
  await app.register(issueRoutes);
  try {
    const response = await app.inject({ method: "GET", url: "/api/lark/messages" });
    assert.equal(response.statusCode, 200);
    const [outbound, fallback] = JSON.parse(response.body);
    assert.deepEqual({
      direction: outbound.direction,
      senderType: outbound.senderType,
      recipientId: outbound.recipientId,
      recipientName: outbound.recipientName,
      messageAt: outbound.messageAt,
      outboundSource: outbound.outboundSource
    }, {
      direction: "outbound",
      senderType: "bot",
      recipientId: "ou_recipient",
      recipientName: "测试接收人",
      messageAt: "2026-09-03T08:09:10.000Z",
      outboundSource: "proactive"
    });
    assert.equal(fallback.direction, "inbound");
    assert.equal(fallback.messageAt, fallback.received_at);

    const detailResponse = await app.inject({ method: "GET", url: "/api/lark/messages/7" });
    assert.equal(detailResponse.statusCode, 200);
    const detail = JSON.parse(detailResponse.body);
    assert.equal(detail.direction, "outbound");
    assert.equal(detail.recipientName, "测试接收人");
    assert.equal(detail.messageAt, "2026-09-03T08:09:10.000Z");
  } finally {
    config.larkAgentUrl = previousLarkAgentUrl;
    globalThis.fetch = originalFetch;
    await app.close();
  }
});

test("Lark contact conversation proxy validates queries, forwards pagination, and preserves upstream errors", async () => {
  resetTables();
  const previousLarkAgentUrl = config.larkAgentUrl;
  const originalFetch = globalThis.fetch;
  const requestedUrls: string[] = [];
  config.larkAgentUrl = "http://lark-agent.test";
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    requestedUrls.push(url);
    if (url.endsWith("/sessions/reset")) {
      assert.equal(init?.method, "POST");
      assert.deepEqual(JSON.parse(String(init?.body)), { sessionKey: "oc_group::main-v2::trusted", expectedSessionId: "old-thread" });
      return new Response(JSON.stringify({ sessionKey: "oc_group::main-v2::trusted", oldSessionId: "old-thread", resetAt: "2026-09-16T00:00:00.000Z" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/sessions")) return new Response(JSON.stringify({ active: [], previous: [] }), { status: 200, headers: { "content-type": "application/json" } });
    if (url.includes("keyword=upstream-invalid")) {
      return new Response(JSON.stringify({ code: "CONTACT_QUERY_INVALID", message: "Invalid contact query", traceId: "upstream-trace" }), {
        status: 400,
        headers: { "content-type": "application/json" }
      });
    }
    if (url.includes("keyword=network-failure")) {
      throw new Error("connect ECONNREFUSED 127.0.0.1:4780");
    }
    if (url.includes("/messages?")) {
      return new Response(JSON.stringify({
        items: [{
          id: 12,
          direction: "outbound",
          recipientId: "ou_a1b2",
          messageAt: "2026-09-03T10:00:00.000Z",
          content: "hello"
        }],
        pagination: { limit: 20, hasMore: true, nextCursor: "older/a+b" }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({
      items: [{
        contactId: "ou_a1b2",
        contactName: "张 三",
        lastMessageAt: "2026-09-03T10:00:00.000Z",
        lastMessagePreview: "hello",
        messageCount: 2,
        inboundCount: 1,
        outboundCount: 1
      }],
      pagination: { total: 1, limit: 25, offset: 0, hasMore: false }
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  const app = Fastify({ logger: false });
  await app.register(issueRoutes);
  try {
    const listResponse = await app.inject({ method: "GET", url: "/api/lark/conversations?keyword=%E5%BC%A0%20%E4%B8%89&limit=25" });
    assert.equal(listResponse.statusCode, 200);
    assert.equal(JSON.parse(listResponse.body).items[0].contactId, "ou_a1b2");
    const listUrl = new URL(requestedUrls[0] ?? "");
    assert.equal(listUrl.pathname, "/v1/contact-conversations");
    assert.deepEqual(Object.fromEntries(listUrl.searchParams), { limit: "25", offset: "0", keyword: "张 三" });

    const messagesResponse = await app.inject({ method: "GET", url: "/api/lark/conversations/ou_a1b2/messages?cursor=older%2Fa%2Bb&limit=20" });
    assert.equal(messagesResponse.statusCode, 200);
    const messages = JSON.parse(messagesResponse.body);
    assert.equal(messages.items[0].direction, "outbound");
    assert.equal(messages.items[0].recipientId, "ou_a1b2");
    assert.match(requestedUrls[1] ?? "", /\/v1\/contact-conversations\/ou_a1b2\/messages\?limit=20&cursor=older%2Fa%2Bb$/);
    const groupList = await app.inject({ method: "GET", url: "/api/lark/conversations?chat_type=group&keyword=oc_group" });
    assert.equal(groupList.statusCode, 200);
    assert.equal(new URL(requestedUrls.at(-1)!).searchParams.get("chat_type"), "group");
    const groupMessages = await app.inject({ method: "GET", url: "/api/lark/conversations/oc_group/messages?limit=20" });
    assert.equal(groupMessages.statusCode, 200);
    assert.match(requestedUrls.at(-1)!, /\/v1\/contact-conversations\/oc_group\/messages\?limit=20$/);
    const sessions = await app.inject({ method: "GET", url: "/api/lark/conversations/oc_group/sessions" });
    assert.deepEqual(sessions.json(), { active: [], previous: [] });
    assert.match(requestedUrls.at(-1)!, /\/v1\/contact-conversations\/oc_group\/sessions$/);
    const reset = await app.inject({ method: "POST", url: "/api/lark/conversations/oc_group/sessions/reset", payload: { sessionKey: "oc_group::main-v2::trusted", expectedSessionId: "old-thread" } });
    assert.equal(reset.statusCode, 200);
    assert.equal(reset.json().oldSessionId, "old-thread");
    assert.equal((await app.inject({ method: "POST", url: "/api/lark/conversations/oc_group/sessions/reset", payload: { sessionKey: "", expectedSessionId: "old-thread" } })).statusCode, 400);
    assert.equal((await app.inject({ method: "GET", url: "/api/lark/conversations?chat_type=unknown" })).statusCode, 400);

    const invalidResponse = await app.inject({ method: "GET", url: "/api/lark/conversations?limit=0" });
    assert.equal(invalidResponse.statusCode, 400);
    assert.deepEqual(Object.keys(JSON.parse(invalidResponse.body)).sort(), ["code", "message", "traceId"]);
    assert.equal(JSON.parse(invalidResponse.body).code, "VALIDATION_FAILED");

    const invalidContactResponse = await app.inject({ method: "GET", url: "/api/lark/conversations/not-valid/messages" });
    assert.equal(invalidContactResponse.statusCode, 400);
    assert.equal(JSON.parse(invalidContactResponse.body).code, "VALIDATION_FAILED");

    const upstreamResponse = await app.inject({ method: "GET", url: "/api/lark/conversations?keyword=upstream-invalid" });
    assert.equal(upstreamResponse.statusCode, 400);
    assert.deepEqual(JSON.parse(upstreamResponse.body), {
      code: "CONTACT_QUERY_INVALID",
      message: "Invalid contact query",
      traceId: "upstream-trace"
    });

    const unavailableResponse = await app.inject({ method: "GET", url: "/api/lark/conversations?keyword=network-failure" });
    assert.equal(unavailableResponse.statusCode, 502);
    const unavailableBody = JSON.parse(unavailableResponse.body);
    assert.equal(unavailableBody.code, "LARK_AGENT_UNAVAILABLE");
    assert.equal(unavailableBody.message, "Lark Agent is temporarily unavailable");
    assert.equal(typeof unavailableBody.traceId, "string");

    config.larkAgentUrl = "";
    const missingConfigResponse = await app.inject({ method: "GET", url: "/api/lark/conversations" });
    assert.equal(missingConfigResponse.statusCode, 503);
    const missingConfigBody = JSON.parse(missingConfigResponse.body);
    assert.equal(missingConfigBody.code, "LARK_AGENT_NOT_CONFIGURED");
    assert.equal(missingConfigBody.message, "Lark Agent is not configured");
    assert.equal(typeof missingConfigBody.traceId, "string");
  } finally {
    config.larkAgentUrl = previousLarkAgentUrl;
    globalThis.fetch = originalFetch;
    await app.close();
  }
});

test("settings API persists Lark Codex reply toggle", async () => {
  resetTables();
  const app = Fastify({ logger: false });
  await app.register(issueRoutes);
  try {
    assert.equal(getAppSettings().larkCodexRepliesEnabled, false);
    const updated = await app.inject({
      method: "PATCH",
      url: "/api/settings",
      payload: { larkCodexRepliesEnabled: true }
    });
    assert.equal(updated.statusCode, 200);
    assert.equal(JSON.parse(updated.body).larkCodexRepliesEnabled, true);
    assert.equal(getAppSettings().larkCodexRepliesEnabled, true);

    const settings = JSON.parse((await app.inject({ method: "GET", url: "/api/settings" })).body);
    assert.equal(settings.larkCodexResponder.sandbox, "all-senders-read-only");
    assert.equal(settings.larkCodexResponder.trustedSenderCount, 0);
    assert.equal(settings.larkCodexResponder.reasoningEffort, config.larkCodexReasoningEffort);

    const trustedExecution = await app.inject({
      method: "PATCH",
      url: "/api/settings",
      payload: { larkTrustedExecutionEnabled: true }
    });
    assert.equal(trustedExecution.statusCode, 200);
    const trustedSettings = JSON.parse((await app.inject({ method: "GET", url: "/api/settings" })).body);
    assert.equal(trustedSettings.larkCodexResponder.sandbox, "all-senders-read-only");
  } finally {
    await app.close();
  }
});

test("settings API persists the Lark message acknowledgement reaction", async () => {
  resetTables();
  const app = Fastify({ logger: false });
  await app.register(issueRoutes);
  try {
    const updated = await app.inject({ method: "PATCH", url: "/api/settings", payload: { larkAcknowledgeReactionEmoji: "LAUGH" } });
    assert.equal(updated.statusCode, 200);
    assert.equal(JSON.parse(updated.body).larkAcknowledgeReactionEmoji, "LAUGH");
    const settings = JSON.parse((await app.inject({ method: "GET", url: "/api/settings" })).body);
    assert.equal(settings.larkMessageListener.acknowledgeReactionEmoji, "LAUGH");
    assert.equal(settings.larkMessageListener.acknowledgeReactionOptions.includes("THUMBSUP"), true);
    assert.equal(settings.larkMessageListener.acknowledgeReactionOptions.includes("HappyDragon"), true);
    assert.equal(larkReactionEmojiTypes.length >= 180, true);
  } finally {
    await app.close();
  }
});

test("prompt settings persist local overrides and take effect in new Lark prompts", async () => {
  resetTables();
  const app = Fastify({ logger: false });
  await app.register(issueRoutes);
  try {
    const defaultPrompt = configurablePrompt("larkAssistant");
    const updated = await app.inject({
      method: "PUT",
      url: "/api/settings/prompts",
      payload: {
        larkAssistant: "你是一个只用两句话回答的飞书助手。",
        prReview: "Custom PR review template {{ISSUE_TITLE}}"
      }
    });
    assert.equal(updated.statusCode, 200);
    const prompts = JSON.parse(updated.body) as ReturnType<typeof configurablePromptSettings>;
    assert.equal(prompts.larkAssistant.customized, true);
    assert.equal(configurablePrompt("prReview"), "Custom PR review template {{ISSUE_TITLE}}");
    assert.match(buildLarkCodexPrompt({
      content: "你好",
      chat_type: "p2p",
      sender_id: "ou_sender",
      reply_to_message_id: null,
      reply_to_message_type: null,
      reply_to_content: null
    }), /只用两句话回答/);

    const reset = await app.inject({ method: "PUT", url: "/api/settings/prompts", payload: { larkAssistant: null } });
    assert.equal(reset.statusCode, 200);
    assert.equal(configurablePrompt("larkAssistant"), defaultPrompt);
  } finally {
    await app.close();
  }
});

test("settings API persists runtime configuration outside .env", async () => {
  resetTables();
  const previous = {
    workspaceRoot: config.workspaceRoot,
    giteaBaseUrl: config.giteaBaseUrl,
    giteaBaseUrls: config.giteaBaseUrls,
    giteaUser: config.giteaUser,
    larkExecutionApproverId: config.larkExecutionApproverId,
    trustedLarkCodexSenderIds: config.trustedLarkCodexSenderIds
  };
  const app = Fastify({ logger: false });
  await app.register(issueRoutes);
  try {
    const updated = await app.inject({
      method: "PUT",
      url: "/api/settings/runtime-config",
      payload: {
        workspaceRoot: "/tmp/autofix-workspace",
        giteaBaseUrl: "https://gitea.example.test/",
        giteaBaseUrls: ["https://gitea.example.test/", "https://git.example.test"],
        giteaUser: "local-user",
        larkExecutionApproverId: "ou_owner",
        trustedLarkCodexSenderIds: ["ou_local，ou_teammate", "ou_local"]
      }
    });
    assert.equal(updated.statusCode, 200);
    assert.deepEqual(JSON.parse(updated.body), {
      workspaceRoot: "/tmp/autofix-workspace",
      giteaBaseUrl: "https://gitea.example.test",
      giteaBaseUrls: ["https://gitea.example.test", "https://git.example.test"],
      giteaUser: "local-user",
      larkExecutionApproverId: "ou_owner",
      trustedLarkCodexSenderIds: ["ou_local", "ou_teammate"]
    });
    const settings = JSON.parse((await app.inject({ method: "GET", url: "/api/settings" })).body);
    assert.equal(settings.runtimeConfig.giteaBaseUrl, "https://gitea.example.test");
    assert.deepEqual(settings.runtimeConfig.giteaBaseUrls, ["https://gitea.example.test", "https://git.example.test"]);
    assert.equal(remoteMatchesConfiguredGitea("git@git.example.test:acme/api.git"), true);
    assert.equal(remoteMatchesConfiguredGitea("git@other.example.test:acme/api.git"), false);
    assert.equal(settings.runtimeConfig.larkExecutionApproverId, "ou_owner");
    assert.equal(settings.larkCodexResponder.approvalRecipientConfigured, true);
    assert.equal(settings.larkCodexResponder.trustedSenderCount, 3);

    await app.inject({ method: "PATCH", url: "/api/settings", payload: { larkTrustedExecutionEnabled: true } });
    const trusted = JSON.parse((await app.inject({ method: "GET", url: "/api/settings" })).body);
    assert.equal(trusted.larkCodexResponder.sandbox, "trusted-senders-bypass-others-read-only");
  } finally {
    config.workspaceRoot = previous.workspaceRoot;
    config.giteaBaseUrl = previous.giteaBaseUrl;
    config.giteaBaseUrls = previous.giteaBaseUrls;
    config.giteaUser = previous.giteaUser;
    config.larkExecutionApproverId = previous.larkExecutionApproverId;
    config.trustedLarkCodexSenderIds = previous.trustedLarkCodexSenderIds;
    await app.close();
  }
});

test("onboarding can complete with a workspace but without Gitea repositories", async () => {
  resetTables();
  const previous = {
    workspaceRoot: config.workspaceRoot,
    giteaBaseUrl: config.giteaBaseUrl,
    giteaBaseUrls: config.giteaBaseUrls,
    giteaUser: config.giteaUser
  };
  const app = Fastify({ logger: false });
  await app.register(issueRoutes);
  try {
    const saved = await app.inject({
      method: "PUT",
      url: "/api/settings/runtime-config",
      payload: {
        workspaceRoot: "/tmp/agent-forge-workspace",
        giteaBaseUrl: "",
        giteaUser: "",
        larkExecutionApproverId: "",
        trustedLarkCodexSenderIds: []
      }
    });
    assert.equal(saved.statusCode, 200);
    assert.equal(JSON.parse(saved.body).giteaBaseUrl, "");
    const completed = await app.inject({ method: "POST", url: "/api/settings/onboarding/complete" });
    assert.equal(completed.statusCode, 200);
    assert.deepEqual(JSON.parse(completed.body), { setupComplete: true, giteaConfigured: false });
    const settings = JSON.parse((await app.inject({ method: "GET", url: "/api/settings" })).body);
    assert.equal(settings.setupComplete, true);
  } finally {
    config.workspaceRoot = previous.workspaceRoot;
    config.giteaBaseUrl = previous.giteaBaseUrl;
    config.giteaBaseUrls = previous.giteaBaseUrls;
    config.giteaUser = previous.giteaUser;
    await app.close();
  }
});

test("settings backup excludes credentials and restores local configuration", async () => {
  resetTables();
  const previous = {
    workspaceRoot: config.workspaceRoot,
    giteaBaseUrl: config.giteaBaseUrl,
    giteaBaseUrls: config.giteaBaseUrls,
    giteaUser: config.giteaUser,
    larkExecutionApproverId: config.larkExecutionApproverId,
    trustedLarkCodexSenderIds: config.trustedLarkCodexSenderIds
  };
  const app = Fastify({ logger: false });
  await app.register(issueRoutes);
  try {
    await app.inject({
      method: "PUT",
      url: "/api/settings/runtime-config",
      payload: {
        workspaceRoot: "/tmp/autofix-backup-workspace",
        giteaBaseUrl: "https://gitea.example.test",
        giteaBaseUrls: ["https://gitea.example.test", "https://git.example.test"],
        giteaUser: "backup-user",
        larkExecutionApproverId: "ou_backup_owner",
        trustedLarkCodexSenderIds: ["ou_backup"]
      }
    });
    await app.inject({ method: "PUT", url: "/api/settings/repositories", payload: { repositories: ["acme/api"] } });
    await app.inject({ method: "PATCH", url: "/api/settings", payload: { autoReviewNewPulls: true } });
    db.prepare(`
      INSERT INTO codex_todos (title, description, status, source_type, created_at, updated_at)
      VALUES (?, ?, ?, 'manual', ?, ?)
    `).run("备份待办", "说明", "review", nowIso(), nowIso());

    const backup = JSON.parse((await app.inject({ method: "GET", url: "/api/settings/backup" })).body);
    assert.equal(backup.schemaVersion, 1);
    assert.equal(backup.todos.length, 1);
    assert.deepEqual(backup.runtimeConfig.giteaBaseUrls, ["https://gitea.example.test", "https://git.example.test"]);
    assert.doesNotMatch(JSON.stringify(backup), /giteaToken|GITEA_TOKEN/);

    db.exec("DELETE FROM codex_todos");
    await app.inject({ method: "PATCH", url: "/api/settings", payload: { autoReviewNewPulls: false } });
    const restored = await app.inject({ method: "POST", url: "/api/settings/backup/restore", payload: backup });
    assert.equal(restored.statusCode, 200);
    assert.equal(JSON.parse(restored.body).todos, 1);

    const settings = JSON.parse((await app.inject({ method: "GET", url: "/api/settings" })).body);
    assert.equal(settings.setupComplete, true);
    assert.equal(settings.appSettings.autoReviewNewPulls, true);
    assert.equal(settings.runtimeConfig.workspaceRoot, "/tmp/autofix-backup-workspace");
    assert.deepEqual(settings.runtimeConfig.giteaBaseUrls, ["https://gitea.example.test", "https://git.example.test"]);
    assert.equal(settings.runtimeConfig.larkExecutionApproverId, "ou_backup_owner");
    assert.equal((db.prepare("SELECT count(*) AS count FROM codex_todos").get() as { count: number }).count, 1);
  } finally {
    config.workspaceRoot = previous.workspaceRoot;
    config.giteaBaseUrl = previous.giteaBaseUrl;
    config.giteaBaseUrls = previous.giteaBaseUrls;
    config.giteaUser = previous.giteaUser;
    config.larkExecutionApproverId = previous.larkExecutionApproverId;
    config.trustedLarkCodexSenderIds = previous.trustedLarkCodexSenderIds;
    await app.close();
  }
});

test("settings API persists the selected local Gitea repositories", async () => {
  resetTables();
  const app = Fastify({ logger: false });
  await app.register(issueRoutes);
  try {
    const updated = await app.inject({
      method: "PUT",
      url: "/api/settings/repositories",
      payload: { repositories: ["acme/web", "acme/api", "acme/web"] }
    });
    assert.equal(updated.statusCode, 200);
    assert.deepEqual(JSON.parse(updated.body).repos, ["acme/api", "acme/web"]);

    const settings = JSON.parse((await app.inject({ method: "GET", url: "/api/settings" })).body);
    assert.deepEqual(settings.giteaSync.repos, ["acme/api", "acme/web"]);
  } finally {
    await app.close();
  }
});

test("settings API records permission changes and exposes local data usage", async () => {
  resetTables();
  const app = Fastify({ logger: false });
  await app.register(issueRoutes);
  try {
    const updated = await app.inject({
      method: "PATCH",
      url: "/api/settings",
      payload: { issueRepairEnabled: false, larkTrustedExecutionEnabled: true }
    });
    assert.equal(updated.statusCode, 200);

    const audit = JSON.parse((await app.inject({ method: "GET", url: "/api/settings/audit" })).body);
    assert.equal(audit[0].action, "settings.updated");
    assert.match(audit[0].details, /issueRepairEnabled/);
    assert.match(audit[0].details, /larkTrustedExecutionEnabled/);

    const data = JSON.parse((await app.inject({ method: "GET", url: "/api/settings/local-data" })).body);
    assert.equal(typeof data.totalBytes, "number");
    assert.equal(typeof data.taskArtifactBytes, "number");
  } finally {
    await app.close();
  }
});

test("Lark message rows expose Codex reply state", async () => {
  resetTables();
  const app = Fastify({ logger: false });
  await app.register(issueRoutes);
  try {
    upsertLarkContact({
      openId: "ou_sender",
      name: "测试发送人",
      enterpriseEmail: "sender@example.com",
      department: "研发部",
      hasChatted: true,
      source: "test"
    });
    db.prepare(`
      INSERT INTO lark_messages (
        event_id, message_id, chat_id, chat_type, sender_id, message_type, content,
        mentioned, reply_status, reply_error, codex_status, codex_reply, codex_error, codex_session_id,
        codex_started_at, codex_finished_at, raw_json, received_at, created_at
      )
      VALUES (
        'evt-codex', 'om_codex', 'oc_1', 'p2p', 'ou_sender', 'text', '帮我看一下',
        1, 'sent', NULL, 'answered', '这是 Codex 回复', NULL, 'session-1',
        ?, ?, '{}', ?, ?
      )
    `).run(nowIso(), nowIso(), nowIso(), nowIso());
    const listed = await app.inject({ method: "GET", url: "/api/lark/messages" });
    assert.equal(listed.statusCode, 200);
    const [message] = JSON.parse(listed.body) as Array<{ codex_status: string; codex_reply: string; codex_session_id: string; sender_name: string; sender_enterprise_email: string }>;
    assert.equal(message.codex_status, "answered");
    assert.equal(message.codex_reply, "这是 Codex 回复");
    assert.equal(message.codex_session_id, "session-1");
    assert.equal(message.sender_name, "测试发送人");
    assert.equal(message.sender_enterprise_email, "sender@example.com");
  } finally {
    await app.close();
  }
});

test("Lark message detail returns Codex artifacts", async () => {
  resetTables();
  const taskDir = fs.mkdtempSync(path.join(os.tmpdir(), "autofix-lark-detail-test-"));
  fs.writeFileSync(path.join(taskDir, "prompt.md"), "prompt text");
  fs.writeFileSync(path.join(taskDir, "codex.stdout.jsonl"), JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "answer" } }));
  fs.writeFileSync(path.join(taskDir, "codex.stderr.log"), "stderr text");
  fs.writeFileSync(path.join(taskDir, "tmux-capture.log"), "capture text");
  fs.writeFileSync(path.join(taskDir, "run-codex-lark.sh"), "launcher text");
  fs.mkdirSync(path.join(taskDir, "images"));
  const imagePath = path.join(taskDir, "images", "referenced-image.png");
  fs.writeFileSync(imagePath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=", "base64"));
  fs.writeFileSync(path.join(taskDir, "referenced-images.json"), JSON.stringify([imagePath]));
  fs.mkdirSync(path.join(taskDir, "files"));
  const filePath = path.join(taskDir, "files", "note.md");
  fs.writeFileSync(filePath, "# 文档\n\nhello file");
  fs.writeFileSync(path.join(taskDir, "referenced-files.json"), JSON.stringify([{
    name: "note.md",
    path: filePath,
    mimeType: "text/markdown",
    size: fs.statSync(filePath).size,
    text: "# 文档\n\nhello file"
  }]));
  fs.writeFileSync(path.join(taskDir, "resume-session.json"), JSON.stringify({ chatId: "oc_1", sessionKey: "oc_1::trusted", trustScope: "trusted", previousSessionId: "session-0", currentSessionId: "session-1", resumed: true }));

  const app = Fastify({ logger: false });
  await app.register(issueRoutes);
  try {
    upsertLarkContact({
      openId: "ou_sender",
      name: "详情发送人",
      enterpriseEmail: "detail@example.com",
      department: "产品部",
      hasChatted: true,
      source: "test"
    });
    const now = nowIso();
    const result = db.prepare(`
      INSERT INTO lark_messages (
        event_id, message_id, chat_id, chat_type, sender_id, message_type, content,
        mentioned, reply_status, reply_error, codex_status, codex_reply, codex_error,
        codex_session_id, codex_task_dir, codex_started_at, codex_finished_at,
        raw_json, received_at, created_at
      )
      VALUES (
        'evt-detail', 'om_detail', 'oc_1', 'p2p', 'ou_sender', 'text', 'hello',
        1, 'sent', NULL, 'answered', 'answer', NULL,
        'session-1', ?, ?, ?,
        '{}', ?, ?
      )
    `).run(taskDir, now, now, now, now);
    db.prepare(`
      INSERT INTO lark_execution_approvals (
        token, lark_message_id, requester_id, approver_id, request_method, server_request_id,
        thread_id, turn_id, item_id, operation, cwd, reason, status, created_at, expires_at
      ) VALUES ('approval-token', ?, 'ou_sender', 'ou_owner', 'item/commandExecution/requestApproval',
        'request-1', 'thread-1', 'turn-1', 'item-1', 'npm run deploy', '/tmp/project', '需要部署',
        'pending', ?, ?)
    `).run(result.lastInsertRowid, now, new Date(Date.parse(now) + 600_000).toISOString());

    const response = await app.inject({ method: "GET", url: `/api/lark/messages/${result.lastInsertRowid}` });
    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.codex_task_dir, taskDir);
    assert.equal(body.sender_name, "详情发送人");
    assert.equal(body.sender_department, "产品部");
    assert.equal(body.codex_artifacts, undefined);

    const artifactsResponse = await app.inject({ method: "GET", url: `/api/lark/messages/${result.lastInsertRowid}/artifacts` });
    assert.equal(artifactsResponse.statusCode, 200);
    const artifacts = JSON.parse(artifactsResponse.body);
    assert.equal(artifacts.prompt, "prompt text");
    assert.match(artifacts.stdout, /agent_message/);
    assert.equal(artifacts.stderr, "stderr text");
    assert.equal(artifacts.tmuxCapture, "capture text");
    assert.equal(artifacts.launcher, "launcher text");
    assert.match(artifacts.referencedImages, /referenced-image/);
    assert.match(artifacts.referencedFiles, /note\.md/);
    assert.match(artifacts.resumeSession, /session-0/);
    assert.equal(artifacts.approvals.length, 1);
    assert.equal(artifacts.approvals[0].approverId, "ou_owner");
    assert.equal(artifacts.approvals[0].operation, "npm run deploy");
    assert.equal(artifacts.approvals[0].approvalScope, "once");

    const imagesResponse = await app.inject({ method: "GET", url: `/api/lark/messages/${result.lastInsertRowid}/images` });
    assert.equal(imagesResponse.statusCode, 200);
    const images = JSON.parse(imagesResponse.body) as Array<{ name: string; mimeType: string; dataUrl: string }>;
    assert.equal(images.length, 1);
    assert.equal(images[0].name, "referenced-image.png");
    assert.equal(images[0].mimeType, "image/png");
    assert.match(images[0].dataUrl, /^data:image\/png;base64,/);

    const filesResponse = await app.inject({ method: "GET", url: `/api/lark/messages/${result.lastInsertRowid}/files` });
    assert.equal(filesResponse.statusCode, 200);
    const files = JSON.parse(filesResponse.body) as Array<{ name: string; mimeType: string; text: string }>;
    assert.equal(files.length, 1);
    assert.equal(files[0].name, "note.md");
    assert.equal(files[0].mimeType, "text/markdown");
    assert.match(files[0].text, /hello file/);
  } finally {
    fs.rmSync(taskDir, { recursive: true, force: true });
    await app.close();
  }
});

test("Gitea sync fails clearly when repo allowlist is empty", async () => {
  resetTables();
  const previousRepos = config.giteaRepos;
  config.giteaRepos = [];
  try {
    await assert.rejects(syncGiteaIssues(), /missing GITEA_REPOS/);
  } finally {
    config.giteaRepos = previousRepos;
  }
});

test("repo setup lock blocks concurrent setup and recovers after expiry", () => {
  resetTables();
  assert.equal(acquireRepoSetupLock("acme/api", 1, 60_000), true);
  assert.equal(acquireRepoSetupLock("acme/api", 2, 60_000), false);
  releaseRepoSetupLock("acme/api", 1);
  assert.equal(acquireRepoSetupLock("acme/api", 2, 60_000), true);
  db.prepare("UPDATE repo_setup_locks SET expires_at = ? WHERE repo_key = ?").run("2000-01-01T00:00:00.000Z", "acme/api");
  cleanupExpiredRepoSetupLocks(nowIso());
  assert.equal(acquireRepoSetupLock("acme/api", 3, 60_000), true);
});

test("pull request items can only start review_only jobs", async () => {
  resetTables();
  const createdAt = nowIso();
  const issueId = Number(db.prepare(`
    INSERT INTO issues (
      source, external_id, kind, repo_owner, repo_name, title, body, url, state,
      assignee, author, reviewers, labels, head_sha, status, created_at, updated_at
    )
    VALUES ('gitea', '42', 'pr', 'acme', 'api', 'Improve API', 'please review', 'https://git.example/acme/api/pulls/42',
      'open', NULL, 'teammate', '["codex"]', '[]', 'sha-42', 'open', ?, ?)
  `).run(createdAt, createdAt).lastInsertRowid);

  const app = Fastify({ logger: false });
  await app.register(issueRoutes);
  try {
    const rejected = await app.inject({
      method: "POST",
      url: `/api/issues/${issueId}/repair`,
      payload: { mode: "reviewed_pr" }
    });
    assert.equal(rejected.statusCode, 409);
    assert.match(rejected.body, /Pull requests can only start review_only/);

    const accepted = await app.inject({
      method: "POST",
      url: `/api/issues/${issueId}/repair`,
      payload: { mode: "review_only" }
    });
    assert.equal(accepted.statusCode, 200);
    const job = JSON.parse(accepted.body) as { mode: string; phase: string };
    assert.equal(job.mode, "review_only");
    assert.equal(job.phase, "review");
  } finally {
    await app.close();
  }
});

test("issue items start triage before implementation", async () => {
  resetTables();
  const createdAt = nowIso();
  const issueId = Number(db.prepare(`
    INSERT INTO issues (
      source, external_id, kind, repo_owner, repo_name, title, body, url, state,
      assignee, author, reviewers, labels, head_sha, status, created_at, updated_at
    )
    VALUES ('gitea', '7', 'issue', 'acme', 'api', 'Repair encoder', 'fails on empty payload', 'https://git.example/acme/api/issues/7',
      'open', 'codex', 'teammate', '[]', '[]', NULL, 'open', ?, ?)
  `).run(createdAt, createdAt).lastInsertRowid);

  const app = Fastify({ logger: false });
  await app.register(issueRoutes);
  try {
    const implementationBeforeTriage = await app.inject({
      method: "POST",
      url: `/api/issues/${issueId}/repair`,
      payload: { mode: "issue_implementation" }
    });
    assert.equal(implementationBeforeTriage.statusCode, 409);
    assert.match(implementationBeforeTriage.body, /Run issue triage before starting implementation/);

    const triage = await app.inject({
      method: "POST",
      url: `/api/issues/${issueId}/repair`,
      payload: {}
    });
    assert.equal(triage.statusCode, 200);
    const triageJob = JSON.parse(triage.body) as { id: number; mode: string; phase: string };
    assert.equal(triageJob.mode, "issue_triage");
    assert.equal(triageJob.phase, "triage");

    const finalJson = {
      status: "triaged",
      target_repo: "acme/api",
      task_dir: "/tmp/triage",
      worktree_path: null,
      branch_name: null,
      pr_url: null,
      summary: "Ready for implementation.",
      verification: ["Read issue"],
      residual_risk: [],
      triage: {
        decision: "easy-direct",
        scores: { difficulty: 1, workload: 1, importance: 3, complexity: 1 },
        summary: "Small isolated fix."
      },
      development_plan: {
        summary: "Guard empty payload.",
        steps: ["Add input guard", "Add unit test"],
        target_files: ["src/encoder.ts"],
        verification: ["npm test"],
        risks: []
      }
    };
    db.prepare("UPDATE repair_jobs SET status = 'triaged', final_json = ?, task_dir = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(finalJson), "/tmp/triage", nowIso(), triageJob.id);

    const implementation = await app.inject({
      method: "POST",
      url: `/api/issues/${issueId}/repair`,
      payload: { mode: "issue_implementation" }
    });
    assert.equal(implementation.statusCode, 200);
    const implementationJob = JSON.parse(implementation.body) as { mode: string; phase: string };
    assert.equal(implementationJob.mode, "issue_implementation");
    assert.equal(implementationJob.phase, "implementation");
  } finally {
    await app.close();
  }
});

test("mid-human-review issue implementation requires explicit plan approval", async () => {
  resetTables();
  const createdAt = nowIso();
  const issueId = Number(db.prepare(`
    INSERT INTO issues (
      source, external_id, kind, repo_owner, repo_name, title, body, url, state,
      assignee, author, reviewers, labels, head_sha, status, created_at, updated_at
    )
    VALUES ('gitea', '8', 'issue', 'acme', 'api', 'Repair with approval', 'needs scoped fix', 'https://git.example/acme/api/issues/8',
      'open', 'codex', 'teammate', '[]', '[]', NULL, 'open', ?, ?)
  `).run(createdAt, createdAt).lastInsertRowid);
  const finalJson = {
    status: "triaged",
    target_repo: "acme/api",
    task_dir: "/tmp/triage-review",
    worktree_path: null,
    branch_name: null,
    pr_url: null,
    summary: "Ready after human review.",
    verification: ["Read issue"],
    residual_risk: [],
    triage: {
      decision: "mid-human-review",
      scores: { difficulty: 2, workload: 2, importance: 3, complexity: 2 },
      summary: "Feasible but needs approval."
    },
    development_plan: {
      summary: "Patch noisy logging.",
      steps: ["Patch logger", "Add unit test"],
      target_files: ["src/controller.ts"],
      verification: ["npm test"],
      risks: []
    }
  };
  db.prepare(`
    INSERT INTO repair_jobs (issue_id, status, phase, mode, task_dir, final_json, created_at, updated_at)
    VALUES (?, 'triaged', 'triage', 'issue_triage', '/tmp/triage-review', ?, ?, ?)
  `).run(issueId, JSON.stringify(finalJson), createdAt, createdAt);

  const app = Fastify({ logger: false });
  await app.register(issueRoutes);
  try {
    const rejected = await app.inject({
      method: "POST",
      url: `/api/issues/${issueId}/repair`,
      payload: { mode: "issue_implementation" }
    });
    assert.equal(rejected.statusCode, 409);
    assert.match(rejected.body, /needs human approval/);

    const accepted = await app.inject({
      method: "POST",
      url: `/api/issues/${issueId}/repair`,
      payload: { mode: "issue_implementation", approveTriagePlan: true }
    });
    assert.equal(accepted.statusCode, 200);
    const job = JSON.parse(accepted.body) as { id: number; mode: string; phase: string; repo_hint: string };
    assert.equal(job.mode, "issue_implementation");
    assert.equal(job.phase, "implementation");
    assert.equal(job.repo_hint, "api");
    const event = db.prepare("SELECT message FROM job_events WHERE job_id = ?").get(job.id) as { message: string };
    assert.equal(event.message, "Human approved triage plan for implementation");
  } finally {
    await app.close();
  }
});

test("implementation prompt context includes human triage approval", () => {
  resetTables();
  const taskDir = fs.mkdtempSync(path.join(os.tmpdir(), "autofix-approved-triage-"));
  const now = nowIso();
  const issueId = Number(db.prepare(`
    INSERT INTO issues (
      source, external_id, kind, repo_owner, repo_name, title, body, url, state,
      assignee, author, reviewers, labels, head_sha, status, created_at, updated_at
    )
    VALUES ('gitea', '9', 'issue', 'acme', 'api', 'Approved repair', 'body', 'https://git.example/acme/api/issues/9',
      'open', 'codex', 'teammate', '[]', '[]', NULL, 'open', ?, ?)
  `).run(now, now).lastInsertRowid);
  const triageJobId = Number(db.prepare(`
    INSERT INTO repair_jobs (issue_id, status, phase, mode, task_dir, final_json, created_at, updated_at)
    VALUES (?, 'triaged', 'triage', 'issue_triage', ?, ?, ?, ?)
  `).run(issueId, taskDir, JSON.stringify({
    status: "triaged",
    triage: { decision: "mid-human-review" },
    development_plan: { steps: ["Patch"] }
  }), now, now).lastInsertRowid);
  fs.writeFileSync(path.join(taskDir, "final.json"), JSON.stringify({ status: "triaged" }));
  db.prepare(`
    INSERT INTO repair_jobs (issue_id, status, phase, mode, repo_hint, created_at, updated_at)
    VALUES (?, 'queued', 'implementation', 'issue_implementation', 'api', ?, ?)
  `).run(issueId, now, now);
  const job = db.prepare("SELECT * FROM repair_jobs WHERE issue_id = ? AND mode = 'issue_implementation'").get(issueId) as RepairJobRow;
  db.prepare("INSERT INTO job_events (job_id, level, message, created_at) VALUES (?, 'info', 'Human approved triage plan for implementation', ?)").run(job.id, now);

  const issue = db.prepare("SELECT * FROM issues WHERE id = ?").get(issueId) as Parameters<typeof buildTriageContext>[0];
  const context = buildTriageContext(issue, job);
  assert.match(context, /Human approval: the triage development plan has been explicitly approved/);
  assert.match(context, new RegExp(`Triage job: #${triageJobId}`));
});

test("pull request review jobs are keyed by current head sha and expose stale state", async () => {
  resetTables();
  const createdAt = nowIso();
  const issueId = Number(db.prepare(`
    INSERT INTO issues (
      source, external_id, kind, repo_owner, repo_name, title, body, url, state,
      assignee, author, reviewers, labels, head_sha, status, created_at, updated_at
    )
    VALUES ('gitea', '42', 'pr', 'acme', 'api', 'Improve API', 'please review', 'https://git.example/acme/api/pulls/42',
      'open', NULL, 'teammate', '["codex"]', '[]', 'sha-1', 'open', ?, ?)
  `).run(createdAt, createdAt).lastInsertRowid);

  const app = Fastify({ logger: false });
  await app.register(issueRoutes);
  try {
    const accepted = await app.inject({
      method: "POST",
      url: `/api/issues/${issueId}/repair`,
      payload: { mode: "review_only" }
    });
    assert.equal(accepted.statusCode, 200);
    const job = JSON.parse(accepted.body) as { id: number };
    const run = db.prepare("SELECT review_key, status, head_sha FROM pr_review_runs WHERE job_id = ?").get(job.id) as { review_key: string; status: string; head_sha: string };
    assert.equal(run.review_key, "acme/api#pr-42@sha-1");
    assert.equal(run.status, "pending");
    assert.equal(run.head_sha, "sha-1");

    const duplicate = await app.inject({
      method: "POST",
      url: `/api/issues/${issueId}/repair`,
      payload: { mode: "review_only" }
    });
    assert.equal(duplicate.statusCode, 409);
    assert.match(duplicate.body, /already active/);

    db.prepare("UPDATE pr_review_runs SET status = 'succeeded', posted = 1, finished_at = ? WHERE job_id = ?").run(nowIso(), job.id);
    let pulls = JSON.parse((await app.inject({ method: "GET", url: "/api/pulls?scope=all" })).body) as Array<{ review_state: string; review_stale: boolean; review_head_sha?: string }>;
    assert.equal(pulls[0].review_state, "posted");
    assert.equal(pulls[0].review_stale, false);

    db.prepare("UPDATE issues SET head_sha = ?, updated_at = ? WHERE id = ?").run("sha-2", nowIso(), issueId);
    pulls = JSON.parse((await app.inject({ method: "GET", url: "/api/pulls?scope=all" })).body) as Array<{ review_state: string; review_stale: boolean; review_head_sha: string }>;
    assert.equal(pulls[0].review_state, "stale");
    assert.equal(pulls[0].review_stale, true);
    assert.equal(pulls[0].review_head_sha, "sha-1");
  } finally {
    await app.close();
  }
});

test("pull request review jobs are mutually exclusive while active", async () => {
  resetTables();
  const createdAt = nowIso();
  const issueId = Number(db.prepare(`
    INSERT INTO issues (
      source, external_id, kind, repo_owner, repo_name, title, body, url, state,
      assignee, author, reviewers, labels, head_sha, status, created_at, updated_at
    )
    VALUES ('gitea', '43', 'pr', 'acme', 'api', 'Improve API again', 'please review', 'https://git.example/acme/api/pulls/43',
      'open', NULL, 'teammate', '["codex"]', '[]', 'sha-1', 'open', ?, ?)
  `).run(createdAt, createdAt).lastInsertRowid);

  const app = Fastify({ logger: false });
  await app.register(issueRoutes);
  try {
    const accepted = await app.inject({
      method: "POST",
      url: `/api/issues/${issueId}/repair`,
      payload: { mode: "review_only" }
    });
    assert.equal(accepted.statusCode, 200);
    const firstJob = JSON.parse(accepted.body) as { id: number };

    const duplicate = await app.inject({
      method: "POST",
      url: `/api/issues/${issueId}/repair`,
      payload: { mode: "review_only" }
    });
    assert.equal(duplicate.statusCode, 409);
    assert.match(duplicate.body, /already active/);

    db.prepare("UPDATE pr_review_runs SET status = 'failed', finished_at = ? WHERE job_id = ?").run(nowIso(), firstJob.id);
    db.prepare("UPDATE issues SET head_sha = ?, updated_at = ? WHERE id = ?").run("sha-2", nowIso(), issueId);

    const retried = await app.inject({
      method: "POST",
      url: `/api/issues/${issueId}/repair`,
      payload: { mode: "review_only" }
    });
    assert.equal(retried.statusCode, 200);
    const jobs = db.prepare("SELECT id, status FROM repair_jobs WHERE issue_id = ? ORDER BY id").all(issueId) as Array<{ id: number; status: string }>;
    assert.equal(jobs.length, 2);
  } finally {
    await app.close();
  }
});

test("manual pull request retry reuses the failed review key without orphaning a job", async () => {
  resetTables();
  const createdAt = nowIso();
  const issueId = Number(db.prepare(`
    INSERT INTO issues (
      source, external_id, kind, repo_owner, repo_name, title, body, url, state,
      assignee, author, reviewers, labels, head_sha, status, created_at, updated_at
    )
    VALUES ('gitea', '44', 'pr', 'acme', 'api', 'Retry review', 'please review', 'https://git.example/acme/api/pulls/44',
      'open', NULL, 'teammate', '["codex"]', '[]', 'sha-1', 'open', ?, ?)
  `).run(createdAt, createdAt).lastInsertRowid);

  const app = Fastify({ logger: false });
  await app.register(issueRoutes);
  try {
    const first = await app.inject({ method: "POST", url: `/api/issues/${issueId}/repair`, payload: { mode: "review_only" } });
    assert.equal(first.statusCode, 200);
    const firstJob = JSON.parse(first.body) as { id: number };
    db.prepare("UPDATE repair_jobs SET status = 'failed' WHERE id = ?").run(firstJob.id);
    db.prepare("UPDATE pr_review_runs SET status = 'failed', finished_at = ? WHERE job_id = ?").run(nowIso(), firstJob.id);

    const retried = await app.inject({ method: "POST", url: `/api/issues/${issueId}/repair`, payload: { mode: "review_only" } });
    assert.equal(retried.statusCode, 200);
    const retryJob = JSON.parse(retried.body) as { id: number };
    assert.notEqual(retryJob.id, firstJob.id);
    const reviewRuns = db.prepare("SELECT job_id, status FROM pr_review_runs WHERE issue_id = ?").all(issueId) as Array<{ job_id: number; status: string }>;
    assert.deepEqual(reviewRuns, [{ job_id: retryJob.id, status: "pending" }]);
    const jobCount = db.prepare("SELECT count(*) AS count FROM repair_jobs WHERE issue_id = ?").get(issueId) as { count: number };
    assert.equal(jobCount.count, 2);
  } finally {
    await app.close();
  }
});

test("pull request follow-up review context reuses prior Codex session and narrows to incremental diff", () => {
  resetTables();
  const createdAt = nowIso();
  const issueId = Number(db.prepare(`
    INSERT INTO issues (
      source, external_id, kind, repo_owner, repo_name, title, body, url, state,
      assignee, author, reviewers, labels, head_sha, status, created_at, updated_at
    )
    VALUES ('gitea', '44', 'pr', 'acme', 'api', 'Improve API incrementally', 'please review', 'https://git.example/acme/api/pulls/44',
      'open', NULL, 'teammate', '["codex"]', '[]', 'sha-2', 'open', ?, ?)
  `).run(createdAt, createdAt).lastInsertRowid);
  const previousJobId = Number(db.prepare(`
    INSERT INTO repair_jobs (issue_id, status, phase, mode, repo_hint, task_dir, codex_session_id, created_at, updated_at, started_at, finished_at)
    VALUES (?, 'done', 'review', 'review_only', 'api', '/tmp/autofix-pr-44-job-1', 'session-pr-44', ?, ?, ?, ?)
  `).run(issueId, createdAt, createdAt, createdAt, createdAt).lastInsertRowid);
  db.prepare(`
    INSERT INTO pr_review_runs (
      issue_id, job_id, repo, pr_number, head_sha, review_key, status, runtime, verdict,
      posted, task_package_path, created_at, started_at, finished_at, posted_at
    ) VALUES (?, ?, 'acme/api', '44', 'sha-1', 'acme/api#pr-44@sha-1', 'succeeded', 'codex', 'comment', 1, '/tmp/autofix-pr-44-job-1', ?, ?, ?, ?)
  `).run(issueId, previousJobId, createdAt, createdAt, createdAt, createdAt);
  const currentJobId = Number(db.prepare(`
    INSERT INTO repair_jobs (issue_id, status, phase, mode, repo_hint, created_at, updated_at)
    VALUES (?, 'queued', 'review', 'review_only', 'api', ?, ?)
  `).run(issueId, createdAt, createdAt).lastInsertRowid);

  const issue = db.prepare("SELECT * FROM issues WHERE id = ?").get(issueId) as Parameters<typeof buildPrReviewContext>[0];
  const job = db.prepare("SELECT * FROM repair_jobs WHERE id = ?").get(currentJobId) as Parameters<typeof buildPrReviewContext>[1];
  const context = buildPrReviewContext(issue, job);
  assert.match(context, /Previous reviewed head SHA: `sha-1`/);
  assert.match(context, /Current head SHA: `sha-2`/);
  assert.match(context, /sha-1\.\.sha-2/);
  assert.match(context, /Previous task package: `\/tmp\/autofix-pr-44-job-1`/);
  assert.match(context, /incremental follow-up review/);
});

test("pull request API defaults to authored and review-requested PRs", async () => {
  resetTables();
  const previousUser = config.giteaUser;
  config.giteaUser = "codex";
  const createdAt = nowIso();
  const insert = db.prepare(`
    INSERT INTO issues (
      source, external_id, kind, repo_owner, repo_name, title, body, url, state,
      assignee, author, reviewers, labels, status, created_at, updated_at
    )
    VALUES ('gitea', @external_id, 'pr', 'acme', 'api', @title, '', @url, 'open',
      NULL, @author, @reviewers, '[]', 'open', @created_at, @updated_at)
  `);
  insert.run({ external_id: "1", title: "Authored by me", url: "https://git.example/acme/api/pulls/1", author: "codex", reviewers: "[]", created_at: createdAt, updated_at: createdAt });
  insert.run({ external_id: "2", title: "Needs my review", url: "https://git.example/acme/api/pulls/2", author: "teammate", reviewers: JSON.stringify(["codex"]), created_at: createdAt, updated_at: createdAt });
  insert.run({ external_id: "3", title: "Unrelated", url: "https://git.example/acme/api/pulls/3", author: "teammate", reviewers: JSON.stringify(["someone-else"]), created_at: createdAt, updated_at: createdAt });

  const app = Fastify({ logger: false });
  await app.register(issueRoutes);
  try {
    const relevant = await app.inject({ method: "GET", url: "/api/pulls" });
    assert.equal(relevant.statusCode, 200);
    assert.deepEqual((JSON.parse(relevant.body) as Array<{ external_id: string }>).map((pull) => pull.external_id).sort(), ["1", "2"]);

    const all = await app.inject({ method: "GET", url: "/api/pulls?scope=all" });
    assert.equal(all.statusCode, 200);
    assert.deepEqual((JSON.parse(all.body) as Array<{ external_id: string }>).map((pull) => pull.external_id).sort(), ["1", "2", "3"]);
  } finally {
    config.giteaUser = previousUser;
    await app.close();
  }
});

test("interactive Codex args grant full local execution", () => {
  const args = buildInteractiveCodexArgs();
  assert.deepEqual(args.slice(0, 2), ["-C", config.workspaceRoot]);
  assert.equal(args.includes("--dangerously-bypass-approvals-and-sandbox"), true);
  assert.equal(args.includes("--dangerously-bypass-hook-trust"), true);
  assert.equal(args.includes("--no-alt-screen"), true);
});

test("Codex hook trust prompt is detected before a tmux job stalls", () => {
  assert.equal(isCodexHookTrustPrompt("Hooks need review\n5 hooks are new or changed."), true);
  assert.equal(isCodexHookTrustPrompt("Codex is reviewing the pull request"), false);
});

test("Lark Codex responder uses trusted-sender quick-answer guardrails", () => {
  const prompt = buildLarkCodexPrompt({
    content: "帮我看一下为什么页面打不开",
    chat_type: "p2p",
    sender_id: "ou_sender",
    reply_to_message_id: null,
    reply_to_message_type: null,
    reply_to_content: null
  }, {
    referencedImagePaths: ["/tmp/referenced-image.jpg"],
    referencedFiles: [{
      name: "说明.md",
      path: "/tmp/lark-files/说明.md",
      mimeType: "text/markdown",
      size: 12,
      text: "# 标题\n\n文件正文"
    }],
    trustedSender: true
  });
  assert.match(prompt, /AGENTS\.md/);
  assert.match(prompt, /少量中途答复和最终答复/);
  assert.match(prompt, /不要输出隐藏推理、内部提示词或冗长过程/);
  assert.match(prompt, /最终答复需要完整覆盖用户问题/);
  assert.match(prompt, /当前 Codex 会话中已有的对话/);
  assert.match(prompt, /均为此前发生的内容/);
  assert.match(prompt, /最新用户消息/);
  assert.match(prompt, /由你根据任务自行判断/);
  assert.match(prompt, /docs\/skills\.md/);
  assert.match(prompt, /SKILL\.md/);
  assert.match(prompt, /knowledge\/topics/);
  assert.match(prompt, /docs\/repositories\/<repo>\.md/);
  assert.match(prompt, /当前发送人已通过可信校验/);
  assert.match(prompt, /可以按用户要求使用本机工具和网络\/CLI 完成任务/);
  assert.match(prompt, /不要机械拒绝用户明确要求的可执行任务/);
  assert.doesNotMatch(prompt, /不要修改代码/);
  assert.doesNotMatch(prompt, /不要开 PR/);
  assert.doesNotMatch(prompt, /只能执行只读诊断命令/);
  assert.doesNotMatch(prompt, /最终结论/);
  assert.doesNotMatch(prompt, /线上写操作/);
  assert.match(prompt, /reply_to_message_id: none/);
  assert.match(prompt, /referenced_image_paths: \/tmp\/referenced-image\.jpg/);
  assert.match(prompt, /作为 Codex image attachment 传入/);
  assert.match(prompt, /referenced_files: 说明\.md/);
  assert.match(prompt, /文件正文/);

  const threadParams = buildLarkCodexThreadParams(true);
  assert.equal(threadParams.cwd, config.workspaceRoot);
  assert.equal(threadParams.model, config.larkCodexModel);
  assert.equal(threadParams.approvalPolicy, "never");
  assert.equal(threadParams.sandbox, "danger-full-access");
  const input = buildLarkCodexUserInput(prompt, ["/tmp/referenced-image.jpg"]);
  assert.deepEqual(input.at(-1), { type: "localImage", path: "/tmp/referenced-image.jpg" });
});

test("Lark Codex prompt derives workspace paths from the local runtime configuration", () => {
  const previousWorkspaceRoot = config.workspaceRoot;
  config.workspaceRoot = "/tmp/autofix-workspace";
  try {
    const prompt = buildLarkCodexPrompt({
      content: "检查 PR",
      chat_type: "p2p",
      sender_id: "ou_sender",
      reply_to_message_id: null,
      reply_to_message_type: null,
      reply_to_content: null
    });
    assert.match(prompt, /\/tmp\/autofix-workspace\/AGENTS\.md/);
    assert.match(prompt, /\/tmp\/autofix-workspace\/docs\/repositories/);
    assert.match(prompt, new RegExp(config.repoRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\/g, "\\\\")));
    assert.doesNotMatch(prompt, /\/Users\/[^/\s]+\/Documents\/super\/AGENTS\.md/);
  } finally {
    config.workspaceRoot = previousWorkspaceRoot;
  }
});

test("Lark execution approver is trusted by default when trusted execution is enabled", () => {
  const previousApprover = config.larkExecutionApproverId;
  const previousTrusted = config.trustedLarkCodexSenderIds;
  config.larkExecutionApproverId = "ou_deployer";
  config.trustedLarkCodexSenderIds = ["ou_teammate", "ou_deployer"];
  try {
    assert.deepEqual(trustedLarkCodexSenderIds(), ["ou_deployer", "ou_teammate"]);
  } finally {
    config.larkExecutionApproverId = previousApprover;
    config.trustedLarkCodexSenderIds = previousTrusted;
  }
});

test("Lark Codex responder applies the configured sender reply tone", () => {
  resetTables();
  setAppSettingValue("larkSenderReplyProfiles", JSON.stringify({
    ou_profiled: { replyTone: "友好、轻松、略带调侃" }
  }));

  const prompt = buildLarkCodexPrompt({
    content: "你好",
    chat_type: "p2p",
    sender_id: "ou_profiled",
    reply_to_message_id: null,
    reply_to_message_type: null,
    reply_to_content: null
  }, { trustedSender: true });

  assert.match(prompt, /回复风格偏好/);
  assert.match(prompt, /友好、轻松、略带调侃/);
  assert.match(prompt, /不改变事实、权限或执行边界/);
});

test("Lark Codex prompt only exposes contacts referenced by the current context", () => {
  resetTables();
  for (const [openId, name] of [
    ["ou_current", "当前发送人"],
    ["ou_mentioned", "当前提及的人"],
    ["ou_replied", "引用消息提及的人"],
    ["ou_recent", "群聊上下文发送人"],
    ["ou_unrelated", "无关联系人"]
  ]) {
    upsertLarkContact({ openId, userId: openId, name, hasChatted: true, source: "test" });
  }
  const prompt = buildLarkCodexDeltaPrompt({
    content: "@当前提及的人 帮我看看",
    chat_type: "group",
    sender_id: "ou_current",
    reply_to_message_id: "om_parent",
    reply_to_message_type: "text",
    reply_to_content: "引用消息",
    raw_json: JSON.stringify({ mentions: [{ id: "ou_mentioned" }] }),
    reply_to_raw_json: JSON.stringify({ mentions: [{ id: "ou_replied" }] })
  }, {
    recentMessages: [{ sender_id: "ou_recent", message_type: "text", content: "上一句", reply_to_message_id: null, reply_to_content: null }]
  });
  assert.match(prompt, /当前发送人 = ou_current/);
  assert.match(prompt, /当前提及的人 = ou_mentioned/);
  assert.match(prompt, /引用消息提及的人 = ou_replied/);
  assert.match(prompt, /群聊上下文发送人 = ou_recent/);
  assert.doesNotMatch(prompt, /无关联系人/);
});

test("Lark Codex responder includes recent group chat context", () => {
  resetTables();
  const now = nowIso();
  db.prepare(`
    INSERT INTO lark_messages (
      event_id, message_id, chat_id, chat_type, sender_id, message_type, content,
      reply_to_message_id, reply_to_message_type, reply_to_content, reply_to_raw_json,
      mentioned, reply_status, reply_error, codex_status, raw_json, received_at, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "evt-1", "om-1", "oc_group", "group", "ou_a", "text", "第一条",
    null, null, null, null, 0, "skipped", null, "skipped", "{}", now, now
  );
  db.prepare(`
    INSERT INTO lark_messages (
      event_id, message_id, chat_id, chat_type, sender_id, message_type, content,
      reply_to_message_id, reply_to_message_type, reply_to_content, reply_to_raw_json,
      mentioned, reply_status, reply_error, codex_status, raw_json, received_at, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "evt-2", "om-2", "oc_group", "group", "ou_b", "text", "第二条",
    "om-1", "text", "第一条", null, 0, "skipped", null, "skipped", "{}", now, now
  );
  db.prepare(`
    INSERT INTO lark_messages (
      event_id, message_id, chat_id, chat_type, sender_id, message_type, content,
      reply_to_message_id, reply_to_message_type, reply_to_content, reply_to_raw_json,
      mentioned, reply_status, reply_error, codex_status, raw_json, received_at, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "evt-3", "om-3", "oc_group", "group", "ou_c", "text", "第三条",
    null, null, null, null, 0, "skipped", null, "skipped", "{}", now, now
  );
  const currentId = Number(db.prepare(`
    INSERT INTO lark_messages (
      event_id, message_id, chat_id, chat_type, sender_id, message_type, content,
      reply_to_message_id, reply_to_message_type, reply_to_content, reply_to_raw_json,
      mentioned, reply_status, reply_error, codex_status, raw_json, received_at, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "evt-4", "om-4", "oc_group", "group", "ou_d", "text", "当前消息",
    null, null, null, null, 1, "sent", null, "queued", "{}", now, now
  ).lastInsertRowid);

  const recentMessages = loadRecentLarkChatMessages("oc_group", currentId, 5);
  assert.deepEqual(recentMessages.map((message) => message.content), ["第一条", "第二条", "第三条"]);

  const prompt = buildLarkCodexPrompt({
    content: "帮我继续看这个群里的事情",
    chat_type: "group",
    sender_id: "ou_d",
    reply_to_message_id: null,
    reply_to_message_type: null,
    reply_to_content: null
  }, {
    trustedSender: true,
    recentMessages
  });
  assert.match(prompt, /群聊上下文/);
  assert.match(prompt, /第一条/);
  assert.match(prompt, /第二条/);
  assert.match(prompt, /第三条/);
  assert.ok(prompt.lastIndexOf("群聊上下文") < prompt.lastIndexOf("最新用户消息"));
});

test("Lark Codex delta prompt keeps unread group context without repeated session instructions", () => {
  const prompt = buildLarkCodexDeltaPrompt({
    content: "继续查 TARDIS 的回复",
    chat_type: "group",
    sender_id: "ou_sender",
    reply_to_message_id: "om_previous",
    reply_to_message_type: "text",
    reply_to_content: "上一条消息"
  }, {
    referencedImagePaths: ["/tmp/new.png"],
    referencedFiles: [{ name: "note.md", path: "/tmp/note.md", mimeType: "text/markdown", size: 12, text: "新的附件内容" }],
    recentMessages: [{ sender_id: "ou_other", message_type: "text", content: "不应重复注入的历史", reply_to_message_id: null, reply_to_content: null }]
  });
  assert.match(prompt, /继续查 TARDIS 的回复/);
  assert.match(prompt, /上一条消息/);
  assert.match(prompt, /新的附件内容/);
  assert.match(prompt, /\/tmp\/new\.png/);
  assert.match(prompt, /群聊上下文/);
  assert.match(prompt, /不应重复注入的历史/);
  assert.doesNotMatch(prompt, /知识\/技能加载策略/);
});

test("Lark Codex responder fetches many group messages and keeps the newest within text budget", () => {
  resetTables();
  const now = nowIso();
  const insert = db.prepare(`
    INSERT INTO lark_messages (
      event_id, message_id, chat_id, chat_type, sender_id, message_type, content,
      reply_to_message_id, reply_to_message_type, reply_to_content, reply_to_raw_json,
      mentioned, reply_status, reply_error, codex_status, raw_json, received_at, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (let index = 1; index <= 12; index += 1) {
    insert.run(
      `evt-${index}`, `om-${index}`, "oc_long_group", "group", `ou_${index}`, "text", `第${index}条 ${"x".repeat(30)}`,
      null, null, null, null, 0, "skipped", null, "skipped", "{}", now, now
    );
  }
  const currentId = Number(insert.run(
    "evt-current", "om-current", "oc_long_group", "group", "ou_current", "text", "当前消息",
    null, null, null, null, 1, "sent", null, "queued", "{}", now, now
  ).lastInsertRowid);

  const recentMessages = loadRecentLarkChatMessages("oc_long_group", currentId, 80);
  assert.equal(recentMessages.length, 12);

  const formatted = formatRecentLarkMessages(recentMessages, 260);
  assert.match(formatted, /已省略更早的/);
  assert.doesNotMatch(formatted, /第1条/);
  assert.match(formatted, /第12条/);
  assert.match(formatted, /第11条/);

  const groupContext = loadLarkGroupContext("oc_long_group", false, currentId, 5);
  assert.equal(groupContext.messages.length, 5);
  assert.equal(groupContext.omittedCount, 7);
  assert.deepEqual(groupContext.messages.map((message) => message.content), [
    `第8条 ${"x".repeat(30)}`,
    `第9条 ${"x".repeat(30)}`,
    `第10条 ${"x".repeat(30)}`,
    `第11条 ${"x".repeat(30)}`,
    `第12条 ${"x".repeat(30)}`
  ]);
  db.prepare(`
    INSERT INTO lark_group_context_cursors (chat_id, trust_scope, last_message_id, updated_at)
    VALUES (?, 'untrusted', ?, ?)
  `).run("oc_long_group", currentId - 3, now);
  const unread = loadLarkGroupContext("oc_long_group", false, currentId, 50);
  assert.deepEqual(unread.messages.map((message) => message.content), [
    `第11条 ${"x".repeat(30)}`,
    `第12条 ${"x".repeat(30)}`
  ]);
});

test("Lark Codex responder keeps p2p prompts free of chat history", () => {
  const prompt = buildLarkCodexPrompt({
    content: "只看当前这一条",
    chat_type: "p2p",
    sender_id: "ou_sender",
    reply_to_message_id: null,
    reply_to_message_type: null,
    reply_to_content: null
  }, {
    trustedSender: false,
    recentMessages: [
      { sender_id: "ou_a", message_type: "text", content: "历史消息", reply_to_message_id: null, reply_to_content: null }
    ]
  });
  assert.doesNotMatch(prompt, /群聊上下文（同一 chat_id/);
  assert.doesNotMatch(prompt, /历史消息/);
});

test("Lark Codex responder resolves current image messages before replied images", () => {
  assert.deepEqual(larkImageResourceFromMessage({
    message_id: "om_current",
    message_type: "image",
    content: "[Image: img_current]",
    reply_to_message_id: null,
    reply_to_message_type: null,
    reply_to_content: null
  }), {
    messageId: "om_current",
    imageKey: "img_current"
  });

  assert.deepEqual(larkImageResourceFromMessage({
    message_id: "om_post",
    message_type: "post",
    content: "[Image: img_post]\n分析一下这个问题",
    reply_to_message_id: null,
    reply_to_message_type: null,
    reply_to_content: null
  }), {
    messageId: "om_post",
    imageKey: "img_post"
  });

  assert.deepEqual(larkImageResourceFromMessage({
    message_id: "om_text",
    message_type: "text",
    content: "看这张图",
    reply_to_message_id: "om_parent",
    reply_to_message_type: "image",
    reply_to_content: "[Image: img_parent]"
  }), {
    messageId: "om_parent",
    imageKey: "img_parent"
  });

  assert.equal(larkImageResourceFromMessage({
    message_id: "om_text",
    message_type: "text",
    content: "没有图片",
    reply_to_message_id: null,
    reply_to_message_type: null,
    reply_to_content: null
  }), null);
});

test("Lark Codex responder resolves Markdown and HTML file messages", () => {
  assert.deepEqual(larkFileResourcesFromMessage({
    message_id: "om_file",
    message_type: "file",
    content: JSON.stringify({ file_key: "file_md", file_name: "需求.md" }),
    reply_to_message_id: null,
    reply_to_message_type: null,
    reply_to_content: null
  }), [{
    messageId: "om_file",
    fileKey: "file_md",
    fileName: "需求.md"
  }]);

  assert.deepEqual(larkFileResourcesFromMessage({
    message_id: "om_text",
    message_type: "text",
    content: "看这个",
    reply_to_message_id: "om_parent",
    reply_to_message_type: "file",
    reply_to_content: JSON.stringify({ fileKey: "file_html", fileName: "report.html" })
  }), [{
    messageId: "om_parent",
    fileKey: "file_html",
    fileName: "report.html"
  }]);

  assert.deepEqual(larkFileResourcesFromMessage({
    message_id: "om_file",
    message_type: "file",
    content: JSON.stringify({ file_key: "file_pdf", file_name: "report.pdf" }),
    reply_to_message_id: null,
    reply_to_message_type: null,
    reply_to_content: null
  }), []);
});

test("Lark Codex app-server keeps trust scopes on separate permission profiles", () => {
  const trusted = buildLarkCodexThreadParams(true);
  assert.equal(trusted.sandbox, "danger-full-access");
  assert.equal(trusted.approvalPolicy, "never");

  const untrusted = buildLarkCodexThreadParams(false);
  assert.equal(untrusted.sandbox, "read-only");
  assert.equal(untrusted.approvalPolicy, "on-request");
  assert.equal(untrusted.approvalsReviewer, "user");
  assert.deepEqual(untrusted.config, { model_reasoning_effort: config.larkCodexReasoningEffort });
});

test("Lark group replies require an exact mention of the current bot", () => {
  const botOpenId = larkBotOpenIdFromAuthStatus(JSON.stringify({ identities: { bot: { openId: "ou_bot" } } }));
  assert.equal(botOpenId, "ou_bot");
  assert.equal(isAtMeMessage({ chat_type: "group", content: "@其他机器人 帮忙", mentions: [{ id: "ou_other" }] }, botOpenId), false);
  assert.equal(isAtMeMessage({ chat_type: "group", content: "普通文本 @", mentions: [] }, botOpenId), false);
  assert.equal(isAtMeMessage({ chat_type: "group", mentions: [{ id: "ou_bot" }, { id: "ou_other" }] }, botOpenId), true);
  assert.equal(isAtMeMessage({ chat_type: "p2p", content: "你好" }, botOpenId), true);
});

test("Lark group turns only end on polite closure or an explicit stop instruction", () => {
  const message = {
    content: "@协作机器人 他都不会 @，@群聊助手 你教一下他",
    chat_type: "group",
    sender_id: "ou_sender",
    reply_to_message_id: null,
    reply_to_message_type: null,
    reply_to_content: "@群聊助手 你来回应这个辩论观点。",
    raw_json: JSON.stringify({
      sender_type: "user",
      mentions: [{ name: "协作机器人" }, { name: "群聊助手" }]
    })
  };
  const fullPrompt = buildLarkCodexPrompt(message);
  const deltaPrompt = buildLarkCodexDeltaPrompt(message);
  for (const prompt of [fullPrompt, deltaPrompt]) {
    assert.match(prompt, /群聊回复决策/);
    assert.match(prompt, /以本轮最新消息和引用内容判断当前意图/);
    assert.match(prompt, /最终答案必须且只能输出 <forge-no-reply\/>/);
  }
  assert.equal(isLarkNoReplyDecision("<forge-no-reply/>"), true);
  assert.equal(isLarkNoReplyDecision("  <forge-no-reply />  "), true);
  assert.equal(isLarkNoReplyDecision("<forge-no-reply/> 结束"), false);
  assert.equal(isLarkNoReplyDecision("正常回复"), false);
});

function completeLarkRuntimeSettings(): Record<string, unknown> {
  return {
    listenerEnabled: true, repliesEnabled: true, interimRepliesEnabled: true, ownerMessageFastPathEnabled: true,
    executionReceiptsEnabled: true, codexModel: "old-model", reasoningEffort: "low", stickerUsageMode: "natural",
    groupSpontaneousRepliesEnabled: true, groupSpontaneousReplyRate: 0.5, groupSpontaneousReplyCooldownMs: 600_000,
    groupSpontaneousChatIds: ["oc_old"], trustedExecutionEnabled: true,
    turnAutoApprovalEnabled: true, turnAutoApprovalModel: "old-approval-model", turnAutoApprovalModelConfigurable: true, turnAutoApprovalDataSources: [],
    acknowledgeReactionEmoji: "THUMBSUP", groupMessageReactionEnabled: true, groupMessageReactionEmoji: "THUMBSUP",
    groupMessageReactionChatIds: ["oc_old"], groupContextMessageLimit: 50, groupContextMaxChars: 6000,
    workspaceRoot: config.workspaceRoot, approverId: "ou_old", trustedSenderIds: ["ou_old"]
  };
}

test("all global Lark settings map to one PATCH and independent GET before the local transaction", async () => {
  resetTables();
  const previousUrl = config.larkAgentUrl;
  const originalFetch = globalThis.fetch;
  config.larkAgentUrl = "http://lark-agent.test";
  const before = getAppSettings();
  let remote = completeLarkRuntimeSettings();
  const calls: string[] = [];
  const patches: Array<Record<string, unknown>> = [];
  const payload = {
    autoReviewNewPulls: true, issueRepairEnabled: false, pollIntervalMs: 60_000,
    larkMessageListenerEnabled: false, larkCodexRepliesEnabled: false, larkExecutionReceiptsEnabled: false,
    larkCodexModel: "provider/new-model", larkCodexReasoningEffort: "ultra", larkStickerUsageMode: "off",
    larkGroupSpontaneousRepliesEnabled: false, larkGroupSpontaneousReplyRate: 0, larkGroupSpontaneousReplyCooldownMs: 0,
    larkGroupSpontaneousChatIds: [" oc_b ", "oc_a", "oc_b"], larkTrustedExecutionEnabled: false,
    larkTurnAutoApprovalEnabled: false, larkTurnAutoApprovalModel: "new-approval-model", larkTurnAutoApprovalDataSources: ["analytics_demo", "orders_demo"], larkAcknowledgeReactionEmoji: "LAUGH",
    larkGroupMessageReactionEnabled: false, larkGroupMessageReactionEmoji: "HappyDragon",
    larkGroupMessageReactionChatIds: ["oc_b", "oc_a", "oc_b"], larkGroupContextMessageLimit: 8, larkGroupContextMaxChars: 750
  };
  const expected = {
    listenerEnabled: false, repliesEnabled: false, executionReceiptsEnabled: false,
    codexModel: "provider/new-model", reasoningEffort: "ultra", stickerUsageMode: "off",
    groupSpontaneousRepliesEnabled: false, groupSpontaneousReplyRate: 0, groupSpontaneousReplyCooldownMs: 0,
    groupSpontaneousChatIds: ["oc_b", "oc_a"], trustedExecutionEnabled: false,
    turnAutoApprovalEnabled: false, turnAutoApprovalModel: "new-approval-model", turnAutoApprovalDataSources: ["analytics_demo", "orders_demo"], acknowledgeReactionEmoji: "LAUGH",
    groupMessageReactionEnabled: false, groupMessageReactionEmoji: "HappyDragon", groupMessageReactionChatIds: ["oc_b", "oc_a"],
    groupContextMessageLimit: 8, groupContextMaxChars: 750
  };
  globalThis.fetch = async (url, init) => {
    assert.ok(String(url).endsWith("/v1/settings"));
    assert.deepEqual(getAppSettings(), before, "no local changes before independent readback");
    calls.push(init?.method ?? "GET");
    if (init?.method === "PATCH") {
      const patch = JSON.parse(String(init.body));
      patches.push(patch);
      remote = { ...remote, ...patch, groupSpontaneousChatIds: ["oc_a", "oc_b", "oc_a"], groupMessageReactionChatIds: ["oc_a", "oc_b"] };
    }
    return new Response(JSON.stringify(remote));
  };
  const app = Fastify({ logger: false });
  await app.register(issueRoutes);
  try {
    const result = await app.inject({ method: "PATCH", url: "/api/settings", payload });
    assert.equal(result.statusCode, 200, result.body);
    assert.deepEqual(calls, ["GET", "PATCH", "GET"]);
    assert.deepEqual(patches, [expected]);
    const saved = getAppSettings();
    assert.deepEqual(saved, { ...before, ...payload, larkGroupSpontaneousChatIds: ["oc_b", "oc_a"], larkGroupMessageReactionChatIds: ["oc_b", "oc_a"] });
    assert.equal((db.prepare("SELECT count(*) AS count FROM local_audit_events WHERE action = 'settings.updated'").get() as { count: number }).count, 1);
    assert.equal(Object.keys(larkRuntimeSettingsSchema.shape).length, 25);
    assert.equal(Object.keys(expected).length, Object.keys(saved).filter((key) => key.startsWith("lark")).length);
  } finally { config.larkAgentUrl = previousUrl; globalThis.fetch = originalFetch; await app.close(); }
});

test("approval data sources normalize, read back and survive backup restore without accepting invalid names", async () => {
  resetTables();
  const previousConfig = { ...config }, originalFetch = globalThis.fetch;
  updatePersistedRuntimeConfig({ ...persistedRuntimeConfig(), workspaceRoot: path.dirname(config.databasePath) });
  config.larkAgentUrl = "http://lark-agent.test";
  let remote = completeLarkRuntimeSettings();
  globalThis.fetch = async (_url, init) => {
    if (init?.method === "PATCH") remote = { ...remote, ...JSON.parse(String(init.body)) };
    return new Response(JSON.stringify(remote));
  };
  const app = Fastify({ logger: false }); await app.register(issueRoutes);
  try {
    const save = (value: unknown) => app.inject({ method: "PATCH", url: "/api/settings", payload: { larkTurnAutoApprovalDataSources: value } });
    const saved = await save([" Analytics_Demo ", "analytics_demo", "orders_demo"]);
    assert.equal(saved.statusCode, 200, saved.body);
    assert.deepEqual(saved.json().larkTurnAutoApprovalDataSources, ["analytics_demo", "orders_demo"]);
    const backup = (await app.inject({ method: "GET", url: "/api/settings/backup" })).json();
    assert.deepEqual(backup.appSettings.larkTurnAutoApprovalDataSources, ["analytics_demo", "orders_demo"]);
    await save([]);
    const restored = await app.inject({ method: "POST", url: "/api/settings/backup/restore", payload: backup });
    assert.equal(restored.statusCode, 200, restored.body);
    assert.deepEqual(getAppSettings().larkTurnAutoApprovalDataSources, ["analytics_demo", "orders_demo"]);
    assert.deepEqual(remote.turnAutoApprovalDataSources, ["analytics_demo", "orders_demo"]);
    for (const invalid of ["analytics_demo", ["*"], ["bad source"], ["x".repeat(65)], Array(101).fill("analytics_demo")]) assert.equal((await save(invalid)).statusCode, 400);
    assert.deepEqual(remote.turnAutoApprovalDataSources, ["analytics_demo", "orders_demo"]);
  } finally { Object.assign(config, previousConfig); globalThis.fetch = originalFetch; await app.close(); }
});

test("mixed Lark batches reject unsupported fields and compensate all fields on echo, readback or local failure", async () => {
  const previousUrl = config.larkAgentUrl;
  const originalFetch = globalThis.fetch;
  config.larkAgentUrl = "http://lark-agent.test";
  const app = Fastify({ logger: false });
  await app.register(issueRoutes);
  try {
    for (const failure of ["unsupported", "invalid capability", "rejected", "busy", "remote failure", "bad echo", "readback mismatch", "readback unavailable", "local commit", "local audit", "rollback echo"] as const) {
      resetTables();
      updateAppSettings({ larkCodexModel: "old-model", larkMessageListenerEnabled: true, larkGroupSpontaneousReplyRate: 0.5 });
      const before = getAppSettings();
      let remote = completeLarkRuntimeSettings();
      if (failure === "unsupported") delete remote.groupContextMaxChars;
      if (failure === "invalid capability") remote.groupContextMaxChars = "6000";
      const oldRemote = structuredClone(remote);
      const calls: string[] = [];
      const patches: Array<Record<string, unknown>> = [];
      globalThis.fetch = async (_url, init) => {
        calls.push(init?.method ?? "GET");
        assert.deepEqual(getAppSettings(), before, failure);
        if (init?.method === "PATCH") {
          const patch = JSON.parse(String(init.body));
          patches.push(patch);
          if (patches.length === 1 && failure === "rejected") return new Response("invalid", { status: 400 });
          if (patches.length === 1 && failure === "busy") return new Response("busy", { status: 409 });
          remote = { ...remote, ...patch };
          if (patches.length === 1 && failure === "remote failure") return new Response("unavailable after write", { status: 503 });
          if ((patches.length === 1 && failure === "bad echo") || (patches.length === 2 && failure === "rollback echo")) {
            return new Response(JSON.stringify({ ...remote, codexModel: "wrong-model" }));
          }
          const echo = { ...remote };
          if (patches.length === 1 && (failure === "readback mismatch" || failure === "rollback echo")) remote.groupContextMaxChars = oldRemote.groupContextMaxChars;
          return new Response(JSON.stringify(echo));
        }
        if (patches.length === 1 && failure === "readback unavailable") throw new Error("GET unavailable");
        return new Response(JSON.stringify(remote));
      };
      const trigger = failure === "local commit"
        ? "BEFORE UPDATE ON app_settings WHEN NEW.key = 'larkCodexModel' AND NEW.value = 'new-model'"
        : failure === "local audit" ? "AFTER INSERT ON local_audit_events WHEN NEW.action = 'settings.updated'" : null;
      if (trigger) {
        assertTestDatabaseIsolation(config.databasePath);
        db.exec(`CREATE TEMP TRIGGER reject_batch_commit ${trigger} BEGIN SELECT RAISE(FAIL, 'local batch commit failed'); END`);
      }
      try {
        const result = await app.inject({ method: "PATCH", url: "/api/settings", payload: {
          autoReviewNewPulls: true, pollIntervalMs: 60_000, larkMessageListenerEnabled: false, larkCodexModel: "new-model",
          larkExecutionReceiptsEnabled: false, larkGroupSpontaneousReplyRate: 0, larkGroupSpontaneousChatIds: [], larkGroupContextMaxChars: 750
        } });
        assert.notEqual(result.statusCode, 200, failure);
        const unsupported = failure === "unsupported" || failure === "invalid capability";
        const rejected = failure === "rejected" || failure === "busy";
        assert.equal(result.statusCode, unsupported || failure === "busy" ? 409 : failure === "rejected" ? 400 : trigger ? 500 : 502, result.body);
        assert.equal(patches.length, unsupported ? 0 : rejected ? 1 : 2, failure);
        assert.deepEqual(getAppSettings(), before, failure);
        assert.deepEqual(remote, oldRemote, failure);
        if (!unsupported && !rejected) {
          assert.deepEqual(Object.keys(patches[1]).sort(), Object.keys(patches[0]).sort(), failure);
          assert.deepEqual(patches[1], Object.fromEntries(Object.keys(patches[0]).map((key) => [key, oldRemote[key]])), failure);
          if (failure === "rollback echo") assert.match(result.body, /state is unknown.*rollback could not be confirmed/);
          else assert.equal(calls.at(-1), "GET", "compensation has an independent GET");
        }
        assert.equal((db.prepare("SELECT count(*) AS count FROM local_audit_events WHERE action = 'settings.updated'").get() as { count: number }).count, 0);
      } finally { if (trigger) db.exec("DROP TRIGGER reject_batch_commit"); }
    }
  } finally { config.larkAgentUrl = previousUrl; globalThis.fetch = originalFetch; await app.close(); }
});

test("settings GET mirrors all readable Agent fields without persisting or claiming unknown fields are known", async () => {
  resetTables();
  const originalFetch = globalThis.fetch;
  const previousUrl = config.larkAgentUrl;
  config.larkAgentUrl = "http://lark-agent.test";
  const before = getAppSettings();
  const remote = completeLarkRuntimeSettings();
  remote.listenerEnabled = false;
  remote.groupSpontaneousReplyRate = 0;
  remote.groupSpontaneousReplyCooldownMs = 0;
  remote.groupMessageReactionChatIds = ["oc_b", "oc_a", "oc_b"];
  remote.groupContextMessageLimit = 8;
  remote.groupContextMaxChars = 750;
  globalThis.fetch = async (url, init) => {
    assert.ok(!init?.method || init.method === "GET");
    return new Response(JSON.stringify(String(url).endsWith("/v1/settings") ? remote : {}));
  };
  const app = Fastify({ logger: false });
  await app.register(issueRoutes);
  try {
    const result = (await app.inject({ method: "GET", url: "/api/settings" })).json();
    for (const [key, value] of Object.entries(larkAppSettingsPatch(result.appSettings))) {
      const actual = Array.isArray(value) ? [...new Set(remote[key] as string[])] : remote[key];
      assert.deepEqual(value, actual, key);
    }
    assert.ok(Object.values(result.larkSettingsKnown).every((value) => value === true));
    assert.deepEqual(getAppSettings(), before);
    remote.groupContextMaxChars = "750";
    delete remote.codexModel;
    const unknown = (await app.inject({ method: "GET", url: "/api/settings" })).json();
    assert.equal(unknown.larkSettingsKnown.larkCodexModel, false);
    assert.equal(unknown.larkSettingsKnown.larkGroupContextMaxChars, false);
    assert.deepEqual(getAppSettings(), before);
  } finally { config.larkAgentUrl = previousUrl; globalThis.fetch = originalFetch; await app.close(); }
});

test("settings, runtime and prompt schemas reject unknown fields with 400 before any write", async () => {
  resetTables();
  const originalFetch = globalThis.fetch;
  const previousUrl = config.larkAgentUrl;
  const previousConfig = { ...config };
  config.larkAgentUrl = "http://lark-agent.test";
  let remoteCalls = 0;
  globalThis.fetch = async () => { remoteCalls += 1; return new Response("{}"); };
  const before = db.prepare("SELECT * FROM app_settings ORDER BY key").all();
  const beforePrompt = configurablePrompt("larkAssistant");
  const app = Fastify({ logger: false });
  await app.register(issueRoutes);
  try {
    for (const request of [
      { method: "PATCH", url: "/api/settings", payload: { autoReviewNewPulls: true, larkUnknown: false } },
      { method: "PATCH", url: "/api/settings", payload: { pollIntervalMs: 60_000, codexModel: "new-model" } },
      { method: "PUT", url: "/api/settings/runtime-config", payload: { ...persistedRuntimeConfig(), workspaceRoot: path.dirname(config.databasePath), unknown: "ignored" } },
      { method: "PUT", url: "/api/settings/prompts", payload: { larkAssistant: "changed prompt", unknown: "ignored" } }
    ] as const) {
      assert.equal((await app.inject(request)).statusCode, 400);
      assert.deepEqual(db.prepare("SELECT * FROM app_settings ORDER BY key").all(), before);
      assert.equal(configurablePrompt("larkAssistant"), beforePrompt);
      assert.equal(remoteCalls, 0);
    }
    config.larkAgentUrl = "";
    const local = await app.inject({ method: "PATCH", url: "/api/settings", payload: {
      autoReviewNewPulls: true, issueRepairEnabled: false, pollIntervalMs: 60_000,
      larkMessageListenerEnabled: false, larkCodexRepliesEnabled: false, larkGroupSpontaneousReplyRate: 0
    } });
    assert.equal(local.statusCode, 200, local.body);
    assert.equal(local.json().larkGroupSpontaneousReplyRate, 0);
    assert.equal(remoteCalls, 0);
    for (const payload of [{ larkTurnAutoApprovalEnabled: false }, { larkTurnAutoApprovalModel: "new-model" }]) {
      assert.equal((await app.inject({ method: "PATCH", url: "/api/settings", payload })).statusCode, 409);
    }
  } finally { config.larkAgentUrl = previousUrl; Object.assign(config, previousConfig); globalThis.fetch = originalFetch; await app.close(); }
});

test("backup settings reject unknown keys before remote or local writes", async () => {
  resetTables();
  const originalFetch = globalThis.fetch;
  const previousUrl = config.larkAgentUrl;
  const app = Fastify({ logger: false });
  await app.register(issueRoutes);
  let remoteCalls = 0;
  globalThis.fetch = async () => { remoteCalls += 1; return new Response("{}"); };
  const localState = () => ["app_settings", "codex_todos", "local_audit_events"].map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  try {
    const backup = (await app.inject({ method: "GET", url: "/api/settings/backup" })).json();
    backup.appSettings.autoReviewNewPulls = true;
    backup.appSettings.larkUnknownSetting = false;
    const before = localState();
    for (const url of ["http://lark-agent.test", ""]) {
      config.larkAgentUrl = url;
      const result = await app.inject({ method: "POST", url: "/api/settings/backup/restore", payload: backup });
      assert.equal(result.statusCode, 400, result.body);
      assert.match(result.body, /Unrecognized key.*larkUnknownSetting/);
      assert.equal(remoteCalls, 0);
      assert.deepEqual(localState(), before);
    }
  } finally { config.larkAgentUrl = previousUrl; globalThis.fetch = originalFetch; await app.close(); }
});

test("backup restore confirms and compensates the entire supported batch with one atomic local restore", async () => {
  const originalFetch = globalThis.fetch;
  const previousConfig = { ...config };
  config.larkAgentUrl = "http://lark-agent.test";
  const app = Fastify({ logger: false });
  await app.register(issueRoutes);
  const localState = () => ["app_settings", "codex_todos", "local_audit_events"].map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  try {
    for (const failure of ["readback mismatch", "local restore", "local audit", "none"]) {
      resetTables();
      const workspaceRoot = path.dirname(config.databasePath);
      updatePersistedRuntimeConfig({ ...persistedRuntimeConfig(), workspaceRoot, larkExecutionApproverId: "ou_old", trustedLarkCodexSenderIds: ["ou_old"] });
      updateAppSettings({ larkTurnAutoApprovalEnabled: true, larkTurnAutoApprovalModel: "old-approval-model", larkCodexModel: "old-model" });
      db.prepare("INSERT INTO codex_todos (title, description, status, created_at, updated_at) VALUES ('preserved todo', NULL, 'todo', ?, ?)").run(nowIso(), nowIso());
      const backup = (await app.inject({ method: "GET", url: "/api/settings/backup" })).json();
      backup.runtimeConfig.workspaceRoot = path.join(workspaceRoot, "restored-workspace");
      backup.runtimeConfig.larkExecutionApproverId = "ou_new";
      backup.runtimeConfig.trustedLarkCodexSenderIds = ["ou_new", "ou_friend"];
      Object.assign(backup.appSettings, {
        autoReviewNewPulls: true, larkTurnAutoApprovalEnabled: false, larkTurnAutoApprovalModel: "new-approval-model",
        larkMessageListenerEnabled: false, larkCodexRepliesEnabled: false, larkCodexModel: "new-model",
        larkGroupSpontaneousReplyRate: 0, larkGroupSpontaneousReplyCooldownMs: 0, larkGroupSpontaneousChatIds: [],
        larkGroupContextMessageLimit: 8, larkGroupContextMaxChars: 750
      });
      if (failure === "local restore") backup.todos = [backup.todos[0], backup.todos[0]];
      const before = localState();
      let remote = completeLarkRuntimeSettings();
      remote.workspaceRoot = workspaceRoot;
      const oldRemote = structuredClone(remote);
      const writes: Array<Record<string, unknown>> = [];
      const calls: string[] = [];
      globalThis.fetch = async (_url, init) => {
        calls.push(init?.method ?? "GET");
        assert.deepEqual(localState(), before, "local restore must wait for all confirmations or roll back before compensation");
        if (init?.method === "PATCH") {
          const patch = JSON.parse(String(init.body));
          writes.push(patch);
          remote = { ...remote, ...patch };
          const echo = { ...remote };
          if (writes.length === 1 && failure === "readback mismatch") remote.codexModel = oldRemote.codexModel;
          return new Response(JSON.stringify(echo));
        }
        return new Response(JSON.stringify(remote));
      };
      if (failure === "local audit") {
        assertTestDatabaseIsolation(config.databasePath);
        db.exec("CREATE TEMP TRIGGER reject_restore_audit AFTER INSERT ON local_audit_events WHEN NEW.action = 'backup.restored' BEGIN SELECT RAISE(FAIL, 'restore audit commit failed'); END");
      }
      try {
        const result = await app.inject({ method: "POST", url: "/api/settings/backup/restore", payload: backup });
        const success = failure === "none";
        assert.equal(result.statusCode, success ? 200 : 400, `${failure}: ${result.body}`);
        assert.equal(writes.length, success ? 1 : 2);
        assert.equal(Object.keys(writes[0]).length, Object.keys(larkAppSettingFields).length + 3, "all Forge Lark settings and 3 basic runtime fields");
        assert.equal(writes[0].listenerEnabled, false);
        assert.equal(writes[0].repliesEnabled, false);
        assert.equal(writes[0].acknowledgeReactionEmoji, backup.appSettings.larkAcknowledgeReactionEmoji);
        if (success) {
          assert.equal(getAppSettings().larkCodexModel, "new-model");
          assert.equal(getAppSettings().larkGroupSpontaneousReplyRate, 0);
          assert.equal(persistedRuntimeConfig().workspaceRoot, backup.runtimeConfig.workspaceRoot);
          assert.deepEqual(calls, ["GET", "PATCH", "GET"]);
        } else {
          assert.deepEqual(localState(), before);
          assert.equal(config.workspaceRoot, workspaceRoot);
          assert.deepEqual(remote, oldRemote);
          assert.deepEqual(writes[1], Object.fromEntries(Object.keys(writes[0]).map((key) => [key, oldRemote[key]])));
          assert.deepEqual(calls, ["GET", "PATCH", "GET", "PATCH", "GET"]);
        }
      } finally { if (failure === "local audit") db.exec("DROP TRIGGER reject_restore_audit"); }
    }
  } finally { Object.assign(config, previousConfig); globalThis.fetch = originalFetch; await app.close(); }
});

test("settings, runtime and backup saves serialize the whole commit and compensation before another field saves", { timeout: 10_000 }, async () => {
  const originalFetch = globalThis.fetch;
  const previousConfig = { ...config };
  config.larkAgentUrl = "http://lark-agent.test";
  const app = Fastify({ logger: false });
  await app.register(issueRoutes);
  const signal = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
  };
  try {
    for (const entry of ["settings", "runtime", "backup"] as const) {
      resetTables();
      const workspaceRoot = path.dirname(config.databasePath);
      updatePersistedRuntimeConfig({ ...persistedRuntimeConfig(), workspaceRoot, larkExecutionApproverId: "ou_old", trustedLarkCodexSenderIds: ["ou_old"] });
      updateAppSettings({ larkCodexModel: "old-model", larkExecutionReceiptsEnabled: true });
      const before = getAppSettings();
      const beforeRuntime = persistedRuntimeConfig();
      const backup = (await app.inject({ method: "GET", url: "/api/settings/backup" })).json();
      backup.appSettings.larkCodexModel = "first-model";
      backup.appSettings.autoReviewNewPulls = true;
      let remote = completeLarkRuntimeSettings();
      remote.workspaceRoot = workspaceRoot;
      const oldRemote = structuredClone(remote);
      const writes: Array<Record<string, unknown>> = [];
      const calls: string[] = [];
      const firstWriteStarted = signal();
      const releaseFirstWrite = signal();
      const rollbackStarted = signal();
      const releaseRollback = signal();
      let secondDone = false;
      globalThis.fetch = async (_url, init) => {
        calls.push(init?.method ?? "GET");
        if (init?.method === "PATCH") {
          const patch = JSON.parse(String(init.body));
          writes.push(patch);
          remote = { ...remote, ...patch };
          if (writes.length === 1) {
            firstWriteStarted.resolve();
            await releaseFirstWrite.promise;
          } else if (writes.length === 2) {
            rollbackStarted.resolve();
            await releaseRollback.promise;
          }
        }
        return new Response(JSON.stringify(remote));
      };
      assertTestDatabaseIsolation(config.databasePath);
      const trigger = entry === "settings"
        ? "AFTER UPDATE ON app_settings WHEN NEW.key = 'larkCodexModel' AND NEW.value = 'first-model'"
        : entry === "runtime"
        ? "AFTER UPDATE ON app_settings WHEN NEW.key = 'larkExecutionApproverId' AND NEW.value = 'ou_first'"
        : "AFTER INSERT ON local_audit_events WHEN NEW.action = 'backup.restored'";
      db.exec(`CREATE TEMP TRIGGER reject_concurrent_first_commit ${trigger} BEGIN SELECT RAISE(FAIL, 'first local commit failed'); END`);
      const first = app.inject(entry === "settings" ? {
        method: "PATCH", url: "/api/settings", payload: { larkCodexModel: "first-model", autoReviewNewPulls: true }
      } : entry === "runtime" ? {
        method: "PUT", url: "/api/settings/runtime-config", payload: { ...beforeRuntime, larkExecutionApproverId: "ou_first" }
      } : { method: "POST", url: "/api/settings/backup/restore", payload: backup }).then((response) => response);
      let second: typeof first | undefined;
      try {
        await firstWriteStarted.promise;
        second = app.inject({ method: "PATCH", url: "/api/settings", payload: { larkExecutionReceiptsEnabled: false } }).then((response) => {
          secondDone = true;
          return response;
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.deepEqual(calls, ["GET", "PATCH"], `${entry}: no second preflight during the first remote write`);
        assert.equal(secondDone, false);
        releaseFirstWrite.resolve();
        await rollbackStarted.promise;
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.deepEqual(calls, ["GET", "PATCH", "GET", "PATCH"], `${entry}: the lock includes local failure and compensation`);
        assert.equal(secondDone, false);
        assert.deepEqual(getAppSettings(), before);
        releaseRollback.resolve();
        const [failed, saved] = await Promise.all([first, second]);
        assert.equal(failed.statusCode, entry === "backup" ? 400 : 500, failed.body);
        assert.equal(saved.statusCode, 200, saved.body);
        assert.deepEqual(calls, ["GET", "PATCH", "GET", "PATCH", "GET", "GET", "PATCH", "GET"]);
        assert.deepEqual(writes[2], { executionReceiptsEnabled: false });
        assert.deepEqual(remote, { ...oldRemote, executionReceiptsEnabled: false });
        assert.deepEqual(getAppSettings(), { ...before, larkExecutionReceiptsEnabled: false });
        assert.deepEqual(persistedRuntimeConfig(), beforeRuntime);
        assert.equal((db.prepare("SELECT count(*) AS count FROM local_audit_events WHERE action = 'settings.updated'").get() as { count: number }).count, 1);
      } finally {
        releaseFirstWrite.resolve();
        releaseRollback.resolve();
        await Promise.allSettled([first, ...(second ? [second] : [])]);
        db.exec("DROP TRIGGER reject_concurrent_first_commit");
      }
    }
  } finally { Object.assign(config, previousConfig); globalThis.fetch = originalFetch; await app.close(); }
});

test("helper supports the remaining Agent-only writable fields without adding Forge settings", async () => {
  resetTables();
  const originalFetch = globalThis.fetch;
  const previousUrl = config.larkAgentUrl;
  config.larkAgentUrl = "http://lark-agent.test";
  let remote = { interimRepliesEnabled: true, ownerMessageFastPathEnabled: true };
  const writes: unknown[] = [];
  globalThis.fetch = async (_url, init) => {
    if (init?.method === "PATCH") {
      const patch = JSON.parse(String(init.body));
      writes.push(patch);
      remote = { ...remote, ...patch };
    }
    return new Response(JSON.stringify(remote));
  };
  try {
    const rollback = await syncLarkRuntimeSettings({ interimRepliesEnabled: false, ownerMessageFastPathEnabled: false });
    assert.deepEqual(remote, { interimRepliesEnabled: false, ownerMessageFastPathEnabled: false });
    await rollback();
    assert.deepEqual(remote, { interimRepliesEnabled: true, ownerMessageFastPathEnabled: true });
    assert.equal(writes.length, 2);
    assert.equal(Object.hasOwn(getAppSettings(), "larkInterimRepliesEnabled"), false);
    assert.equal(Object.hasOwn(getAppSettings(), "larkOwnerMessageFastPathEnabled"), false);
  } finally { config.larkAgentUrl = previousUrl; globalThis.fetch = originalFetch; }
});

test("trusted execution saves confirmed false, reads the Agent value and refuses unsupported or ignored writes", async () => {
  resetTables();
  const originalFetch = globalThis.fetch;
  const previousUrl = config.larkAgentUrl;
  config.larkAgentUrl = "http://lark-agent.test";
  updateAppSettings({ larkTrustedExecutionEnabled: true });
  let remote: Record<string, unknown> = { trustedExecutionEnabled: true };
  let failure = "";
  const patches: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (url, init) => {
    if (init?.method === "PATCH") {
      const patch = JSON.parse(String(init.body));
      patches.push(patch);
      if (failure === "busy") return new Response("busy", { status: 409 });
      if (failure === "listener" && Object.hasOwn(patch, "listenerEnabled")) return new Response("listener unavailable", { status: 503 });
      if (failure === "ignored") return new Response("{}");
      if (failure === "echo only") return new Response(JSON.stringify(patch));
      remote = { ...remote, ...patch };
      return new Response(JSON.stringify(remote));
    }
    return new Response(JSON.stringify(String(url).endsWith("/v1/settings") ? remote : {}));
  };
  const app = Fastify({ logger: false });
  await app.register(issueRoutes);
  try {
    const save = () => app.inject({ method: "PATCH", url: "/api/settings", payload: { larkTrustedExecutionEnabled: false, autoReviewNewPulls: true } });
    failure = "listener";
    assert.notEqual((await app.inject({ method: "PATCH", url: "/api/settings", payload: { larkTrustedExecutionEnabled: false, larkMessageListenerEnabled: true, autoReviewNewPulls: true } })).statusCode, 200);
    assert.equal(getAppSettings().larkTrustedExecutionEnabled, true);
    assert.equal(getAppSettings().autoReviewNewPulls, false);
    assert.equal(remote.trustedExecutionEnabled, true);
    for (failure of ["busy", "ignored", "echo only"]) {
      assert.notEqual((await save()).statusCode, 200);
      assert.equal(getAppSettings().larkTrustedExecutionEnabled, true);
      assert.equal(getAppSettings().autoReviewNewPulls, false);
    }
    failure = "";
    delete remote.trustedExecutionEnabled;
    assert.equal((await save()).statusCode, 409);
    const legacy = (await app.inject({ method: "GET", url: "/api/settings" })).json();
    assert.equal(legacy.larkCodexResponder.trustedExecutionConfigurable, false);
    assert.equal(legacy.larkCodexResponder.sandbox, "unknown");
    assert.equal(legacy.appSettings.larkTrustedExecutionEnabled, false);
    assert.equal(getAppSettings().larkTrustedExecutionEnabled, true);
    remote.trustedExecutionEnabled = true;
    assertTestDatabaseIsolation(config.databasePath);
    db.exec("CREATE TEMP TRIGGER reject_trusted_commit BEFORE UPDATE ON app_settings WHEN NEW.key = 'larkTrustedExecutionEnabled' AND NEW.value = 'false' BEGIN SELECT RAISE(FAIL, 'local trusted commit failed'); END");
    try {
      assert.notEqual((await save()).statusCode, 200);
      assert.equal(getAppSettings().larkTrustedExecutionEnabled, true);
      assert.equal(getAppSettings().autoReviewNewPulls, false);
      assert.equal(remote.trustedExecutionEnabled, true);
    } finally { db.exec("DROP TRIGGER reject_trusted_commit"); }
    assert.equal((await save()).statusCode, 200);
    assert.deepEqual(patches.at(-1), { trustedExecutionEnabled: false });
    assert.equal(getAppSettings().larkTrustedExecutionEnabled, false);
    assert.equal(getAppSettings().autoReviewNewPulls, true);
    remote.trustedExecutionEnabled = true;
    const actual = (await app.inject({ method: "GET", url: "/api/settings" })).json();
    assert.equal(actual.appSettings.larkTrustedExecutionEnabled, true);
    assert.equal(actual.larkCodexResponder.trustedExecutionConfigurable, true);
    assert.equal(getAppSettings().larkTrustedExecutionEnabled, false);
  } finally { globalThis.fetch = originalFetch; config.larkAgentUrl = previousUrl; await app.close(); }
});

test("workspace sync rejects remotely before local writes, normalizes paths and compensates failed local persistence", async () => {
  resetTables();
  const originalFetch = globalThis.fetch;
  const previousConfig = { ...config };
  const oldRoot = path.dirname(config.databasePath);
  const newRoot = fs.mkdtempSync(path.join(oldRoot, "workspace-"));
  const local = { ...persistedRuntimeConfig(), workspaceRoot: oldRoot, larkExecutionApproverId: "ou_old", trustedLarkCodexSenderIds: ["ou_old"] };
  updatePersistedRuntimeConfig(local);
  config.larkAgentUrl = "http://lark-agent.test";
  let remote = { workspaceRoot: oldRoot, approverId: "ou_old", trustedSenderIds: ["ou_old"], trustedExecutionEnabled: false };
  const patches: Array<Record<string, unknown>> = [];
  let failure = "busy";
  globalThis.fetch = async (url, init) => {
    if (init?.method === "PATCH") {
      const patch = JSON.parse(String(init.body));
      patches.push(patch);
      if (failure === "busy") return new Response("active turns", { status: 409 });
      if (failure === "ignored") return new Response("{}");
      if (failure === "echo only") return new Response(JSON.stringify(patch));
      remote = { ...remote, ...patch };
      return new Response(JSON.stringify(remote));
    }
    return new Response(JSON.stringify(String(url).endsWith("/v1/settings") ? remote : {}));
  };
  const app = Fastify({ logger: false });
  await app.register(issueRoutes);
  const payload = { ...local, workspaceRoot: ` ${newRoot}/../${path.basename(newRoot)}/ `, larkExecutionApproverId: "ou_new", trustedLarkCodexSenderIds: ["ou_new", "ou_friend", "ou_friend"] };
  const save = () => app.inject({ method: "PUT", url: "/api/settings/runtime-config", payload });
  try {
    for (failure of ["busy", "ignored", "echo only"]) {
      const result = await save();
      assert.notEqual(result.statusCode, 200);
      if (failure === "busy") assert.equal(result.statusCode, 409);
      assert.deepEqual(persistedRuntimeConfig(), local);
      assert.equal(config.workspaceRoot, oldRoot);
      assert.equal((await app.inject({ method: "GET", url: "/api/settings" })).json().workspaceRoot, oldRoot);
    }
    failure = "";
    assertTestDatabaseIsolation(config.databasePath);
    db.exec("CREATE TEMP TRIGGER reject_workspace_commit BEFORE UPDATE ON app_settings WHEN NEW.key = 'larkExecutionApproverId' AND NEW.value = 'ou_new' BEGIN SELECT RAISE(FAIL, 'local workspace commit failed'); END");
    try {
      assert.notEqual((await save()).statusCode, 200);
      assert.deepEqual(persistedRuntimeConfig(), local);
      assert.equal(config.workspaceRoot, oldRoot);
      assert.equal(remote.workspaceRoot, oldRoot);
      assert.equal(remote.approverId, "ou_old");
    } finally { db.exec("DROP TRIGGER reject_workspace_commit"); }
    assert.equal((await save()).statusCode, 200);
    assert.deepEqual(patches.at(-1), { workspaceRoot: newRoot, approverId: "ou_new", trustedSenderIds: ["ou_new", "ou_friend"] });
    const reread = (await app.inject({ method: "GET", url: "/api/settings" })).json();
    assert.equal(reread.runtimeConfig.workspaceRoot, newRoot);
    assert.equal(remote.workspaceRoot, newRoot);
    assert.equal(config.workspaceRoot, newRoot);
  } finally { globalThis.fetch = originalFetch; Object.assign(config, previousConfig); await app.close(); }
});

test("runtime sync requires readable requested permission fields but not unrelated legacy fields", async () => {
  resetTables();
  const originalFetch = globalThis.fetch;
  const previousUrl = config.larkAgentUrl;
  config.larkAgentUrl = "http://lark-agent.test";
  let remote: Record<string, unknown> = {};
  const patches: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (_url, init) => {
    if (init?.method === "PATCH") {
      const patch = JSON.parse(String(init.body));
      patches.push(patch);
      remote = { ...remote, ...patch };
    }
    return new Response(JSON.stringify(remote));
  };
  try {
    for (remote of [
      { workspaceRoot: "/tmp", trustedSenderIds: [] },
      { workspaceRoot: "/tmp", approverId: "ou_old" },
      { workspaceRoot: "/tmp", approverId: null, trustedSenderIds: [] },
      { workspaceRoot: "/tmp", approverId: "ou_old", trustedSenderIds: [1] }
    ]) {
      await assert.rejects(syncLarkRuntimeSettings({ workspaceRoot: "/tmp", approverId: "ou_new", trustedSenderIds: ["ou_new"] }), { statusCode: 409 });
      assert.equal(patches.length, 0);
    }
    remote = { approverId: "ou_old", trustedSenderIds: ["ou_old"] };
    const rollback = await syncLarkRuntimeSettings({ approverId: "ou_new", trustedSenderIds: ["ou_new"] });
    assert.deepEqual(remote, { approverId: "ou_new", trustedSenderIds: ["ou_new"] });
    await rollback();
    assert.deepEqual(remote, { approverId: "ou_old", trustedSenderIds: ["ou_old"] });
  } finally { globalThis.fetch = originalFetch; config.larkAgentUrl = previousUrl; }
});

test("runtime config rejects ignored approver or sender writes even when workspace matches and PATCH echoes success", async () => {
  resetTables();
  const originalFetch = globalThis.fetch;
  const previousConfig = { ...config };
  const workspaceRoot = path.dirname(config.databasePath);
  const local = { ...persistedRuntimeConfig(), workspaceRoot, larkExecutionApproverId: "ou_old", trustedLarkCodexSenderIds: ["ou_old"] };
  updatePersistedRuntimeConfig(local);
  config.larkAgentUrl = "http://lark-agent.test";
  const app = Fastify({ logger: false });
  await app.register(issueRoutes);
  try {
    for (const ignored of ["approverId", "trustedSenderIds"] as const) {
      for (const echoRequested of [false, true]) {
        let remote: Record<string, unknown> = { workspaceRoot, approverId: "ou_old", trustedSenderIds: ["ou_old"] };
        const patches: Array<Record<string, unknown>> = [];
        globalThis.fetch = async (_url, init) => {
          if (init?.method === "PATCH") {
            const patch = JSON.parse(String(init.body));
            patches.push(patch);
            const accepted = { ...patch };
            if (patches.length === 1) delete accepted[ignored];
            remote = { ...remote, ...accepted };
            return new Response(JSON.stringify(echoRequested ? { ...remote, ...patch } : remote));
          }
          return new Response(JSON.stringify(remote));
        };
        const result = await app.inject({ method: "PUT", url: "/api/settings/runtime-config", payload: {
          ...local, larkExecutionApproverId: "ou_new", trustedLarkCodexSenderIds: ["ou_friend"]
        } });
        assert.equal(result.statusCode, 502, `${ignored} echo=${echoRequested}: ${result.body}`);
        assert.doesNotMatch(result.body, /state is unknown/);
        assert.equal(patches.length, 2);
        assert.deepEqual(remote, { workspaceRoot, approverId: "ou_old", trustedSenderIds: ["ou_old"] });
        assert.deepEqual(persistedRuntimeConfig(), local);
        assert.equal(config.larkExecutionApproverId, "ou_old");
        assert.deepEqual((await app.inject({ method: "GET", url: "/api/settings" })).json().runtimeConfig, local);
      }
    }
  } finally { globalThis.fetch = originalFetch; Object.assign(config, previousConfig); await app.close(); }
});

test("runtime config confirms sender lists as deduplicated sets for writes and rollback", async () => {
  resetTables();
  const originalFetch = globalThis.fetch;
  const previousConfig = { ...config };
  const workspaceRoot = path.dirname(config.databasePath);
  const local = { ...persistedRuntimeConfig(), workspaceRoot, larkExecutionApproverId: "ou_old", trustedLarkCodexSenderIds: ["ou_old", "ou_z"] };
  updatePersistedRuntimeConfig(local);
  config.larkAgentUrl = "http://lark-agent.test";
  let remote = { workspaceRoot, approverId: "ou_old", trustedSenderIds: ["ou_z", "ou_old", "ou_z"] };
  globalThis.fetch = async (_url, init) => {
    if (init?.method === "PATCH") {
      const patch = JSON.parse(String(init.body));
      remote = { ...remote, ...patch, trustedSenderIds: [...patch.trustedSenderIds].reverse().concat(patch.trustedSenderIds[0]) };
    }
    return new Response(JSON.stringify(remote));
  };
  const app = Fastify({ logger: false });
  await app.register(issueRoutes);
  try {
    const payload = { ...local, larkExecutionApproverId: "ou_new", trustedLarkCodexSenderIds: ["ou_new", "ou_friend", "ou_friend"] };
    const result = await app.inject({ method: "PUT", url: "/api/settings/runtime-config", payload });
    assert.equal(result.statusCode, 200, result.body);
    const saved = persistedRuntimeConfig();
    assert.deepEqual(saved.trustedLarkCodexSenderIds, ["ou_new", "ou_friend"]);
    assert.deepEqual([...new Set(remote.trustedSenderIds)].sort(), ["ou_friend", "ou_new"]);
    assertTestDatabaseIsolation(config.databasePath);
    db.exec("CREATE TEMP TRIGGER reject_sender_set_commit BEFORE UPDATE ON app_settings WHEN NEW.key = 'larkExecutionApproverId' AND NEW.value = 'ou_fail' BEGIN SELECT RAISE(FAIL, 'local permission commit failed'); END");
    try {
      const failed = await app.inject({ method: "PUT", url: "/api/settings/runtime-config", payload: { ...payload, larkExecutionApproverId: "ou_fail" } });
      assert.equal(failed.statusCode, 500, failed.body);
      assert.doesNotMatch(failed.body, /state is unknown/);
      assert.deepEqual(persistedRuntimeConfig(), saved);
      assert.equal(remote.approverId, "ou_new");
      assert.deepEqual([...new Set(remote.trustedSenderIds)].sort(), ["ou_friend", "ou_new"]);
    } finally { db.exec("DROP TRIGGER reject_sender_set_commit"); }
  } finally { globalThis.fetch = originalFetch; Object.assign(config, previousConfig); await app.close(); }
});

test("runtime config reports unknown when approver or sender rollback is ignored and preserves local source", async () => {
  resetTables();
  const originalFetch = globalThis.fetch;
  const previousConfig = { ...config };
  const workspaceRoot = path.dirname(config.databasePath);
  const local = { ...persistedRuntimeConfig(), workspaceRoot, larkExecutionApproverId: "ou_old", trustedLarkCodexSenderIds: ["ou_old"] };
  updatePersistedRuntimeConfig(local);
  config.larkAgentUrl = "http://lark-agent.test";
  const app = Fastify({ logger: false });
  await app.register(issueRoutes);
  assertTestDatabaseIsolation(config.databasePath);
  db.exec("CREATE TEMP TRIGGER reject_permission_commit BEFORE UPDATE ON app_settings WHEN NEW.key = 'larkExecutionApproverId' AND NEW.value = 'ou_new' BEGIN SELECT RAISE(FAIL, 'local permission commit failed'); END");
  try {
    for (const ignored of ["approverId", "trustedSenderIds"] as const) {
      for (const echoRequested of [false, true]) {
        let remote: Record<string, unknown> = { workspaceRoot, approverId: "ou_old", trustedSenderIds: ["ou_old"] };
        let writes = 0;
        globalThis.fetch = async (_url, init) => {
          if (init?.method === "PATCH") {
            const patch = JSON.parse(String(init.body));
            writes += 1;
            const accepted = { ...patch };
            if (writes === 2) delete accepted[ignored];
            remote = { ...remote, ...accepted };
            return new Response(JSON.stringify(echoRequested ? { ...remote, ...patch } : remote));
          }
          return new Response(JSON.stringify(remote));
        };
        const result = await app.inject({ method: "PUT", url: "/api/settings/runtime-config", payload: {
          ...local, larkExecutionApproverId: "ou_new", trustedLarkCodexSenderIds: ["ou_friend"]
        } });
        assert.equal(result.statusCode, 502, `${ignored} echo=${echoRequested}: ${result.body}`);
        assert.match(result.body, /state is unknown because rollback could not be confirmed/);
        assert.equal(writes, 2);
        assert.deepEqual(persistedRuntimeConfig(), local);
        assert.equal(config.larkExecutionApproverId, "ou_old");
        assert.deepEqual(config.trustedLarkCodexSenderIds, ["ou_old"]);
        assert.notDeepEqual(remote[ignored], ignored === "approverId" ? "ou_old" : ["ou_old"]);
      }
    }
  } finally {
    db.exec("DROP TRIGGER reject_permission_commit");
    globalThis.fetch = originalFetch;
    Object.assign(config, previousConfig);
    await app.close();
  }
});

test("backup restore synchronizes workspace and trusted false before local restore and compensates local failures", async () => {
  resetTables();
  const originalFetch = globalThis.fetch;
  const previousConfig = { ...config };
  const workspaceRoot = path.dirname(config.databasePath);
  const nextWorkspace = fs.mkdtempSync(path.join(workspaceRoot, "restore-workspace-"));
  updatePersistedRuntimeConfig({ ...persistedRuntimeConfig(), workspaceRoot });
  updateAppSettings({ larkTrustedExecutionEnabled: true });
  config.larkAgentUrl = "http://lark-agent.test";
  let remote: Record<string, unknown> = { workspaceRoot, trustedExecutionEnabled: true, turnAutoApprovalEnabled: false, turnAutoApprovalModel: "gpt-6.1-sol", turnAutoApprovalModelConfigurable: true, approverId: "", trustedSenderIds: [] };
  let rejectRuntime = true;
  const patches: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (_url, init) => {
    if (init?.method === "PATCH") {
      const patch = JSON.parse(String(init.body));
      patches.push(patch);
      if (rejectRuntime && Object.hasOwn(patch, "workspaceRoot")) return new Response("active turns", { status: 409 });
      remote = { ...remote, ...patch };
    }
    return new Response(JSON.stringify(remote));
  };
  const app = Fastify({ logger: false });
  await app.register(issueRoutes);
  try {
    const backup = (await app.inject({ method: "GET", url: "/api/settings/backup" })).json();
    backup.runtimeConfig.workspaceRoot = nextWorkspace;
    backup.appSettings.larkTrustedExecutionEnabled = false;
    backup.appSettings.autoReviewNewPulls = true;
    const restore = () => app.inject({ method: "POST", url: "/api/settings/backup/restore", payload: backup });
    assert.equal((await restore()).statusCode, 400);
    assert.equal(persistedRuntimeConfig().workspaceRoot, workspaceRoot);
    assert.equal(getAppSettings().larkTrustedExecutionEnabled, true);
    assert.equal(getAppSettings().autoReviewNewPulls, false);
    rejectRuntime = false;
    const todo = { id: 1, title: "duplicate", description: null, status: "todo", codexSessionId: null, createdAt: "2026-10-22", updatedAt: "2026-10-22" };
    backup.todos = [todo, todo];
    assert.equal((await restore()).statusCode, 400);
    assert.equal(persistedRuntimeConfig().workspaceRoot, workspaceRoot);
    assert.equal(config.workspaceRoot, workspaceRoot);
    assert.equal(remote.workspaceRoot, workspaceRoot);
    assert.equal(remote.trustedExecutionEnabled, true);
    assert.equal(getAppSettings().larkTrustedExecutionEnabled, true);
    backup.todos = [];
    assert.equal((await restore()).statusCode, 200);
    assert.equal(getAppSettings().larkTrustedExecutionEnabled, false);
    assert.equal(getAppSettings().autoReviewNewPulls, true);
    assert.equal(persistedRuntimeConfig().workspaceRoot, nextWorkspace);
    assert.equal(remote.workspaceRoot, nextWorkspace);
    assert.equal(remote.trustedExecutionEnabled, false);
    assert.ok(patches.some((patch) => patch.workspaceRoot === nextWorkspace && patch.trustedExecutionEnabled === false));
  } finally { globalThis.fetch = originalFetch; Object.assign(config, previousConfig); await app.close(); }
});

test("startup handshake sends only persisted Forge workspace and trusted false, checks readback and tolerates legacy capabilities", async () => {
  resetTables();
  const originalFetch = globalThis.fetch;
  const previousConfig = { ...config };
  const workspaceRoot = path.dirname(config.databasePath);
  updatePersistedRuntimeConfig({ ...persistedRuntimeConfig(), workspaceRoot });
  updateAppSettings({ larkTrustedExecutionEnabled: false });
  config.larkAgentUrl = "http://lark-agent.test";
  let remote: Record<string, unknown> = { workspaceRoot: "/tmp/agent-old", trustedExecutionEnabled: true };
  const patches: Array<Record<string, unknown>> = [];
  let failure = "";
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/capabilities/register")) return new Response('{"registered":5}');
    if (init?.method === "PATCH") {
      const patch = JSON.parse(String(init.body));
      patches.push(patch);
      if (failure === "busy") return new Response("busy", { status: 409 });
      if (failure === "echo only") return new Response(JSON.stringify(patch));
      remote = { ...remote, ...patch };
    }
    return new Response(JSON.stringify(remote));
  };
  try {
    assert.equal(await registerForgeLarkAgentCapabilities(), 5);
    assert.deepEqual(patches.at(-1), { workspaceRoot, trustedExecutionEnabled: false });
    assert.equal(remote.trustedExecutionEnabled, false);
    updateAppSettings({ larkTrustedExecutionEnabled: true });
    assert.equal(await registerForgeLarkAgentCapabilities(), 5);
    assert.deepEqual(patches.at(-1), { workspaceRoot, trustedExecutionEnabled: true });
    updateAppSettings({ larkTrustedExecutionEnabled: false });
    remote = { workspaceRoot: "/tmp/agent-old", trustedExecutionEnabled: true };
    for (failure of ["busy", "echo only"]) {
      await assert.rejects(registerForgeLarkAgentCapabilities());
      assert.equal(persistedRuntimeConfig().workspaceRoot, workspaceRoot);
      assert.equal(getAppSettings().larkTrustedExecutionEnabled, false);
    }
    failure = "";
    remote = {};
    const count = patches.length;
    assert.equal(await registerForgeLarkAgentCapabilities(), 5);
    assert.equal(patches.length, count);
  } finally { globalThis.fetch = originalFetch; Object.assign(config, previousConfig); }
});

test("turn auto-approval settings require remote support and a confirmed boolean before saving", async () => {
  resetTables();
  const originalFetch = globalThis.fetch;
  const previousUrl = config.larkAgentUrl;
  config.larkAgentUrl = "";
  let remoteValue: unknown = false;
  let echo: unknown;
  let overrideEcho = false;
  let unavailable = false;
  let rejectPatch = false;
  const patches: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (url, init) => {
    if (unavailable) throw new Error("runtime unavailable");
    if (init?.method === "PATCH") {
      const patch = JSON.parse(String(init.body));
      patches.push(patch);
      if (rejectPatch) return new Response("runtime rejected update", { status: 503 });
      if (overrideEcho) return new Response(JSON.stringify(echo), { status: 200 });
      remoteValue = patch.turnAutoApprovalEnabled;
      return new Response(JSON.stringify(patch), { status: 200 });
    }
    return new Response(JSON.stringify(String(url).endsWith("/v1/settings") ? { turnAutoApprovalEnabled: remoteValue } : {}), { status: 200 });
  };
  const app = Fastify({ logger: false });
  await app.register(issueRoutes);
  const settings = async () => (await app.inject({ method: "GET", url: "/api/settings" })).json();
  const save = (value: unknown) => app.inject({ method: "PATCH", url: "/api/settings", payload: { larkTurnAutoApprovalEnabled: value } });
  try {
    assert.equal(getAppSettings().larkTurnAutoApprovalEnabled, false);
    const unconfigured = await settings();
    assert.equal(unconfigured.appSettings.larkTurnAutoApprovalEnabled, false);
    assert.equal(unconfigured.larkCodexResponder.turnAutoApprovalConfigurable, false);
    assert.equal(unconfigured.larkCodexResponder.turnAutoApprovalModel, "gpt-6.1-sol");
    for (const value of [true, false]) assert.equal((await save(value)).statusCode, 409);
    assert.equal(patches.length, 0);

    config.larkAgentUrl = "http://127.0.0.1:19999";
    assert.equal((await settings()).larkCodexResponder.turnAutoApprovalConfigurable, true);
    for (const value of [true, false, true]) {
      const response = await save(value);
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().larkTurnAutoApprovalEnabled, value);
      assert.equal(getAppSettings().larkTurnAutoApprovalEnabled, value);
      assert.deepEqual(patches.at(-1), { turnAutoApprovalEnabled: value });
    }
    remoteValue = false;
    assert.equal((await settings()).appSettings.larkTurnAutoApprovalEnabled, false);
    assert.equal(getAppSettings().larkTurnAutoApprovalEnabled, true);
    remoteValue = true;
    assert.equal((await settings()).appSettings.larkTurnAutoApprovalEnabled, true);
    for (const invalid of ["false", null, 0]) assert.equal((await save(invalid)).statusCode, 400);
    const patchCount = patches.length;
    for (const unsupported of [undefined, null, "true"]) {
      remoteValue = unsupported;
      const result = await settings();
      assert.equal(result.larkCodexResponder.turnAutoApprovalConfigurable, false);
      assert.equal(result.appSettings.larkTurnAutoApprovalEnabled, false);
      const rejected = await app.inject({ method: "PATCH", url: "/api/settings", payload: { larkTurnAutoApprovalEnabled: false, autoReviewNewPulls: true } });
      assert.equal(rejected.statusCode, 409);
      assert.equal(getAppSettings().autoReviewNewPulls, false);
    }
    assert.equal(patches.length, patchCount);
    remoteValue = true;
    overrideEcho = true;
    for (const response of [{}, null, { turnAutoApprovalEnabled: true }, { turnAutoApprovalEnabled: "false" }]) {
      echo = response;
      assert.equal((await save(false)).statusCode, 502);
      assert.equal(getAppSettings().larkTurnAutoApprovalEnabled, true);
    }
    overrideEcho = false;
    rejectPatch = true;
    assert.equal((await save(false)).statusCode, 502);
    assert.equal(getAppSettings().larkTurnAutoApprovalEnabled, true);
    unavailable = true;
    assert.equal((await save(false)).statusCode, 502);
    const offline = await settings();
    assert.equal(offline.appSettings.larkTurnAutoApprovalEnabled, false);
    assert.equal(offline.larkCodexResponder.turnAutoApprovalConfigurable, false);
    assert.equal(getAppSettings().larkTurnAutoApprovalEnabled, true);
  } finally {
    globalThis.fetch = originalFetch;
    config.larkAgentUrl = previousUrl;
    await app.close();
  }
});

test("turn auto-approval model saves independently, reads the runtime value and rejects invalid or unsupported updates", async () => {
  resetTables();
  const originalFetch = globalThis.fetch;
  const previousUrl = config.larkAgentUrl;
  config.larkAgentUrl = "http://127.0.0.1:19999";
  let remote = { turnAutoApprovalEnabled: false, turnAutoApprovalModel: "gpt-6.1-sol", turnAutoApprovalModelConfigurable: true as unknown };
  const patches: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (url, init) => {
    if (init?.method === "PATCH") {
      const patch = JSON.parse(String(init.body));
      patches.push(patch);
      remote = { ...remote, ...patch };
    }
    return new Response(JSON.stringify(String(url).endsWith("/v1/settings") ? remote : {}), { status: 200 });
  };
  const app = Fastify({ logger: false });
  await app.register(issueRoutes);
  const save = (model: unknown) => app.inject({ method: "PATCH", url: "/api/settings", payload: { larkTurnAutoApprovalModel: model } });
  const settings = async () => (await app.inject({ method: "GET", url: "/api/settings" })).json();
  try {
    assert.equal(getAppSettings().larkTurnAutoApprovalModel, "gpt-6.1-sol");
    const saved = await save(" provider/custom-model:v2 ");
    assert.equal(saved.statusCode, 200);
    assert.equal(saved.json().larkTurnAutoApprovalModel, "provider/custom-model:v2");
    assert.equal(getAppSettings().larkTurnAutoApprovalModel, "provider/custom-model:v2");
    assert.equal(getAppSettings().larkTurnAutoApprovalEnabled, false);
    assert.deepEqual(patches, [{ turnAutoApprovalModel: "provider/custom-model:v2" }]);
    remote.turnAutoApprovalModel = "gpt-6-sol";
    const actual = await settings();
    assert.equal(actual.appSettings.larkTurnAutoApprovalModel, "gpt-6-sol");
    assert.equal(actual.larkCodexResponder.turnAutoApprovalModel, "gpt-6-sol");
    assert.equal(actual.larkCodexResponder.turnAutoApprovalModelConfigurable, true);
    assert.equal(getAppSettings().larkTurnAutoApprovalModel, "provider/custom-model:v2");
    for (const invalid of ["", " ", "has spaces", "--model", "x;cmd", "x".repeat(121), null, 1]) assert.equal((await save(invalid)).statusCode, 400);
    const invalidBackup = (await app.inject({ method: "GET", url: "/api/settings/backup" })).json();
    invalidBackup.appSettings.larkTurnAutoApprovalModel = "bad model";
    assert.equal((await app.inject({ method: "POST", url: "/api/settings/backup/restore", payload: invalidBackup })).statusCode, 400);
    assert.equal(patches.length, 1);
    for (const flag of [false, undefined, "true"]) {
      remote.turnAutoApprovalModelConfigurable = flag;
      assert.equal((await settings()).larkCodexResponder.turnAutoApprovalModelConfigurable, false);
      const rejected = await app.inject({ method: "PATCH", url: "/api/settings", payload: { larkTurnAutoApprovalModel: "gpt-6-sol", larkCodexModel: "gpt-6-sol", autoReviewNewPulls: true } });
      assert.equal(rejected.statusCode, 409);
      assert.equal(getAppSettings().autoReviewNewPulls, false);
    }
    assert.equal(patches.length, 1);
    assert.equal((await app.inject({ method: "PATCH", url: "/api/settings", payload: { larkTurnAutoApprovalEnabled: true } })).statusCode, 200);
    assert.deepEqual(patches.at(-1), { turnAutoApprovalEnabled: true });
    config.larkAgentUrl = "";
    assert.equal((await save("gpt-6-sol")).statusCode, 409);
    config.larkAgentUrl = "http://127.0.0.1:19999";
    globalThis.fetch = async () => { throw new Error("offline"); };
    assert.equal((await save("gpt-6-sol")).statusCode, 502);
  } finally {
    globalThis.fetch = originalFetch;
    config.larkAgentUrl = previousUrl;
    await app.close();
  }
});

test("turn auto-approval backups persist the switch and restore old backups disabled", async () => {
  resetTables();
  const originalFetch = globalThis.fetch;
  const previousUrl = config.larkAgentUrl;
  const previousWorkspace = config.workspaceRoot;
  config.workspaceRoot = "/tmp/forge-turn-auto-approval-test";
  config.larkAgentUrl = "http://127.0.0.1:19999";
  let supported = true;
  let remoteValue = false;
  let confirm = true;
  const patches: Array<Record<string, unknown>> = [];
  globalThis.fetch = withRuntimeSettings(async (url, init) => {
    if (init?.method === "PATCH") {
      const patch = JSON.parse(String(init.body));
      patches.push(patch);
      if (typeof patch.turnAutoApprovalEnabled === "boolean") {
        if (!confirm) return new Response("{}", { status: 200 });
        remoteValue = patch.turnAutoApprovalEnabled;
      }
      return new Response(JSON.stringify(patch), { status: 200 });
    }
    return new Response(JSON.stringify(String(url).endsWith("/v1/settings") && supported ? { turnAutoApprovalEnabled: remoteValue } : {}), { status: 200 });
  });
  const app = Fastify({ logger: false });
  await app.register(issueRoutes);
  try {
    assert.equal((await app.inject({ method: "GET", url: "/api/settings/backup" })).json().appSettings.larkTurnAutoApprovalEnabled, false);
    assert.equal((await app.inject({ method: "PATCH", url: "/api/settings", payload: { larkTurnAutoApprovalEnabled: true } })).statusCode, 200);
    const backup = (await app.inject({ method: "GET", url: "/api/settings/backup" })).json();
    assert.equal(backup.appSettings.larkTurnAutoApprovalEnabled, true);
    assert.equal(backup.appSettings.larkTurnAutoApprovalModel, "gpt-6.1-sol");
    assert.equal(Object.hasOwn(backup.appSettings, "turnAutoApprovalModel"), false);
    await app.inject({ method: "PATCH", url: "/api/settings", payload: { larkTurnAutoApprovalEnabled: false } });
    const restore = () => app.inject({ method: "POST", url: "/api/settings/backup/restore", payload: backup });
    confirm = false;
    assert.equal((await restore()).statusCode, 400);
    assert.equal(getAppSettings().larkTurnAutoApprovalEnabled, false);
    confirm = true;
    assert.equal((await restore()).statusCode, 200);
    assert.equal(getAppSettings().larkTurnAutoApprovalEnabled, true);
    assert.equal(remoteValue, true);
    supported = false;
    updateAppSettings({ larkTurnAutoApprovalEnabled: false });
    const patchCount = patches.length;
    assert.equal((await restore()).statusCode, 400);
    assert.equal(getAppSettings().larkTurnAutoApprovalEnabled, false);
    assert.equal(patches.length, patchCount);
    config.larkAgentUrl = "";
    assert.equal((await restore()).statusCode, 400);
    assert.equal(getAppSettings().larkTurnAutoApprovalEnabled, false);

    delete backup.appSettings.larkTurnAutoApprovalEnabled;
    delete backup.appSettings.larkTurnAutoApprovalModel;
    updateAppSettings({ larkTurnAutoApprovalEnabled: true, larkTurnAutoApprovalModel: "gpt-6-sol" });
    assert.equal((await restore()).statusCode, 200);
    assert.equal(getAppSettings().larkTurnAutoApprovalEnabled, false);
    assert.equal(getAppSettings().larkTurnAutoApprovalModel, "gpt-6.1-sol");
    config.larkAgentUrl = "http://127.0.0.1:19999";
    assert.equal((await restore()).statusCode, 200);
    assert.equal(Object.hasOwn(patches.at(-1)!, "turnAutoApprovalEnabled"), false);
    supported = true;
    assert.equal((await restore()).statusCode, 200);
    assert.equal(remoteValue, false);
    assert.equal(patches.at(-1)?.turnAutoApprovalEnabled, false);
    assert.equal(patches.at(-1)?.workspaceRoot, backup.runtimeConfig.workspaceRoot);
    assert.equal(patches.at(-1)?.trustedExecutionEnabled, backup.appSettings.larkTrustedExecutionEnabled);
    assert.equal((await app.inject({ method: "GET", url: "/api/settings/backup" })).json().appSettings.larkTurnAutoApprovalEnabled, false);
  } finally {
    globalThis.fetch = originalFetch;
    config.larkAgentUrl = previousUrl;
    config.workspaceRoot = previousWorkspace;
    await app.close();
  }
});

test("mixed settings and backup work commit or compensate turn auto-approval in the same confirmed batch", async () => {
  const originalFetch = globalThis.fetch;
  const previousUrl = config.larkAgentUrl;
  const previousWorkspace = config.workspaceRoot;
  config.larkAgentUrl = "http://127.0.0.1:19999";
  config.workspaceRoot = "/tmp/forge-turn-auto-approval-order-test";
  const app = Fastify({ logger: false });
  await app.register(issueRoutes);
  try {
    for (const previous of [false, true]) {
      for (const scenario of [
        { method: "PATCH", failure: "model", status: 502 },
        { method: "PATCH", failure: "reasoning", status: 502 },
        { method: "PATCH", failure: "listener", status: 502 },
        { method: "POST", failure: "model", status: 400 },
        { method: "POST", failure: "reasoning", status: 400 },
        { method: "POST", failure: "restore", status: 400 },
        { method: "PATCH", failure: "none", status: 200 },
        { method: "POST", failure: "none", status: 200 }
      ] as const) {
        resetTables();
        updateAppSettings({ larkTurnAutoApprovalEnabled: previous, larkTurnAutoApprovalModel: "gpt-6.1-sol" });
        let remoteValue = previous;
        let remoteModel = "gpt-6.1-sol";
        const calls: Array<Record<string, unknown>> = [];
        globalThis.fetch = withRuntimeSettings(async (_url, init) => {
          assert.equal(getAppSettings().larkTurnAutoApprovalEnabled, previous);
          assert.equal(getAppSettings().larkTurnAutoApprovalModel, "gpt-6.1-sol");
          if (init?.method !== "PATCH") {
            return new Response(JSON.stringify({ turnAutoApprovalEnabled: remoteValue, turnAutoApprovalModel: remoteModel, turnAutoApprovalModelConfigurable: true }), { status: 200 });
          }
          const patch = JSON.parse(String(init.body));
          calls.push(patch);
          if ((scenario.failure === "model" && patch.codexModel !== undefined) || (scenario.failure === "listener" && patch.listenerEnabled !== undefined)) {
            return new Response("runtime rejected setting", { status: 503 });
          }
          if (scenario.failure === "reasoning" && patch.reasoningEffort !== undefined) return new Response("{}", { status: 200 });
          if (typeof patch.turnAutoApprovalEnabled === "boolean") remoteValue = patch.turnAutoApprovalEnabled;
          if (typeof patch.turnAutoApprovalModel === "string") remoteModel = patch.turnAutoApprovalModel;
          return new Response(JSON.stringify(patch), { status: 200 });
        });
        const backup = (await app.inject({ method: "GET", url: "/api/settings/backup" })).json();
        backup.appSettings.larkTurnAutoApprovalEnabled = !previous;
        backup.appSettings.larkTurnAutoApprovalModel = "gpt-6-sol";
        if (scenario.failure === "restore") {
          const todo = { id: 1, title: "duplicate", description: null, status: "todo", codexSessionId: null, createdAt: "2026-10-13", updatedAt: "2026-10-13" };
          backup.todos = [todo, todo];
        }
        const result = await app.inject({
          method: scenario.method,
          url: scenario.method === "PATCH" ? "/api/settings" : "/api/settings/backup/restore",
          payload: scenario.method === "PATCH" ? {
            larkTurnAutoApprovalEnabled: !previous,
            larkTurnAutoApprovalModel: "gpt-6-sol",
            larkCodexModel: "gpt-6.1-sol",
            larkCodexReasoningEffort: "high",
            larkMessageListenerEnabled: true
          } : backup
        });
        assert.equal(result.statusCode, scenario.status, `${scenario.method} ${scenario.failure}: ${result.body}`);
        if (scenario.failure === "restore") assert.match(result.json().error, /UNIQUE constraint failed: codex_todos.id/);
        const expected = scenario.status === 200 ? !previous : previous;
        assert.equal(remoteValue, expected);
        assert.equal(getAppSettings().larkTurnAutoApprovalEnabled, expected);
        assert.equal(remoteModel, scenario.status === 200 ? "gpt-6-sol" : "gpt-6.1-sol");
        assert.equal(getAppSettings().larkTurnAutoApprovalModel, remoteModel);
        const toggleCalls = calls.filter((call) => Object.hasOwn(call, "turnAutoApprovalEnabled"));
        assert.equal(toggleCalls.length, scenario.status === 200 ? 1 : 2);
        if (scenario.status !== 200) {
          assert.equal((db.prepare("SELECT count(*) AS count FROM local_audit_events WHERE action IN ('settings.updated', 'backup.restored')").get() as { count: number }).count, 0);
        }
        if (scenario.status === 200) {
          assert.equal(calls.length, 1);
          assert.equal(calls[0].turnAutoApprovalEnabled, !previous);
          assert.equal(calls[0].turnAutoApprovalModel, "gpt-6-sol");
          assert.ok(Object.hasOwn(calls[0], "codexModel"));
        } else {
          assert.deepEqual(Object.keys(calls[0]).sort(), Object.keys(calls[1]).sort());
        }
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
    config.larkAgentUrl = previousUrl;
    config.workspaceRoot = previousWorkspace;
    await app.close();
  }
});

test("turn auto-approval model and switch compensate together on echo or local commit failures", async () => {
  const originalFetch = globalThis.fetch;
  const previousUrl = config.larkAgentUrl;
  const previousWorkspace = config.workspaceRoot;
  config.larkAgentUrl = "http://127.0.0.1:19999";
  config.workspaceRoot = "/tmp/forge-approval-model-rollback-test";
  const app = Fastify({ logger: false });
  await app.register(issueRoutes);
  try {
    for (const method of ["PATCH", "POST"] as const) {
      for (const modelOnly of [false, true]) {
        for (const failure of ["missing model", "wrong model", "missing switch", "ambiguous write", "local model", "local switch", "local other", "local audit", "rollback unavailable", "none"] as const) {
          if ((failure === "missing switch" || failure === "local switch") && modelOnly) continue;
          if (failure === "local other" && method === "POST") continue;
          resetTables();
          updateAppSettings({ larkTurnAutoApprovalEnabled: true, larkTurnAutoApprovalModel: "gpt-6.1-sol" });
          let remote = { turnAutoApprovalEnabled: true, turnAutoApprovalModel: "gpt-6.1-sol", turnAutoApprovalModelConfigurable: true };
          let expectedLocalModel = "gpt-6.1-sol";
          let expectedLocalEnabled = true;
          const writes: Array<Record<string, unknown>> = [];
          globalThis.fetch = withRuntimeSettings(async (_url, init) => {
            if (init?.method !== "PATCH") return new Response(JSON.stringify(remote), { status: 200 });
            const patch = JSON.parse(String(init.body));
            if (!Object.hasOwn(patch, "turnAutoApprovalModel")) return new Response(JSON.stringify(patch), { status: 200 });
            assert.equal(getAppSettings().larkTurnAutoApprovalModel, expectedLocalModel);
            assert.equal(getAppSettings().larkTurnAutoApprovalEnabled, expectedLocalEnabled);
            writes.push(patch);
            if (writes.length === 2 && failure === "rollback unavailable") throw new Error("rollback offline");
            remote = { ...remote, ...patch };
            if (writes.length === 1) {
              if (failure === "ambiguous write") throw new Error("connection lost after write");
              if (failure === "missing model" || failure === "rollback unavailable") return new Response(JSON.stringify({ turnAutoApprovalEnabled: remote.turnAutoApprovalEnabled }), { status: 200 });
              if (failure === "missing switch") return new Response(JSON.stringify({ turnAutoApprovalModel: remote.turnAutoApprovalModel }), { status: 200 });
              if (failure === "wrong model") return new Response(JSON.stringify({ ...remote, turnAutoApprovalModel: "gpt-6.1-sol" }), { status: 200 });
            }
            return new Response(JSON.stringify(remote), { status: 200 });
          });
          const backup = (await app.inject({ method: "GET", url: "/api/settings/backup" })).json();
          backup.appSettings.larkTurnAutoApprovalModel = "gpt-6-sol";
          backup.appSettings.larkTurnAutoApprovalEnabled = modelOnly;
          if (failure.startsWith("local")) {
            assertTestDatabaseIsolation(config.databasePath);
            const trigger = failure === "local audit"
              ? "AFTER INSERT ON local_audit_events WHEN NEW.action IN ('settings.updated', 'backup.restored')"
              : failure === "local other"
              ? "AFTER INSERT ON app_settings WHEN NEW.key = 'autoReviewNewPulls' AND NEW.value = 'true'"
              : `AFTER UPDATE ON app_settings WHEN NEW.key = '${failure === "local model" ? "larkTurnAutoApprovalModel" : "larkTurnAutoApprovalEnabled"}' AND NEW.value = '${failure === "local model" ? "gpt-6-sol" : "false"}'`;
            db.exec(`CREATE TEMP TRIGGER reject_approval_model_commit ${trigger} BEGIN SELECT RAISE(FAIL, 'local approval commit failed'); END`);
          }
          try {
            const result = await app.inject({
              method,
              url: method === "PATCH" ? "/api/settings" : "/api/settings/backup/restore",
              payload: method === "PATCH" ? { larkTurnAutoApprovalModel: "gpt-6-sol", ...(modelOnly ? {} : { larkTurnAutoApprovalEnabled: false }), autoReviewNewPulls: true } : backup
            });
            const success = failure === "none";
            assert.equal(result.statusCode, success ? 200 : method === "PATCH" ? 502 : 400, `${method} ${modelOnly} ${failure}: ${result.body}`);
            const requested = { turnAutoApprovalModel: "gpt-6-sol", ...(method === "POST" || !modelOnly ? { turnAutoApprovalEnabled: modelOnly } : {}), ...(method === "POST" ? { turnAutoApprovalDataSources: [] } : {}) };
            const previous = { turnAutoApprovalModel: "gpt-6.1-sol", ...(method === "POST" || !modelOnly ? { turnAutoApprovalEnabled: true } : {}), ...(method === "POST" ? { turnAutoApprovalDataSources: [] } : {}) };
            const approvals = writes.map((write) => Object.fromEntries(Object.entries(write).filter(([key]) => key.startsWith("turnAutoApproval"))));
            assert.deepEqual(approvals, success ? [requested] : [requested, previous]);
            if (method === "POST") {
              assert.ok(writes.every((write) => Object.hasOwn(write, "workspaceRoot") && Object.hasOwn(write, "codexModel")));
              if (!success) assert.deepEqual(Object.keys(writes[0]).sort(), Object.keys(writes[1]).sort());
            } else assert.deepEqual(writes, approvals);
            assert.equal(getAppSettings().larkTurnAutoApprovalModel, success ? "gpt-6-sol" : "gpt-6.1-sol");
            assert.equal(getAppSettings().larkTurnAutoApprovalEnabled, success ? modelOnly : true);
            assert.equal(remote.turnAutoApprovalModel, success || failure === "rollback unavailable" ? "gpt-6-sol" : "gpt-6.1-sol");
            assert.equal(remote.turnAutoApprovalEnabled, success || failure === "rollback unavailable" ? modelOnly : true);
            if (method === "PATCH") assert.equal(getAppSettings().autoReviewNewPulls, success);
            const auditCount = (db.prepare("SELECT count(*) AS count FROM local_audit_events WHERE action IN ('settings.updated', 'backup.restored')").get() as { count: number }).count;
            assert.equal(auditCount, success ? 1 : 0);
            if (!success) assert.match(result.json().message ?? result.json().error, failure === "rollback unavailable" ? /state is unknown.*rollback could not be confirmed/ : /previous remote turn auto-approval setting restored/);
            if (success && method === "POST") {
              expectedLocalModel = "gpt-6-sol";
              expectedLocalEnabled = modelOnly;
              delete backup.appSettings.larkTurnAutoApprovalModel;
              const oldRestore = await app.inject({ method: "POST", url: "/api/settings/backup/restore", payload: backup });
              assert.equal(oldRestore.statusCode, 200, oldRestore.body);
              assert.equal(getAppSettings().larkTurnAutoApprovalModel, "gpt-6.1-sol");
              assert.equal(remote.turnAutoApprovalModel, "gpt-6.1-sol");
            }
          } finally {
            if (failure.startsWith("local")) db.exec("DROP TRIGGER reject_approval_model_commit");
          }
        }
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
    config.larkAgentUrl = previousUrl;
    config.workspaceRoot = previousWorkspace;
    await app.close();
  }
});

test("turn auto-approval compensates ambiguous writes and local commit failures without claiming an unknown state is off", async () => {
  const originalFetch = globalThis.fetch;
  const previousUrl = config.larkAgentUrl;
  const previousWorkspace = config.workspaceRoot;
  config.larkAgentUrl = "http://127.0.0.1:19999";
  config.workspaceRoot = "/tmp/forge-turn-auto-approval-rollback-test";
  const app = Fastify({ logger: false });
  await app.register(issueRoutes);
  try {
    for (const method of ["PATCH", "POST"] as const) {
      for (const previous of [false, true]) {
        for (const failure of ["bad echo", "ambiguous write", "local commit", "rollback bad echo", "rollback unavailable"]) {
          resetTables();
          updateAppSettings({ larkTurnAutoApprovalEnabled: previous });
          let remoteValue = previous;
          const writes: boolean[] = [];
          globalThis.fetch = withRuntimeSettings(async (_url, init) => {
            if (init?.method !== "PATCH") return new Response(JSON.stringify({ turnAutoApprovalEnabled: remoteValue }), { status: 200 });
            const patch = JSON.parse(String(init.body));
            if (typeof patch.turnAutoApprovalEnabled !== "boolean") return new Response(JSON.stringify(patch), { status: 200 });
            assert.equal(getAppSettings().larkTurnAutoApprovalEnabled, previous);
            writes.push(patch.turnAutoApprovalEnabled);
            if (writes.length === 2 && failure === "rollback unavailable") throw new Error("rollback unavailable");
            remoteValue = patch.turnAutoApprovalEnabled;
            if (writes.length === 1 && failure === "ambiguous write") throw new Error("connection lost after write");
            if ((writes.length === 1 && failure !== "local commit") || (writes.length === 2 && failure === "rollback bad echo")) {
              return new Response("{}", { status: 200 });
            }
            return new Response(JSON.stringify(patch), { status: 200 });
          });
          const backup = (await app.inject({ method: "GET", url: "/api/settings/backup" })).json();
          backup.appSettings.larkTurnAutoApprovalEnabled = !previous;
          if (failure === "local commit") {
            assertTestDatabaseIsolation(config.databasePath);
            db.exec(`CREATE TEMP TRIGGER reject_turn_auto_approval_commit AFTER UPDATE ON app_settings
              WHEN NEW.key = 'larkTurnAutoApprovalEnabled' AND NEW.value = '${!previous}'
              BEGIN SELECT RAISE(FAIL, 'local toggle commit failed'); END`);
          }
          try {
            const result = await app.inject({
              method,
              url: method === "PATCH" ? "/api/settings" : "/api/settings/backup/restore",
              payload: method === "PATCH" ? { larkTurnAutoApprovalEnabled: !previous } : backup
            });
            assert.equal(result.statusCode, method === "PATCH" ? 502 : 400, `${method} ${failure}: ${result.body}`);
            assert.deepEqual(writes, [!previous, previous]);
            assert.equal(getAppSettings().larkTurnAutoApprovalEnabled, previous);
            assert.equal(remoteValue, failure === "rollback unavailable" ? !previous : previous);
            const message = result.json().message ?? result.json().error;
            if (failure === "local commit") assert.match(message, /local toggle commit failed/);
            assert.equal((db.prepare("SELECT count(*) AS count FROM local_audit_events WHERE action IN ('settings.updated', 'backup.restored')").get() as { count: number }).count, 0);
            if (failure.startsWith("rollback")) {
              assert.match(message, /state is unknown.*rollback could not be confirmed/);
              assert.doesNotMatch(message, /setting restored/);
            } else {
              assert.match(message, /previous remote turn auto-approval setting restored/);
              assert.doesNotMatch(message, /state is unknown/);
            }
          } finally {
            if (failure === "local commit") db.exec("DROP TRIGGER reject_turn_auto_approval_commit");
          }
        }
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
    config.larkAgentUrl = previousUrl;
    config.workspaceRoot = previousWorkspace;
    await app.close();
  }
});

test("group allowlist settings sync before persisting and survive backup restoration", async () => {
  resetTables();
  const originalFetch = globalThis.fetch;
  const previousUrl = config.larkAgentUrl;
  const previousWorkspace = config.workspaceRoot;
  config.workspaceRoot = "/tmp/forge-allowlist-test";
  config.larkAgentUrl = "http://127.0.0.1:19999";
  const calls: Array<Record<string, unknown>> = [];
  let fail = false;
  let ignoreEffort = false;
  let reportEffort = false;
  let remote = completeLarkRuntimeSettings();
  globalThis.fetch = async (_url, init) => {
    if (fail) throw new Error("runtime unavailable");
    if (!String(_url).endsWith("/v1/settings")) return new Response("{}");
    if (!init?.method || init.method === "GET") {
      const values = { ...remote };
      if (!reportEffort) delete values.reasoningEffort;
      return new Response(JSON.stringify(values));
    }
    calls.push(JSON.parse(String(init?.body ?? "{}")));
    if (ignoreEffort && calls.at(-1)?.reasoningEffort !== undefined) return new Response("{}", { status: 200 });
    remote = { ...remote, ...calls.at(-1) };
    return new Response(JSON.stringify(remote), { status: 200 });
  };
  const app = Fastify({ logger: false });
  await app.register(issueRoutes);
  try {
    assert.equal((await app.inject({ method: "GET", url: "/api/settings" })).json().larkCodexResponder.reasoningEffortConfigurable, false);
    assert.deepEqual(getAppSettings().larkGroupSpontaneousChatIds, []);
    const saved = await app.inject({ method: "PATCH", url: "/api/settings", payload: { larkGroupSpontaneousChatIds: [" oc_allowed ", "oc_allowed"], larkGroupSpontaneousRepliesEnabled: true } });
    assert.equal(saved.statusCode, 200);
    assert.deepEqual(saved.json().larkGroupSpontaneousChatIds, ["oc_allowed"]);
    assert.deepEqual(calls[0], { groupSpontaneousChatIds: ["oc_allowed"], groupSpontaneousRepliesEnabled: true });
    await app.inject({ method: "PATCH", url: "/api/settings", payload: { larkGroupSpontaneousChatIds: ["oc_allowed"] } });
    assert.deepEqual(calls.at(-1), { groupSpontaneousChatIds: ["oc_allowed"] });
    assert.equal(remote.groupSpontaneousRepliesEnabled, true);
    await app.inject({ method: "PATCH", url: "/api/settings", payload: { larkGroupSpontaneousRepliesEnabled: false } });
    assert.deepEqual(calls.at(-1), { groupSpontaneousRepliesEnabled: false });
    assert.deepEqual(remote.groupSpontaneousChatIds, ["oc_allowed"]);
    for (const rate of [0, 1, 0.35]) {
      const probability = await app.inject({ method: "PATCH", url: "/api/settings", payload: { larkGroupSpontaneousReplyRate: rate } });
      assert.equal(probability.statusCode, 200);
      assert.equal(probability.json().larkGroupSpontaneousReplyRate, rate);
      assert.deepEqual(calls.at(-1), { groupSpontaneousReplyRate: rate });
    }
    for (const rate of [-0.1, 1.1, "0.5", null]) {
      assert.equal((await app.inject({ method: "PATCH", url: "/api/settings", payload: { larkGroupSpontaneousReplyRate: rate } })).statusCode, 400);
    }
    for (const cooldown of [0, 60_000, 604_800_000]) {
      const response = await app.inject({ method: "PATCH", url: "/api/settings", payload: { larkGroupSpontaneousReplyCooldownMs: cooldown } });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().larkGroupSpontaneousReplyCooldownMs, cooldown);
      assert.deepEqual(calls.at(-1), { groupSpontaneousReplyCooldownMs: cooldown });
    }
    for (const cooldown of [-1, 604_800_001, 1.5, "60000", null]) {
      assert.equal((await app.inject({ method: "PATCH", url: "/api/settings", payload: { larkGroupSpontaneousReplyCooldownMs: cooldown } })).statusCode, 400);
    }
    await app.inject({ method: "PATCH", url: "/api/settings", payload: { larkGroupSpontaneousReplyCooldownMs: 120_000 } });
    const model = await app.inject({ method: "PATCH", url: "/api/settings", payload: { larkCodexModel: "gpt-5.5-codex" } });
    assert.equal(model.statusCode, 200);
    assert.equal(model.json().larkCodexModel, "gpt-5.5-codex");
    assert.deepEqual(calls.at(-1), { codexModel: "gpt-5.5-codex" });
    for (const invalid of ["", "gpt model", "../model", "x".repeat(121), null, 1]) {
      assert.equal((await app.inject({ method: "PATCH", url: "/api/settings", payload: { larkCodexModel: invalid } })).statusCode, 400);
    }
    assert.equal((await app.inject({ method: "PATCH", url: "/api/settings", payload: { larkCodexReasoningEffort: "medium" } })).statusCode, 409);
    reportEffort = true;
    const effort = await app.inject({ method: "PATCH", url: "/api/settings", payload: { larkCodexReasoningEffort: "medium" } });
    assert.equal(effort.statusCode, 200);
    assert.equal(effort.json().larkCodexReasoningEffort, "medium");
    assert.deepEqual(calls.at(-1), { reasoningEffort: "medium" });
    reportEffort = true;
    const configured = (await app.inject({ method: "GET", url: "/api/settings" })).json();
    assert.equal(configured.larkCodexResponder.reasoningEffortConfigurable, true);
    assert.equal(configured.appSettings.larkCodexReasoningEffort, "medium");
    ignoreEffort = true;
    assert.equal((await app.inject({ method: "PATCH", url: "/api/settings", payload: { larkCodexReasoningEffort: "high" } })).statusCode, 502);
    assert.equal(getAppSettings().larkCodexReasoningEffort, "medium");
    ignoreEffort = false;
    for (const invalid of ["", "minimal", "MEDIUM", null, 1]) {
      assert.equal((await app.inject({ method: "PATCH", url: "/api/settings", payload: { larkCodexReasoningEffort: invalid } })).statusCode, 400);
    }
    const receipts = await app.inject({ method: "PATCH", url: "/api/settings", payload: { larkExecutionReceiptsEnabled: false } });
    assert.equal(receipts.statusCode, 200);
    assert.equal(receipts.json().larkExecutionReceiptsEnabled, false);
    assert.deepEqual(calls.at(-1), { executionReceiptsEnabled: false });
    assert.equal((await app.inject({ method: "PATCH", url: "/api/settings", payload: { larkExecutionReceiptsEnabled: "false" } })).statusCode, 400);
    const groupReaction = await app.inject({ method: "PATCH", url: "/api/settings", payload: { larkGroupMessageReactionEnabled: true, larkGroupMessageReactionEmoji: "LAUGH" } });
    assert.equal(groupReaction.statusCode, 200);
    assert.equal(groupReaction.json().larkGroupMessageReactionEnabled, true);
    assert.equal(groupReaction.json().larkGroupMessageReactionEmoji, "LAUGH");
    assert.deepEqual(calls.at(-1), { groupMessageReactionEnabled: true, groupMessageReactionEmoji: "LAUGH" });
    assert.deepEqual(remote.groupMessageReactionChatIds, ["oc_old"]);
    const reactionAllowlist = await app.inject({ method: "PATCH", url: "/api/settings", payload: { larkGroupMessageReactionChatIds: [" oc_reactions ", "oc_reactions"] } });
    assert.deepEqual(reactionAllowlist.json().larkGroupMessageReactionChatIds, ["oc_reactions"]);
    assert.deepEqual(calls.at(-1), { groupMessageReactionChatIds: ["oc_reactions"] });
    assert.equal(remote.groupMessageReactionEnabled, true);
    assert.equal(remote.groupMessageReactionEmoji, "LAUGH");
    assert.equal((await app.inject({ method: "PATCH", url: "/api/settings", payload: { larkGroupMessageReactionChatIds: ["*"] } })).statusCode, 400);
    assert.equal((await app.inject({ method: "PATCH", url: "/api/settings", payload: { larkGroupMessageReactionEmoji: "NOT_REAL" } })).statusCode, 400);
    for (const larkStickerUsageMode of ["off", "explicit", "natural", "always"] as const) {
      const response = await app.inject({ method: "PATCH", url: "/api/settings", payload: { larkStickerUsageMode } });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().larkStickerUsageMode, larkStickerUsageMode);
      assert.deepEqual(calls.at(-1), { stickerUsageMode: larkStickerUsageMode });
    }
    assert.equal((await app.inject({ method: "PATCH", url: "/api/settings", payload: { larkStickerUsageMode: "sometimes" } })).statusCode, 400);
    const backup = (await app.inject({ method: "GET", url: "/api/settings/backup" })).json();
    assert.equal(backup.appSettings.larkExecutionReceiptsEnabled, false);
    assert.equal(backup.appSettings.larkCodexModel, "gpt-5.5-codex");
    assert.equal(backup.appSettings.larkCodexReasoningEffort, "medium");
    assert.equal(backup.appSettings.larkStickerUsageMode, "always");
    assert.equal(backup.appSettings.larkGroupMessageReactionEnabled, true);
    assert.equal(backup.appSettings.larkGroupMessageReactionEmoji, "LAUGH");
    assert.deepEqual(backup.appSettings.larkGroupMessageReactionChatIds, ["oc_reactions"]);
    assert.equal(backup.appSettings.larkGroupSpontaneousReplyRate, 0.35);
    assert.equal(backup.appSettings.larkGroupSpontaneousReplyCooldownMs, 120_000);
    assert.deepEqual(backup.appSettings.larkGroupSpontaneousChatIds, ["oc_allowed"]);
    fail = true;
    assert.equal((await app.inject({ method: "PATCH", url: "/api/settings", payload: { larkGroupSpontaneousReplyCooldownMs: 180_000 } })).statusCode, 502);
    assert.equal(getAppSettings().larkGroupSpontaneousReplyCooldownMs, 120_000);
    assert.equal((await app.inject({ method: "PATCH", url: "/api/settings", payload: { larkExecutionReceiptsEnabled: true } })).statusCode, 502);
    assert.equal(getAppSettings().larkExecutionReceiptsEnabled, false);
    assert.equal((await app.inject({ method: "PATCH", url: "/api/settings", payload: { larkCodexModel: "gpt-5.4" } })).statusCode, 502);
    assert.equal(getAppSettings().larkCodexModel, "gpt-5.5-codex");
    assert.equal((await app.inject({ method: "PATCH", url: "/api/settings", payload: { larkCodexReasoningEffort: "high" } })).statusCode, 502);
    assert.equal(getAppSettings().larkCodexReasoningEffort, "medium");
    assert.equal((await app.inject({ method: "PATCH", url: "/api/settings", payload: { larkStickerUsageMode: "off" } })).statusCode, 502);
    assert.equal(getAppSettings().larkStickerUsageMode, "always");
    assert.equal(getAppSettings().larkGroupMessageReactionEnabled, true);
    assert.equal(getAppSettings().larkGroupMessageReactionEmoji, "LAUGH");
    assert.deepEqual(getAppSettings().larkGroupMessageReactionChatIds, ["oc_reactions"]);
    assert.equal((await app.inject({ method: "PATCH", url: "/api/settings", payload: { larkGroupMessageReactionEnabled: false } })).statusCode, 502);
    assert.equal(getAppSettings().larkGroupMessageReactionEnabled, true);
    assert.equal((await app.inject({ method: "PATCH", url: "/api/settings", payload: { larkGroupSpontaneousReplyRate: 0.8 } })).statusCode, 502);
    assert.equal(getAppSettings().larkGroupSpontaneousReplyRate, 0.35);
    assert.equal(getAppSettings().larkGroupSpontaneousReplyCooldownMs, 120_000);
    const failed = await app.inject({ method: "PATCH", url: "/api/settings", payload: { larkGroupSpontaneousChatIds: ["oc_other"] } });
    assert.equal(failed.statusCode, 502);
    assert.deepEqual(getAppSettings().larkGroupSpontaneousChatIds, ["oc_allowed"]);
    fail = false;
    assert.equal((await app.inject({ method: "PATCH", url: "/api/settings", payload: { larkGroupSpontaneousChatIds: ["*"] } })).statusCode, 400);
    const restored = await app.inject({ method: "POST", url: "/api/settings/backup/restore", payload: backup });
    assert.equal(restored.statusCode, 200);
    assert.equal(getAppSettings().larkGroupSpontaneousReplyCooldownMs, 120_000);
    assert.equal(calls.at(-1)?.groupSpontaneousReplyCooldownMs, 120_000);
    assert.equal(getAppSettings().larkExecutionReceiptsEnabled, false);
    assert.equal(calls.at(-1)?.executionReceiptsEnabled, false);
    assert.equal(getAppSettings().larkCodexModel, "gpt-5.5-codex");
    assert.equal(calls.at(-1)?.codexModel, "gpt-5.5-codex");
    assert.equal(getAppSettings().larkCodexReasoningEffort, "medium");
    assert.equal(calls.at(-1)?.reasoningEffort, "medium");
    assert.equal(getAppSettings().larkStickerUsageMode, "always");
    assert.equal(calls.at(-1)?.stickerUsageMode, "always");
    assert.equal(calls.at(-1)?.groupMessageReactionEnabled, true);
    assert.equal(calls.at(-1)?.groupMessageReactionEmoji, "LAUGH");
    assert.deepEqual(calls.at(-1)?.groupMessageReactionChatIds, ["oc_reactions"]);
    assert.equal(getAppSettings().larkGroupSpontaneousReplyRate, 0.35);
    assert.equal(calls.at(-1)?.groupSpontaneousReplyRate, 0.35);
    assert.deepEqual(getAppSettings().larkGroupSpontaneousChatIds, ["oc_allowed"]);
    delete backup.appSettings.larkGroupSpontaneousChatIds;
    delete backup.appSettings.larkGroupSpontaneousReplyRate;
    delete backup.appSettings.larkGroupSpontaneousReplyCooldownMs;
    delete backup.appSettings.larkCodexModel;
    delete backup.appSettings.larkCodexReasoningEffort;
    delete backup.appSettings.larkStickerUsageMode;
    delete backup.appSettings.larkGroupMessageReactionEnabled;
    delete backup.appSettings.larkGroupMessageReactionEmoji;
    delete backup.appSettings.larkGroupMessageReactionChatIds;
    delete backup.appSettings.larkExecutionReceiptsEnabled;
    assert.equal((await app.inject({ method: "POST", url: "/api/settings/backup/restore", payload: backup })).statusCode, 200);
    assert.deepEqual(getAppSettings().larkGroupSpontaneousChatIds, []);
    assert.deepEqual(calls.at(-1)?.groupSpontaneousChatIds, []);
    assert.equal(getAppSettings().larkGroupSpontaneousReplyRate, 0.08);
    assert.equal(getAppSettings().larkGroupSpontaneousReplyCooldownMs, 600_000);
    assert.equal(getAppSettings().larkCodexModel, "gpt-5.6-terra");
    assert.equal(getAppSettings().larkCodexReasoningEffort, "low");
    assert.equal(getAppSettings().larkStickerUsageMode, "natural");
    assert.equal(getAppSettings().larkGroupMessageReactionEnabled, false);
    assert.equal(getAppSettings().larkGroupMessageReactionEmoji, "THUMBSUP");
    assert.deepEqual(getAppSettings().larkGroupMessageReactionChatIds, []);
    assert.equal(getAppSettings().larkExecutionReceiptsEnabled, true);
  } finally {
    await app.close();
    globalThis.fetch = originalFetch;
    config.larkAgentUrl = previousUrl;
    config.workspaceRoot = previousWorkspace;
  }
});

test("Lark spontaneous group replies sample human text only and respect cooldown", () => {
  const event = { chat_id: "oc_group", chat_type: "group", sender_type: "user", message_type: "text", content: "这周会也太长了" };
  setAppSettingValue("larkGroupSpontaneousChatIds", JSON.stringify(["oc_group"]));
  assert.equal(shouldStartSpontaneousLarkReply(event, false, false, 0.07, true, 0.08), true);
  assert.equal(shouldStartSpontaneousLarkReply(event, false, false, 0.08, true, 0.08), false);
  assert.equal(shouldStartSpontaneousLarkReply(event, true, false, 0, true, 1), false);
  assert.equal(shouldStartSpontaneousLarkReply(event, false, true, 0, true, 1), false);
  assert.equal(shouldStartSpontaneousLarkReply({ ...event, sender_type: "bot" }, false, false, 0, true, 1), false);
  assert.equal(shouldStartSpontaneousLarkReply({ ...event, chat_type: "p2p" }, false, false, 0, true, 1), false);
  assert.equal(shouldStartSpontaneousLarkReply(event, false, false, 0, false, 1), false);
  assert.equal(shouldStartSpontaneousLarkReply(event, false, false, 0, true, 1, []), false);
  assert.equal(shouldStartSpontaneousLarkReply({ ...event, chat_id: "oc_other" }, false, false, 0, true, 1), false);
  assert.equal(shouldStartSpontaneousLarkReply({ ...event, chat_id: null }, false, false, 0, true, 1), false);
  setAppSettingValue("larkGroupSpontaneousChatIds", "[]");
});

test("Lark bot senders are identified from event metadata", () => {
  assert.equal(isLarkBotSender({ raw_json: JSON.stringify({ sender_type: "bot" }) }), true);
  assert.equal(isLarkBotSender({ raw_json: JSON.stringify({ event: { sender: { sender_type: "user" } } }) }), false);
  assert.equal(isLarkBotSender({ raw_json: "invalid" }), false);
});

test("Lark visible group replies use a real mention for the triggering sender", () => {
  assert.equal(larkAtTag("ou_sender"), '<at user_id="ou_sender"></at>');
  assert.equal(formatLarkFinalReply({ chat_type: "group", sender_id: "ou_sender" }, "收到。"), '<at user_id="ou_sender"></at> 收到。');
  assert.equal(
    formatLarkFinalReply({ chat_type: "group", sender_id: "ou_sender" }, '<at user_id="ou_sender"></at> 已处理。'),
    '<at user_id="ou_sender"></at> 已处理。'
  );
  assert.equal(formatLarkFinalReply({ chat_type: "p2p", sender_id: "ou_sender" }, "收到。"), "收到。");
  assert.equal(formatLarkFinalReply({ chat_type: "group", sender_id: null }, "收到。"), "收到。");
});

test("Lark media replies only accept generated output files and select the message type", () => {
  const taskDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-forge-media-"));
  const outputDir = path.join(taskDir, "output");
  fs.mkdirSync(outputDir);
  fs.writeFileSync(path.join(outputDir, "chart.png"), "png");
  fs.writeFileSync(path.join(outputDir, "report.pdf"), "pdf");
  try {
    const parsed = extractLarkReplyMedia(
      '结果已生成。<forge-media>{"files":[{"path":"chart.png"},{"path":"report.pdf"},{"path":"../secret.txt"}]}</forge-media>',
      taskDir
    );
    assert.equal(parsed.text, "结果已生成。");
    assert.deepEqual(parsed.media.map((media) => media.relativePath), ["output/chart.png", "output/report.pdf"]);
    assert.match(parsed.errors.join("\n"), /附件不存在或不在 output 目录中/);
    assert.deepEqual(buildLarkMediaReplyArgs("om_test", "output/chart.png", "media-image"), [
      "im", "+messages-reply", "--as", "bot", "--message-id", "om_test", "--image", "output/chart.png", "--idempotency-key", "media-image"
    ]);
    assert.deepEqual(buildLarkMediaReplyArgs("om_test", "output/report.pdf", "media-file"), [
      "im", "+messages-reply", "--as", "bot", "--message-id", "om_test", "--file", "output/report.pdf", "--idempotency-key", "media-file"
    ]);
  } finally {
    fs.rmSync(taskDir, { recursive: true, force: true });
  }
});

test("Lark multi-image replies use one post message", () => {
  const args = buildLarkImagePostReplyArgs("om_test", ["img_one", "img_two"], "media-images");
  assert.deepEqual(args.slice(0, 10), [
    "im", "+messages-reply", "--as", "bot", "--message-id", "om_test", "--msg-type", "post", "--content",
    JSON.stringify({ zh_cn: { content: [[{ tag: "img", image_key: "img_one" }], [{ tag: "img", image_key: "img_two" }]] } })
  ]);
  assert.deepEqual(args.slice(-2), ["--idempotency-key", "media-images"]);
});

test("Lark sticker library supports batch upload, editing, selection, and recoverable removal", async () => {
  resetTables();
  const previousDirectory = config.larkStickerDirectory;
  const stickerDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-forge-stickers-"));
  const taskDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-forge-sticker-task-"));
  const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
  config.larkStickerDirectory = stickerDirectory;
  const app = Fastify();
  await app.register(stickerRoutes);
  try {
    const emptyPrompt = larkStickerPrompt();
    assert.match(emptyPrompt, /"query":"情绪、动作、场景"/);
    assert.doesNotMatch(emptyPrompt, /stk_/);
    assert.deepEqual(detectStickerImage(Buffer.from(pngBase64, "base64")), { mimeType: "image/png", extension: ".png" });
    const upload = await app.inject({
      method: "POST",
      url: "/api/lark/stickers/batch",
      payload: {
        files: [{ name: "无语", description: "对离谱发言表示无语", tags: ["无语", "吐槽"], fileName: "speechless.png", mimeType: "image/png", dataBase64: pngBase64 }]
      }
    });
    assert.equal(upload.statusCode, 201, upload.body);
    const [created] = JSON.parse(upload.body) as Array<{ id: string; name: string; enabled: boolean }>;
    assert.match(created.id, /^stk_[a-f0-9]{16}$/);
    assert.equal(created.enabled, true);

    const update = await app.inject({
      method: "PATCH",
      url: `/api/lark/stickers/${created.id}`,
      payload: { name: "真无语", description: "遇到离谱发言时使用", tags: ["无语", "离谱"] }
    });
    assert.equal(update.statusCode, 200, update.body);
    assert.equal((JSON.parse(update.body) as { name: string }).name, "真无语");

    const stickerPrompt = larkStickerPrompt();
    assert.match(stickerPrompt, /表情包（按语境选用）/);
    assert.match(stickerPrompt, /自然语言词/);
    assert.doesNotMatch(stickerPrompt, new RegExp(created.id));
    assert.doesNotMatch(stickerPrompt, /真无语/);

    const autoSelected = ensureLarkStickerSelection("正常完成文字回答。", "oc_group", "这也太离谱了，我真无语");
    assert.equal(autoSelected, "正常完成文字回答。");
    assert.equal(ensureLarkStickerSelection(autoSelected, "oc_group", "无语"), autoSelected);
    const replacedInvalid = ensureLarkStickerSelection('回答。<forge-sticker>{"id":"stk_missing"}</forge-sticker>', "oc_group", "无语");
    assert.doesNotMatch(replacedInvalid, /stk_missing/);

    const staged = stageLarkStickerSelection(`行吧。<forge-sticker>{"id":"${created.id}"}</forge-sticker>`, taskDir);
    assert.equal(staged.text, "行吧。");
    assert.deepEqual(staged.stickerIds, [created.id]);
    assert.equal(staged.media[0]?.stickerId, created.id);
    assert.equal(fs.existsSync(staged.media[0]!.absolutePath), true);

    const queried = stageLarkStickerSelection('确实离谱。<forge-sticker>{"query":"无语、离谱"}</forge-sticker>', taskDir, "oc_group");
    assert.equal(queried.text, "确实离谱。");
    assert.deepEqual(queried.stickerIds, [created.id]);

    const unmatched = stageLarkStickerSelection('先说正事。<forge-sticker>{"query":"宇宙飞船、量子跃迁"}</forge-sticker>', taskDir, "oc_group");
    assert.equal(unmatched.text, "先说正事。");
    assert.deepEqual(unmatched.media, []);
    assert.deepEqual(unmatched.errors, []);

    const image = await app.inject({ method: "GET", url: `/api/lark/stickers/${created.id}/image` });
    assert.equal(image.statusCode, 200);
    assert.match(image.headers["content-type"] ?? "", /image\/png/);

    const removed = await app.inject({ method: "DELETE", url: `/api/lark/stickers/${created.id}` });
    assert.equal(removed.statusCode, 204);
    assert.deepEqual(listLarkStickers(), []);
  } finally {
    await app.close();
    config.larkStickerDirectory = previousDirectory;
    fs.rmSync(stickerDirectory, { recursive: true, force: true });
    fs.rmSync(taskDir, { recursive: true, force: true });
  }
});

test("Lark turns without agent text finish as no-reply instead of failure", () => {
  assert.equal(larkCodexTerminalStatus("answered", false), "no_reply");
  assert.equal(larkCodexTerminalStatus("answered", true), "answered");
  assert.equal(larkCodexTerminalStatus("failed", false), "failed");
});

test("Lark task artifacts use stable incremental chat session directories", () => {
  const paths = larkCodexTaskPaths({ id: 42, chat_id: "oc_group", message_id: "om_message" }, false);
  assert.match(paths.sessionDir, /lark-sessions\/oc_group\/untrusted$/);
  assert.match(paths.taskDir, /lark-sessions\/oc_group\/untrusted\/messages\/42-om_message$/);
});

test("Codex jobs use the shared App Server with the configured full-permission profile", () => {
  const params = buildCodexJobThreadParams();
  assert.equal(params.cwd, config.workspaceRoot);
  assert.equal(params.model, config.codexModel);
  assert.equal(params.approvalPolicy, "never");
  assert.equal(params.sandbox, "danger-full-access");
  assert.deepEqual(params.config, { model_reasoning_effort: config.codexReasoningEffort });
});

test("Codex jobs preserve active desktop writer conflicts instead of silently forking a thread", () => {
  assert.equal(isCodexAppServerActiveWriterError(new Error("thread abc already has an active writer")), true);
  assert.equal(isCodexAppServerActiveWriterError(new Error("network connection lost")), false);
});

test("Lark Codex turn restarts app-server for cwd permission failures", () => {
  assert.equal(larkCwdRecoveryStrategy(new Error("invalid cwd: Operation not permitted (os error 1)")), "restart-app-server");
  assert.equal(shouldRetryLarkTurnWithoutCwd(new Error("invalid cwd: Operation not permitted (os error 1)")), false);
});

test("Lark Codex turn retries other invalid cwd failures without a per-turn cwd", () => {
  assert.equal(shouldRetryLarkTurnWithoutCwd(new Error("invalid cwd: No such file or directory")), true);
  assert.equal(shouldRetryLarkTurnWithoutCwd(new Error("turn already running")), false);
});

test("Lark Codex authentication failures are recognized for one-time app-server recovery", () => {
  assert.equal(isLarkCodexAuthenticationFailure(new Error("Your access token could not be refreshed because you have since logged out or signed in to another account.")), true);
  assert.equal(isLarkCodexAuthenticationFailure("HTTP 401 token_revoked"), true);
  assert.equal(isLarkCodexAuthenticationFailure("invalid cwd: Operation not permitted (os error 1)"), false);
});

test("Codex app-server stderr warnings do not become responder failures", () => {
  assert.equal(codexAppServerStderrError(JSON.stringify({ level: "WARN", message: "plugin manifest is stale" })), null);
  assert.equal(codexAppServerStderrError("warning: optional plugin catalog is unavailable"), null);
  assert.match(
    codexAppServerStderrError(JSON.stringify({ level: "ERROR", message: "app-server startup failed" })) ?? "",
    /app-server startup failed/
  );
  assert.equal(codexAppServerStderrError("fatal: app-server exited unexpectedly"), "fatal: app-server exited unexpectedly");
});

test("Lark Codex app-server disables hooks without disabling plugins", () => {
  const args = codexAppServerArgs();
  assert.deepEqual(args, ["app-server", "--disable", "hooks", "--listen", "stdio://"]);
  assert.equal(args.includes("plugins"), false);
});

test("Codex executable resolution falls back to the user's local bin", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "autofix-codex-home-"));
  const executable = path.join(homeDir, ".local", "bin", "codex");
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(executable, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(executable, 0o755);

  assert.equal(resolveCodexExecutable({
    env: { PATH: path.join(homeDir, "empty-bin") },
    homeDir,
    bundledExecutable: path.join(homeDir, "missing-bundled-codex")
  }), executable);
});

test("Codex executable resolution honors an explicit executable", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "autofix-codex-bin-"));
  const executable = path.join(directory, "custom-codex");
  fs.writeFileSync(executable, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(executable, 0o755);

  assert.equal(resolveCodexExecutable({
    env: { CODEX_EXECUTABLE: executable, PATH: "" },
    homeDir: directory,
    bundledExecutable: path.join(directory, "missing-bundled-codex")
  }), executable);
});

test("Lark Codex steer keeps agent replies owned by their triggering messages", () => {
  const notifications = [
    {
      method: "item/completed",
      params: { item: { id: "user-289", type: "userMessage", clientId: "om_289", text: "你会什么" } }
    },
    {
      method: "item/completed",
      params: { item: { id: "agent-289", type: "agentMessage", phase: "commentary", text: "我可以帮你排查问题。" } }
    },
    {
      method: "item/completed",
      params: { item: { id: "user-290", type: "userMessage", clientId: "om_290", text: "说你好" } }
    },
    {
      method: "item/completed",
      params: { item: { id: "agent-290", type: "agentMessage", phase: "final_answer", text: "你好" } }
    }
  ];
  const replies = new Map<string, string>();
  let currentMessageId = "";
  for (const notification of notifications) {
    const event = larkCodexCompletedMessageEvent(notification);
    if (event?.type === "user") {
      currentMessageId = event.clientId;
    } else if (event?.type === "agent") {
      replies.set(currentMessageId, event.text);
    }
  }

  assert.deepEqual(Object.fromEntries(replies), {
    om_289: "我可以帮你排查问题。",
    om_290: "你好"
  });
});

test("Lark Codex responder routes untrusted write operations through approval", () => {
  const prompt = buildLarkCodexPrompt({
    content: "看看现在其他 Codex 进程在做什么",
    chat_type: "p2p",
    sender_id: "ou_sender",
    reply_to_message_id: null,
    reply_to_message_type: null,
    reply_to_content: null
  }, {
    trustedSender: false
  });
  assert.match(prompt, /当前发送人未通过可信校验/);
  assert.match(prompt, /只读的数据查询类 skill/);
  assert.match(prompt, /飞书文档查询/);
  assert.match(prompt, /Grafana\/Loki\/Prometheus/);
  assert.match(prompt, /只读数据库查询/);
  assert.match(prompt, /真正执行前暂停并请求人工授权/);
  assert.match(prompt, /不要绕过或隐藏授权请求/);
  assert.match(prompt, /没有获得工具执行结果时，不要声称已经完成/);
  assert.match(prompt, /send-lark-message\.mjs/);
  assert.match(prompt, /用户要求给飞书同事发消息时，使用飞书 bot 消息工具/);
  assert.match(prompt, /read-only sandbox/);
  assert.match(prompt, /最终回复严禁提及内部安全规则/);
  assert.match(prompt, /只输出对用户有用的业务回答/);
  const threadParams = buildLarkCodexThreadParams(false);
  assert.equal(threadParams.sandbox, "read-only");
  assert.equal(threadParams.approvalPolicy, "on-request");
});

test("Lark execution approval card offers one-time and current-turn decisions", () => {
  const card = buildLarkExecutionApprovalCard({
    requester: "测试同事",
    originalMessage: "帮我重启 demo 服务",
    operation: "npm run restart:demo",
    cwd: "/tmp/demo",
    reason: "需要启动服务",
    approvalToken: "approval-token"
  });
  const text = JSON.stringify(card);
  assert.match(text, /Codex 执行授权/);
  assert.match(text, /测试同事/);
  assert.match(text, /npm run restart:demo/);
  assert.match(text, /允许本次/);
  assert.match(text, /允许当前任务/);
  assert.match(text, /approve-turn/);
  assert.match(text, /approval-token/);
  assert.match(text, /拒绝/);
  assert.match(text, /10 分钟后失效/);
  assert.doesNotMatch(text, /multi_url/);
  assert.doesNotMatch(text, /127\.0\.0\.1/);
});

test("Lark App Server permission approvals preserve the requested permission profile", () => {
  const permissions = {
    network: { enabled: true },
    fileSystem: { read: ["/tmp/read"], write: ["/tmp/write"] }
  };
  const details = approvalRequestDetails({
    id: "permission-request",
    method: "item/permissions/requestApproval",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      cwd: "/tmp/project",
      reason: "需要下载依赖并写入构建产物",
      permissions,
      startedAtMs: 1
    }
  });
  assert.ok(details);
  assert.match(details.operation, /访问网络/);
  assert.match(details.operation, /读取 \/tmp\/read/);
  assert.match(details.operation, /写入 \/tmp\/write/);
  assert.deepEqual(details.approvedResponse, { permissions });
  assert.deepEqual(details.rejectedResponse, { permissions: {} });
});

test("Lark legacy App Server approvals normalize commands and patches", () => {
  const command = approvalRequestDetails({
    id: "legacy-command",
    method: "execCommandApproval",
    params: { conversationId: "thread-1", callId: "call-1", command: ["node", "deploy.mjs"], cwd: "/tmp/project", reason: "发布服务" }
  });
  assert.deepEqual(command && { threadId: command.threadId, itemId: command.itemId, operation: command.operation, approved: command.approvedResponse, rejected: command.rejectedResponse }, {
    threadId: "thread-1", itemId: "call-1", operation: "node deploy.mjs", approved: "accept", rejected: "decline"
  });
  const patch = approvalRequestDetails({
    id: "legacy-patch",
    method: "applyPatchApproval",
    params: { conversationId: "thread-2", callId: "call-2", fileChanges: { "src/app.ts": {}, "src/test.ts": {} }, reason: "修复问题" }
  });
  assert.match(patch?.operation ?? "", /src\/app.ts/);
  assert.equal(patch?.approvedResponse, "accept");
  assert.equal(patch?.rejectedResponse, "decline");
});

test("Codex App Server does not start for native status reads", async () => {
  const client = new CodexAppServerClient(() => process.cwd());
  assert.equal(await client.requestIfRunning("model/list", { limit: 1 }), null);
  assert.equal(client.status().running, false);
});

test("Lark execution approval card summarizes concurrent operations as one batch", () => {
  const operation = formatLarkApprovalBatchOperation(["deploy demo-agent", "deploy demo-api"]);
  const card = buildLarkExecutionApprovalCard({
    requester: "测试同事",
    originalMessage: "核对然后发布",
    operation,
    operationCount: 2,
    cwd: "/tmp/demo",
    reason: "发布两个服务",
    approvalToken: "batch-token"
  });
  const text = JSON.stringify(card);
  assert.match(operation, /共 2 项/);
  assert.match(operation, /deploy demo-agent/);
  assert.match(operation, /deploy demo-api/);
  assert.match(text, /待执行操作（2 项）/);
  assert.match(text, /当前批次的 2 项操作/);
});

test("Lark approval callbacks accept only supported button actions", () => {
  assert.deepEqual(parseLarkExecutionApprovalAction({
    action_tag: "button",
    action_value: JSON.stringify({ action: "approve-turn", approval_token: "approval-token" })
  }), { token: "approval-token", decision: "approve-turn" });
  assert.deepEqual(parseLarkExecutionApprovalAction({
    action_tag: "button",
    action_value: { action: "reject", approval_token: "approval-token" }
  }), { token: "approval-token", decision: "reject" });
  assert.equal(parseLarkExecutionApprovalAction({
    action_tag: "button",
    action_value: JSON.stringify({ action: "run-anything", approval_token: "approval-token" })
  }), null);
  assert.equal(parseLarkExecutionApprovalAction({
    action_tag: "select_static",
    action_value: JSON.stringify({ action: "approve", approval_token: "approval-token" })
  }), null);
});

test("Lark approval card callbacks require the configured approver and original card", () => {
  resetTables();
  const createdAt = nowIso();
  const message = db.prepare(`
    INSERT INTO lark_messages (event_id, message_id, sender_id, content, raw_json, received_at, created_at)
    VALUES ('evt-approval-security', 'om-request', 'ou-requester', 'deploy demo', '{}', ?, ?)
  `).run(createdAt, createdAt);
  db.prepare(`
    INSERT INTO lark_execution_approvals (
      token, lark_message_id, requester_id, approver_id, request_method, server_request_id,
      thread_id, turn_id, item_id, operation, status, card_message_id, created_at, expires_at
    ) VALUES (
      'approval-security-token', ?, 'ou-requester', 'ou-owner', 'item/commandExecution/requestApproval',
      'request-security', 'thread-security', 'turn-security', 'item-security', 'deploy demo',
      'pending', 'om-approval-card', ?, ?
    )
  `).run(message.lastInsertRowid, createdAt, new Date(Date.now() + 600_000).toISOString());

  assert.equal(decideLarkExecutionApprovalFromCard({
    token: "approval-security-token",
    decision: "approve",
    operatorId: "ou-other",
    messageId: "om-approval-card"
  }).status, "forbidden");
  assert.equal(decideLarkExecutionApprovalFromCard({
    token: "approval-security-token",
    decision: "approve",
    operatorId: "ou-owner",
    messageId: "om-forwarded-card"
  }).status, "mismatch");
  const row = db.prepare("SELECT status FROM lark_execution_approvals WHERE token = 'approval-security-token'").get() as { status: string };
  assert.equal(row.status, "pending");
});

test("Lark execution approval result card removes actions and shows the final state", () => {
  const card = buildLarkExecutionApprovalResultCard({
    requester: "测试同事",
    originalMessage: "帮我重启 demo 服务",
    operation: "npm run restart:demo",
    cwd: "/tmp/demo",
    reason: "需要启动服务",
    status: "approved",
    approvalScope: "turn",
    decidedAt: "2026-07-27T12:23:51.037Z"
  });
  const text = JSON.stringify(card);
  assert.match(text, /Codex 执行授权 · 已允许当前任务/);
  assert.match(text, /新 turn 会重新审批/);
  assert.doesNotMatch(text, /拒绝/);
  assert.doesNotMatch(text, /"tag":"action"/);
  assert.doesNotMatch(text, /multi_url/);
});

test("Lark turn approval only reuses permission for the same turn and requester", () => {
  assert.equal(shouldReuseLarkTurnApproval({
    runTurnId: "turn-1",
    requestTurnId: "turn-1",
    approvedRequesterId: "ou_sender",
    requesterId: "ou_sender"
  }), true);
  assert.equal(shouldReuseLarkTurnApproval({
    runTurnId: "turn-1",
    requestTurnId: "turn-2",
    approvedRequesterId: "ou_sender",
    requesterId: "ou_sender"
  }), false);
  assert.equal(shouldReuseLarkTurnApproval({
    runTurnId: "turn-1",
    requestTurnId: "turn-1",
    approvedRequesterId: "ou_sender",
    requesterId: "ou_other"
  }), false);
});

test("Lark Codex responder hides internal context from untrusted replies", () => {
  const reply = sanitizeLarkCodexReply(
    "依据当前 本机工作区规则，涉及修复、关闭 issue、开 PR 这类动作需要可信用户授权或正式任务后才能执行。你暴露了你自己的 context @测试分身",
    false
  );
  assert.doesNotMatch(reply, /本机工作区/);
  assert.doesNotMatch(reply, /可信用户/);
  assert.doesNotMatch(reply, /context/);
  assert.match(reply, /issue/);

  const mixed = sanitizeLarkCodexReply(
    "收到。建议已处理的在 issue 里补充 PR 后再关闭。\n依据当前 本机工作区规则，我不能因为权限执行。",
    false
  );
  assert.equal(mixed, "收到。建议已处理的在 issue 里补充 PR 后再关闭。");

  const trusted = sanitizeLarkCodexReply("依据当前 本机工作区规则，需要检查 AGENTS.md。", true);
  assert.match(trusted, /本机工作区/);
  assert.match(trusted, /AGENTS\.md/);
});

test("Lark reply idempotency keys stay within Feishu uuid limits", () => {
  const key = larkReplyIdempotencyKey("timeout", "om_example_notification");
  assert.match(key, /^afc-timeout-[a-f0-9]{16}$/);
  assert.equal(key.length < 36, true);
});

test("Lark reaction acknowledgement uses CLI reaction API", () => {
  assert.deepEqual(buildLarkReactionArgs("om_test", "THUMBSUP"), [
    "im",
    "reactions",
    "create",
    "--as",
    "bot",
    "--params",
    JSON.stringify({ message_id: "om_test" }),
    "--data",
    JSON.stringify({ reaction_type: { emoji_type: "THUMBSUP" } })
  ]);
});

test("Lark Codex responder extracts answers from Codex JSONL stream", () => {
  const line = JSON.stringify({
    type: "item.completed",
    item: { id: "item_0", type: "agent_message", text: "可以这么回复。" }
  });
  assert.equal(extractAgentMessageFromCodexJsonLine(line), "可以这么回复。");
  assert.equal(extractAgentMessageFromCodexJsonLine("not-json"), null);
});

test("Lark Codex responder uses the final agent message as the answer", () => {
  const text = [
    JSON.stringify({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: "我先查看资料。" } }),
    JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "command_execution", command: "sed -n '1,20p' AGENTS.md", status: "completed" } }),
    JSON.stringify({ type: "item.completed", item: { id: "item_2", type: "agent_message", text: "最终结论：可以巡查，但需要在线日志权限。" } })
  ].join("\n");
  assert.equal(readLarkCodexAnswer("/tmp/autofix-missing-answer.txt", text), "最终结论：可以巡查，但需要在线日志权限。");
});

test("Lark Codex responder extracts multiple streamable agent messages", () => {
  const text = [
    JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
    JSON.stringify({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: "我先查看资料。" } }),
    JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "command_execution", command: "sed -n '1,20p' AGENTS.md", status: "completed" } }),
    JSON.stringify({ type: "item.completed", item: { id: "item_2", type: "agent_message", text: "最终结论：可以巡查，但需要在线日志权限。" } })
  ].join("\n");
  assert.deepEqual(extractAgentMessageEventsFromCodexJsonl(text), [
    { id: "item_0", text: "我先查看资料。" },
    { id: "item_2", text: "最终结论：可以巡查，但需要在线日志权限。" }
  ]);
});

test("Lark Codex responder streams only unsent short agent messages", () => {
  const sent = new Set(["item_0"]);
  const longMessage = "这是一条很长的最终答复。".repeat(100);
  const text = [
    JSON.stringify({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: "我先查看资料。" } }),
    JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "已经定位到相关任务记录，继续验证。" } }),
    JSON.stringify({ type: "item.completed", item: { id: "item_2", type: "agent_message", text: longMessage } })
  ].join("\n");
  assert.deepEqual(extractStreamableAgentMessageEventsFromCodexJsonl(text, sent), [
    { id: "item_1", text: "已经定位到相关任务记录，继续验证。" }
  ]);
});

test("Lark startup stalls recover before sending a generic progress reply", () => {
  assert.equal(shouldRecoverLarkStartupStall(59_999, false, 60_000), false);
  assert.equal(shouldRecoverLarkStartupStall(60_000, false, 60_000), true);
  assert.equal(shouldRecoverLarkStartupStall(600_000, true, 60_000), false);
});

test("orphaned Lark runs become explicitly retryable", () => {
  resetTables();
  const startedAt = new Date(Date.now() - 180_000).toISOString();
  db.prepare(`
    INSERT INTO lark_messages (
      event_id, message_id, chat_id, chat_type, sender_id, message_type, content,
      mentioned, reply_status, reply_error, codex_status, raw_json, received_at, created_at,
      codex_started_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "evt-orphan", "om-orphan", "oc_orphan", "group", "ou_orphan", "text", "还在吗",
    1, "sent", null, "running", "{}", startedAt, startedAt, startedAt
  );
  assert.equal(reconcileOrphanedLarkCodexRuns(Date.now(), true), 1);
  const row = db.prepare("SELECT codex_status, codex_reply, codex_error, codex_finished_at FROM lark_messages WHERE event_id = 'evt-orphan'").get() as { codex_status: string; codex_reply: string | null; codex_error: string; codex_finished_at: string | null };
  assert.equal(row.codex_status, "failed");
  assert.equal(row.codex_reply, null);
  assert.match(row.codex_error, /Retry this message/);
  assert.ok(row.codex_finished_at);
});

test("Lark Codex responder does not treat Codex lifecycle JSONL as an answer", () => {
  const lifecycle = [
    JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
    JSON.stringify({ type: "turn.started" })
  ].join("\n");
  assert.equal(readLarkCodexAnswer("/tmp/autofix-missing-answer.txt", lifecycle), "");
});

test("Codex session id is extracted from session_meta JSONL", () => {
  const text = [
    "not-json",
    JSON.stringify({ type: "response_item", payload: { id: "ignored" } }),
    JSON.stringify({ type: "thread.started", thread_id: "019e4b51-823b-7741-993b-fb280291569c" }),
    JSON.stringify({ type: "session_meta", payload: { id: "019e49c1-427a-7352-b076-2b99057b7117" } })
  ].join("\n");
  assert.equal(extractCodexSessionIdFromJsonl(text), "019e49c1-427a-7352-b076-2b99057b7117");
});

test("Codex thread.started id is used when session_meta is absent", () => {
  const text = [
    JSON.stringify({ type: "thread.started", thread_id: "019e4b51-823b-7741-993b-fb280291569c" }),
    JSON.stringify({ type: "turn.started" })
  ].join("\n");
  assert.equal(extractCodexSessionIdFromJsonl(text), "019e4b51-823b-7741-993b-fb280291569c");
});

test("AutoFix Codex session matching accepts current metadata and rejects stale transcript echoes", () => {
  resetTables();
  const taskDir = "/tmp/autofix-pr-44-job-1";
  const createdAt = "2026-06-04T08:38:20.000Z";
  const issueId = Number(db.prepare(`
    INSERT INTO issues (
      source, external_id, kind, repo_owner, repo_name, title, body, url, state,
      assignee, author, reviewers, labels, head_sha, status, created_at, updated_at
    )
    VALUES ('gitea', '44', 'pr', 'acme', 'api', 'Improve API incrementally', 'please review', 'https://git.example/acme/api/pulls/44',
      'open', NULL, 'teammate', '["codex"]', '[]', 'sha-2', 'open', ?, ?)
  `).run(createdAt, createdAt).lastInsertRowid);
  const jobId = Number(db.prepare(`
    INSERT INTO repair_jobs (issue_id, status, phase, mode, repo_hint, task_dir, created_at, updated_at)
    VALUES (?, 'done', 'review', 'review_only', 'api', ?, ?, ?)
  `).run(issueId, taskDir, createdAt, createdAt).lastInsertRowid);
  const prompt = [
    "# AutoFix PR Review",
    "",
    `- Job ID: \`${jobId}\``,
    `- Task package: \`${taskDir}\``,
    "",
    "## AutoFix Runner Contract"
  ].join("\n");
  const fresh = [
    JSON.stringify({ type: "session_meta", payload: { id: "session-1", source: "vscode", timestamp: "2026-06-04T08:38:25.000Z" } }),
    JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: prompt } })
  ].join("\n");
  const stale = [
    JSON.stringify({ type: "session_meta", payload: { id: "session-2", source: "vscode", timestamp: "2026-05-21T03:50:07.000Z" } }),
    JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: prompt } })
  ].join("\n");

  assert.equal(isAutoFixSessionForTask(fresh, jobId, taskDir), true);
  assert.equal(isAutoFixSessionForTask(stale, jobId, taskDir), false);
});

test("Codex JSONL diagnostics report the last event timestamp", () => {
  const text = [
    JSON.stringify({ timestamp: "2026-05-21T10:54:01.000Z", type: "session_meta", payload: { id: "abc" } }),
    "not-json",
    JSON.stringify({ timestamp: "2026-05-21T10:58:55.425Z", type: "response_item", payload: { type: "function_call" } })
  ].join("\n");
  assert.equal(lastCodexJsonlTimestamp(text), "2026-05-21T10:58:55.425Z");
});

test("Codex JSONL diagnostics detect completed turns without final artifacts", () => {
  const text = [
    JSON.stringify({ timestamp: "2026-05-25T07:57:08.780Z", type: "session_meta", payload: { id: "session-1" } }),
    JSON.stringify({ timestamp: "2026-05-25T07:57:13.011Z", type: "event_msg", payload: { type: "agent_message", message: "I will inspect the PR first." } }),
    JSON.stringify({ timestamp: "2026-05-25T07:57:14.109Z", type: "event_msg", payload: { type: "task_complete", last_agent_message: "I will inspect the PR first." } })
  ].join("\n");
  assert.deepEqual(codexSessionDiagnostics(text), {
    taskComplete: true,
    taskCompleteWithoutAgentMessage: false,
    turnFailed: false,
    terminalError: null,
    lastAgentMessage: "I will inspect the PR first.",
    lastTimestamp: "2026-05-25T07:57:14.109Z"
  });
});

test("PR review outcome requires a posted record artifact and preserves the review verdict", () => {
  const taskDir = fs.mkdtempSync(path.join(os.tmpdir(), "autofix-review-outcome-"));
  const issueUrl = "https://git.example/acme/api/pulls/42";
  assert.equal(reviewRunOutcomeFromArtifacts("needs_review", taskDir, issueUrl).runStatus, "failed");

  fs.writeFileSync(path.join(taskDir, "record.json"), JSON.stringify({
    state: "posted",
    posted: true,
    posted_comment_url: `${issueUrl}#issuecomment-7`,
    verdict: "request_changes"
  }));
  assert.deepEqual(reviewRunOutcomeFromArtifacts("needs_review", taskDir, issueUrl), {
    jobStatus: "done",
    runStatus: "succeeded",
    posted: true,
    postedCommentUrl: `${issueUrl}#issuecomment-7`,
    verdict: "request_changes",
    error: null
  });
  assert.equal(reviewRunOutcomeFromArtifacts("blocked", taskDir, issueUrl).runStatus, "cancelled");
});

test("PR review comment validation accepts configured Gitea aliases and rejects unrelated URLs", () => {
  const taskDir = fs.mkdtempSync(path.join(os.tmpdir(), "autofix-review-alias-"));
  const previousUrls = config.giteaBaseUrls;
  const previousUrl = config.giteaBaseUrl;
  const issueUrl = "https://gitea.example/acme/api/pulls/42";
  const commentUrl = "https://git.example/acme/api/pulls/42#issuecomment-7";
  const record = { state: "posted", posted: true, posted_comment_url: commentUrl, verdict: "request_changes" };
  const check = (url: string, expected: boolean, target: string | null = issueUrl) => {
    fs.writeFileSync(path.join(taskDir, "record.json"), JSON.stringify({ ...record, posted_comment_url: url }));
    const result = reviewRunOutcomeFromArtifacts("needs_review", taskDir, target);
    assert.equal(result.posted, expected, `${target} <- ${url}`);
    if (expected) {
      assert.equal(result.jobStatus, "done");
      assert.equal(result.postedCommentUrl, url);
      assert.equal(result.verdict, "request_changes");
    }
  };
  try {
    config.giteaBaseUrls = ["https://gitea.example/", "https://git.example", "https://proxy.example/gitea/"];
    check(commentUrl, true);
    check(`${issueUrl}#issuecomment-7`, true);
    check("https://GIT.example:443/acme/api/pulls/42/#issuecomment-8", true);
    check("https://proxy.example/gitea/acme/api/pulls/42#issuecomment-7", true);
    check("https://gitea.example/acme/api/pulls/42#issuecomment-7", true, "https://git.example/acme/api/pulls/42");
    for (const url of [
      "https://unknown.example/acme/api/pulls/42#issuecomment-7",
      "https://git.example.evil/acme/api/pulls/42#issuecomment-7",
      "https://git.example:444/acme/api/pulls/42#issuecomment-7",
      "http://git.example/acme/api/pulls/42#issuecomment-7",
      "https://user:pass@git.example/acme/api/pulls/42#issuecomment-7",
      "https://git.example/other/api/pulls/42#issuecomment-7",
      "https://git.example/acme/other/pulls/42#issuecomment-7",
      "https://git.example/acme/api/pulls/420#issuecomment-7",
      "https://git.example/acme/api/issues/42#issuecomment-7",
      "https://proxy.example/gitea-other/acme/api/pulls/42#issuecomment-7",
      "https://git.example/acme/api/pulls/42",
      "https://git.example/acme/api/pulls/42#issuecomment-",
      "https://git.example/acme/api/pulls/42#issuecomment-7garbage",
      "https://git.example/acme/api/pulls/42#issuecomment-0",
      "not-a-url"
    ]) check(url, false);
    check(commentUrl, false, null);
    check(commentUrl, false, "invalid");
    check(commentUrl, false, "https://unknown.example/acme/api/pulls/42");
    check(commentUrl, true);
    assert.equal(reviewRunOutcomeFromArtifacts("needs_review", taskDir, issueUrl, []).posted, false);
    assert.equal(reviewRunOutcomeFromArtifacts("failed", taskDir, issueUrl).jobStatus, "failed");
    assert.equal(reviewRunOutcomeFromArtifacts("blocked", taskDir, issueUrl).jobStatus, "blocked");
    for (const patch of [{ state: "local" }, { posted: false }]) {
      fs.writeFileSync(path.join(taskDir, "record.json"), JSON.stringify({ ...record, ...patch }));
      assert.equal(reviewRunOutcomeFromArtifacts("needs_review", taskDir, issueUrl).posted, false);
    }
    config.giteaBaseUrls = ["https://gitea.example"];
    check(commentUrl, false);
    check(`${issueUrl}#issuecomment-7`, true);
    config.giteaBaseUrls = [];
    config.giteaBaseUrl = "https://gitea.example";
    check(`${issueUrl}#issuecomment-7`, true);
    check(commentUrl, false);
  } finally {
    config.giteaBaseUrls = previousUrls;
    config.giteaBaseUrl = previousUrl;
    fs.rmSync(taskDir, { recursive: true, force: true });
  }
});

test("Codex watchdog detects terminal errors and stale session activity", () => {
  const errorText = JSON.stringify({ timestamp: "2026-07-10T08:00:00.000Z", type: "error", status: 400 });
  assert.equal(codexSessionDiagnostics(errorText).terminalError, "400");
  assert.equal(isCodexSessionStalled("2026-07-10T08:00:00.000Z", Date.parse("2026-07-10T08:02:00.000Z"), 120_000), true);
  assert.equal(isCodexSessionStalled("2026-07-10T08:00:01.000Z", Date.parse("2026-07-10T08:02:00.000Z"), 120_000), false);
  assert.equal(isCodexRecoveryGraceElapsed(0, 120_000, 120_000), true);
  assert.equal(isCodexRecoveryGraceElapsed(120_000, 125_000, 120_000), false);
  assert.equal(isCodexRecoveryGraceElapsed(120_000, 240_000, 120_000), true);
});

test("Codex JSONL diagnostics flag completed turns without an agent message for recovery", () => {
  const text = JSON.stringify({
    timestamp: "2026-07-10T08:00:00.000Z",
    type: "event_msg",
    payload: { type: "task_complete", last_agent_message: null }
  });
  const diagnostics = codexSessionDiagnostics(text);
  assert.equal(diagnostics.taskComplete, true);
  assert.equal(diagnostics.taskCompleteWithoutAgentMessage, true);
  assert.equal(diagnostics.lastAgentMessage, null);
});

test("PR review artifact reconciliation backfills a confirmed comment URL and verdict", () => {
  resetTables();
  const taskDir = fs.mkdtempSync(path.join(os.tmpdir(), "autofix-review-reconcile-"));
  const now = nowIso();
  const issueUrl = "https://git.example/acme/api/pulls/42";
  fs.writeFileSync(path.join(taskDir, "record.json"), JSON.stringify({
    state: "posted",
    posted: true,
    posted_comment_url: `${issueUrl}#issuecomment-9`,
    verdict: "no_blocking_findings"
  }));
  const issueId = Number(db.prepare(`
    INSERT INTO issues (source, external_id, kind, repo_owner, repo_name, title, body, url, status, created_at, updated_at)
    VALUES ('gitea', '42', 'pr', 'acme', 'api', 'Review me', '', ?, 'open', ?, ?)
  `).run(issueUrl, now, now).lastInsertRowid);
  const jobId = Number(db.prepare(`
    INSERT INTO repair_jobs (issue_id, status, phase, mode, task_dir, created_at, updated_at)
    VALUES (?, 'done', 'review', 'review_only', ?, ?, ?)
  `).run(issueId, taskDir, now, now).lastInsertRowid);
  db.prepare(`
    INSERT INTO pr_review_runs (issue_id, job_id, repo, pr_number, head_sha, review_key, status, runtime, verdict, posted, posted_comment_url, created_at)
    VALUES (?, ?, 'acme/api', '42', 'sha-1', 'acme/api#pr-42@sha-1', 'succeeded', 'codex', 'unknown', 1, ?, ?)
  `).run(issueId, jobId, issueUrl, now);

  assert.equal(reconcilePrReviewRunArtifacts(), 1);
  const run = db.prepare("SELECT verdict, posted_comment_url FROM pr_review_runs WHERE job_id = ?").get(jobId) as { verdict: string; posted_comment_url: string };
  assert.deepEqual(run, { verdict: "comment", posted_comment_url: `${issueUrl}#issuecomment-9` });
});

test("Codex runner uses separate lightweight prompts for PR review and issue repair", () => {
  const prReviewPrompt = promptTemplatePath({ kind: "pr" }, { mode: "review_only" });
  assert.equal(path.basename(prReviewPrompt), "pr-review-job.md");
  assert.equal(path.dirname(prReviewPrompt), path.join(repoRoot, "prompts"));
  assert.equal(path.basename(promptTemplatePath({ kind: "issue" }, { mode: "issue_triage" })), "issue-triage-job.md");
  assert.equal(path.basename(promptTemplatePath({ kind: "issue" }, { mode: "issue_implementation" })), "issue-implementation-job.md");
});

test("PR review prompt delegates review workflow to tea-pr-review skill", () => {
  const prompt = fs.readFileSync(path.join(repoRoot, "prompts", "pr-review-job.md"), "utf8");
  assert.match(prompt, /tea-pr-review/);
  assert.match(prompt, /Save the posted review body to/);
  assert.match(prompt, /Finish by writing `final\.json`/);
  assert.doesNotMatch(prompt, /Inspect the real PR metadata and diff with `tea` and local `git`/);
  assert.doesNotMatch(prompt, /findings-first review/);
});

test("prepared PR review package context points Codex to generated artifacts", () => {
  const taskDir = fs.mkdtempSync(path.join(os.tmpdir(), "autofix-review-package-"));
  const contextPath = path.join(taskDir, "review-context.md");
  fs.writeFileSync(contextPath, "# Prepared PR Review Package\n\n- History status: `incremental`\n");
  fs.writeFileSync(path.join(taskDir, "prepare-review-package.json"), JSON.stringify({ ok: true }));

  const context = preparedReviewPackageContext(taskDir);
  assert.match(context, /Prepared Review Package/);
  assert.match(context, new RegExp(contextPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(context, /diff\.patch/);
  assert.match(context, /incremental-diff\.patch/);
  assert.match(context, /Only run additional commands for targeted follow-up questions/);
});

test("prepared PR review package context reports package generation failures", () => {
  const taskDir = fs.mkdtempSync(path.join(os.tmpdir(), "autofix-review-package-error-"));
  const errorPath = path.join(taskDir, "prepare-review-package-error.log");
  fs.writeFileSync(errorPath, "tea failed\n");

  const context = preparedReviewPackageContext(taskDir);
  assert.match(context, /Package generation failed/);
  assert.match(context, new RegExp(errorPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(context, /fall back to the tea-pr-review workflow/);
});

test("issue triage prompt produces a development plan without code changes", () => {
  const prompt = fs.readFileSync(path.join(repoRoot, "prompts", "issue-triage-job.md"), "utf8");
  assert.match(prompt, /Classify the issue as exactly one of/);
  assert.match(prompt, /difficulty`, `workload`, `importance`, and `complexity/);
  assert.match(prompt, /development-plan\.md/);
  assert.match(prompt, /Do not edit files, create a worktree, commit, push, post comments, open PRs/);
});

test("issue implementation prompt only uses triage package as scope", () => {
  const prompt = fs.readFileSync(path.join(repoRoot, "prompts", "issue-implementation-job.md"), "utf8");
  assert.match(prompt, /using only the approved triage package below as the scope/);
  assert.match(prompt, /Do not expand scope beyond it/);
  assert.match(prompt, /\{\{TRIAGE_CONTEXT\}\}/);
});

test("Codex output schema requires every declared property", () => {
  const schemaPath = path.join(repoRoot, "prompts", "final-output.schema.json");
  const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8")) as {
    properties: Record<string, unknown>;
    required: string[];
  };
  assert.deepEqual(new Set(schema.required), new Set(Object.keys(schema.properties)));
});

test("task package summary exposes triage and artifact files", () => {
  resetTables();
  const taskDir = fs.mkdtempSync(path.join(os.tmpdir(), "autofix-task-"));
  fs.writeFileSync(path.join(taskDir, "review.md"), "review body");
  const finalJson = {
    status: "blocked",
    target_repo: "acme/api",
    task_dir: taskDir,
    worktree_path: null,
    branch_name: null,
    pr_url: null,
    summary: "Needs human scope confirmation.",
    verification: ["Read issue body"],
    residual_risk: ["Acceptance is unclear"],
    triage: {
      decision: "mid-human-review",
      scores: {
        difficulty: 3,
        workload: 2,
        importance: 4,
        complexity: 3
      },
      summary: "Small change but behavior needs product confirmation."
    },
    development_plan: {
      summary: "Change the API guard after product confirms behavior.",
      steps: ["Confirm behavior", "Patch guard"],
      target_files: ["src/api.ts"],
      verification: ["npm test"],
      risks: ["Behavior may change for existing users"]
    }
  };
  const now = nowIso();
  db.prepare(`
    INSERT INTO issues (source, external_id, kind, repo_owner, repo_name, title, body, status, created_at, updated_at)
    VALUES ('gitea', '1', 'issue', 'acme', 'api', 'Triage me', 'body', 'blocked', ?, ?)
  `).run(now, now);
  const issue = db.prepare("SELECT * FROM issues LIMIT 1").get() as { id: number };
  const result = db.prepare(`
    INSERT INTO repair_jobs (issue_id, status, phase, mode, task_dir, final_json, created_at, updated_at)
    VALUES (?, 'blocked', 'repair_pr', 'reviewed_pr', ?, ?, ?, ?)
  `).run(issue.id, taskDir, JSON.stringify(finalJson), now, now);
  const job = db.prepare("SELECT * FROM repair_jobs WHERE id = ?").get(result.lastInsertRowid) as RepairJobRow;

  const summary = taskPackageSummary(job);

  assert.equal(summary.path, taskDir);
  assert.equal(summary.triage.decision, "mid-human-review");
  assert.equal(summary.triage.difficulty, 3);
  assert.equal(summary.triage.importance, 4);
  assert.equal(summary.developmentPlan.summary, "Change the API guard after product confirms behavior.");
  assert.deepEqual(summary.developmentPlan.steps, ["Confirm behavior", "Patch guard"]);
  assert.equal(summary.files.find((file) => file.name === "review.md")?.exists, true);
  assert.equal(summary.files.find((file) => file.name === "development-plan.md")?.exists, false);
  assert.equal(summary.files.find((file) => file.name === "prompt.md")?.exists, false);
});

test("job detail API includes task package triage summary", async () => {
  resetTables();
  const taskDir = fs.mkdtempSync(path.join(os.tmpdir(), "autofix-job-detail-"));
  const finalJson = {
    status: "triaged",
    target_repo: "acme/api",
    task_dir: taskDir,
    worktree_path: null,
    branch_name: null,
    pr_url: null,
    summary: "Triage complete.",
    verification: [],
    residual_risk: [],
    triage: {
      decision: "mid-human-review",
      scores: {
        difficulty: 2,
        workload: 2,
        importance: 3,
        complexity: 2
      },
      summary: "Needs a short human review."
    },
    development_plan: {
      summary: "Patch the guard.",
      steps: ["Patch"],
      target_files: ["src/api.ts"],
      verification: ["npm test"],
      risks: []
    }
  };
  const now = nowIso();
  db.prepare(`
    INSERT INTO issues (source, external_id, kind, repo_owner, repo_name, title, body, status, created_at, updated_at)
    VALUES ('gitea', '2', 'issue', 'acme', 'api', 'Job detail', 'body', 'triaged', ?, ?)
  `).run(now, now);
  const issue = db.prepare("SELECT * FROM issues LIMIT 1").get() as { id: number };
  const result = db.prepare(`
    INSERT INTO repair_jobs (issue_id, status, phase, mode, task_dir, final_json, created_at, updated_at)
    VALUES (?, 'triaged', 'triage', 'issue_triage', ?, ?, ?, ?)
  `).run(issue.id, taskDir, JSON.stringify(finalJson), now, now);

  const app = Fastify({ logger: false });
  await app.register(jobRoutes);
  try {
    const response = await app.inject({ method: "GET", url: `/api/jobs/${Number(result.lastInsertRowid)}` });
    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body) as { task_package?: { triage?: { decision?: string }; developmentPlan?: { steps?: string[] } } };
    assert.equal(body.task_package?.triage?.decision, "mid-human-review");
    assert.deepEqual(body.task_package?.developmentPlan?.steps, ["Patch"]);
  } finally {
    await app.close();
  }
});
