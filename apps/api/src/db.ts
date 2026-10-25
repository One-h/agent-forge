import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyPersistedRuntimeConfig, config, defaultTeaGiteaConfig, normalizeGiteaBaseUrls, normalizeLarkSenderIds, type PersistedRuntimeConfig } from "./config.js";
import { defaultLarkAcknowledgeReactionEmoji, isLarkReactionEmojiType } from "./larkReactionEmojis.js";
import { nowIso } from "./time.js";
import { preferredEnvironmentValue } from "./environment.js";

function isTestProcess(): boolean {
  return process.env.AGENT_FORGE_TEST_DATABASE === "1"
    || process.env.NODE_TEST_CONTEXT !== undefined
    || process.argv.some((argument) => /(?:^|[/\\])[^/\\]+\.test\.[cm]?[jt]s$/.test(argument));
}

export function assertTestDatabaseIsolation(databasePath: string): void {
  if (!isTestProcess()) return;
  const resolved = path.resolve(databasePath);
  const temporaryRoot = path.resolve(os.tmpdir());
  const configuredTestRoot = process.env.AGENT_FORGE_TEST_ROOT ? path.resolve(process.env.AGENT_FORGE_TEST_ROOT) : "";
  const isolated = process.env.AGENT_FORGE_TEST_DATABASE === "1"
    && configuredTestRoot.startsWith(`${temporaryRoot}${path.sep}`)
    && path.basename(configuredTestRoot).startsWith("agent-forge-api-test-")
    && resolved.startsWith(`${configuredTestRoot}${path.sep}`)
    && path.basename(resolved) === "test.sqlite";
  if (!isolated) {
    throw new Error(`Refusing to open a non-isolated database from a test process: ${resolved}. Run tests through the repository npm test command.`);
  }
}

assertTestDatabaseIsolation(config.databasePath);
fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });

export const db = new Database(config.databasePath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

export type IssueRow = {
  id: number;
  source: string;
  external_id: string;
  kind: "issue" | "pr";
  repo_owner: string;
  repo_name: string;
  title: string;
  body: string | null;
  url: string | null;
  state: string | null;
  assignee: string | null;
  author: string | null;
  reviewers: string;
  labels: string;
  head_sha: string | null;
  severity: string | null;
  status: string;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
};

export type PrReviewRunRow = {
  id: number;
  issue_id: number;
  job_id: number | null;
  repo: string;
  pr_number: string;
  head_sha: string;
  review_key: string;
  status: "pending" | "running" | "succeeded" | "failed" | "cancelled";
  runtime: string | null;
  verdict: "approve" | "comment" | "request_changes" | "unknown";
  posted: number;
  posted_comment_url: string | null;
  task_package_path: string | null;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  posted_at: string | null;
};

export type PrReviewState = {
  review_state: "none" | "running" | "reviewed" | "posted" | "failed" | "stale";
  review_key: string | null;
  review_head_sha: string | null;
  review_status: string | null;
  review_verdict: string | null;
  review_posted: boolean;
  review_task_package_path: string | null;
  review_finished_at: string | null;
  review_stale: boolean;
};

export type RepairJobRow = {
  id: number;
  issue_id: number;
  status: string;
  phase: string;
  mode: string;
  repo_hint: string | null;
  target_repo: string | null;
  branch_name: string | null;
  worktree_path: string | null;
  task_dir: string | null;
  codex_session_id: string | null;
  pr_url: string | null;
  final_json: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
};

export type JobEventRow = {
  id: number;
  job_id: number;
  level: string;
  message: string;
  created_at: string;
};

export type NotificationRow = {
  id: number;
  type: string;
  title: string;
  body: string | null;
  issue_id: number | null;
  dedupe_key: string | null;
  read_at: string | null;
  created_at: string;
};

export type AppSettings = {
  autoReviewNewPulls: boolean;
  deploymentAdapterPath: string;
  issueRepairEnabled: boolean;
  larkMessageListenerEnabled: boolean;
  larkCodexRepliesEnabled: boolean;
  larkExecutionReceiptsEnabled: boolean;
  larkCodexModel: string;
  larkCodexReasoningEffort: "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
  larkStickerUsageMode: "off" | "explicit" | "natural" | "always";
  larkGroupSpontaneousRepliesEnabled: boolean;
  larkGroupSpontaneousReplyRate: number;
  larkGroupSpontaneousReplyCooldownMs: number;
  larkGroupSpontaneousChatIds: string[];
  larkTrustedExecutionEnabled: boolean;
  larkTurnAutoApprovalEnabled: boolean;
  larkTurnAutoApprovalModel: string;
  larkTurnAutoApprovalDataSources: string[];
  larkAcknowledgeReactionEmoji: string;
  larkGroupMessageReactionEnabled: boolean;
  larkGroupMessageReactionEmoji: string;
  larkGroupMessageReactionChatIds: string[];
  larkGroupContextMessageLimit: number;
  larkGroupContextMaxChars: number;
  pollIntervalMs: number;
};

export type LarkSenderReplyProfile = {
  replyTone: string;
};

export type LocalAuditEventRow = {
  id: number;
  action: string;
  summary: string;
  details: string | null;
  created_at: string;
};

export type LocalBackup = {
  schemaVersion: 1;
  exportedAt: string;
  runtimeConfig: PersistedRuntimeConfig;
  appSettings: AppSettings;
  repositories: string[];
  todoWorkflowMetadata: Record<string, unknown>;
  todos: Array<{
    id: number;
    title: string;
    description: string | null;
    status: CodexTodoStatus;
    codexSessionId: string | null;
    createdAt: string;
    updatedAt: string;
  }>;
  auditEvents: Array<{
    action: string;
    summary: string;
    details: string | null;
    createdAt: string;
  }>;
};

export type LarkMessageRow = {
  id: number;
  event_id: string | null;
  message_id: string | null;
  chat_id: string | null;
  chat_type: string | null;
  sender_id: string | null;
  message_type: string | null;
  content: string | null;
  reply_to_message_id: string | null;
  reply_to_message_type: string | null;
  reply_to_content: string | null;
  reply_to_raw_json: string | null;
  mentioned: number;
  reply_trigger: "none" | "p2p" | "mention" | "spontaneous";
  reply_status: string;
  reply_error: string | null;
  reply_delivery_key: string | null;
  reply_delivery_text: string | null;
  reply_delivery_attempts: number;
  reply_next_attempt_at: string | null;
  reply_sent_at: string | null;
  codex_status: "skipped" | "queued" | "running" | "answered" | "no_reply" | "failed" | "timeout";
  codex_reply: string | null;
  codex_error: string | null;
  codex_session_id: string | null;
  codex_turn_id: string | null;
  codex_last_heartbeat_at: string | null;
  codex_runner_generation: string | null;
  codex_task_dir: string | null;
  codex_started_at: string | null;
  codex_finished_at: string | null;
  raw_json: string;
  received_at: string;
  created_at: string;
};

export type LarkCodexSessionRow = {
  session_key: string;
  chat_id: string;
  trust_scope: "trusted" | "untrusted";
  codex_session_id: string;
  created_at: string;
  updated_at: string;
};

export type LarkStickerRow = {
  id: string;
  name: string;
  description: string;
  tags: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  source_url: string | null;
  source_site: string | null;
  content_hash: string | null;
  enabled: number;
  usage_count: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

export type LarkExecutionApprovalRow = {
  id: number;
  token: string;
  lark_message_id: number;
  requester_id: string | null;
  approver_id: string;
  request_method: string;
  server_request_id: string;
  thread_id: string;
  turn_id: string;
  item_id: string;
  operation: string | null;
  cwd: string | null;
  reason: string | null;
  status: "pending" | "approved" | "rejected" | "expired" | "failed";
  approval_scope: "once" | "turn";
  card_message_id: string | null;
  card_error: string | null;
  created_at: string;
  expires_at: string;
  decided_at: string | null;
};

export type LarkContactRow = {
  open_id: string;
  user_id: string | null;
  name: string;
  aliases: string;
  enterprise_email: string | null;
  department: string | null;
  p2p_chat_id: string | null;
  is_activated: number;
  is_cross_tenant: number;
  has_chatted: number;
  source: string;
  created_at: string;
  updated_at: string;
  last_seen_at: string;
};

export type CodexTodoStatus = "todo" | "running" | "blocked" | "review" | "done" | "archived" | "monitoring" | "longterm";

export type CodexTodoRow = {
  id: number;
  title: string;
  description: string | null;
  status: CodexTodoStatus;
  source_type: "manual" | "issue_repair";
  source_id: string | null;
  issue_id: number | null;
  job_id: number | null;
  codex_session_id: string | null;
  codex_task_dir: string | null;
  created_at: string;
  updated_at: string;
};

function columnExists(table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

function tableSql(table: string): string {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql: string } | undefined;
  return row?.sql ?? "";
}

function legacyEnvValues(): Map<string, string> {
  const envPath = path.join(config.repoRoot, ".env");
  if (process.env.DATABASE_PATH || !fs.existsSync(envPath)) {
    return new Map();
  }
  const values = new Map<string, string>();
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    const value = match[2].replace(/^(["'])(.*)\1$/, "$2");
    values.set(match[1], value);
  }
  return values;
}

function importLegacyRuntimeConfig(): void {
  const values = legacyEnvValues();
  const workspaceRoot = preferredEnvironmentValue("FORGE_WORKSPACE_ROOT", "_WORKSPACE_ROOT", Object.fromEntries(values))?.trim();
  if (workspaceRoot && appSettingValue("workspaceRoot") === null) setAppSettingValue("workspaceRoot", workspaceRoot);
  if (appSettingValue("legacyEnvImported") !== "true" && values.size > 0) {
    const mappings: Array<[string, string]> = [
      ["FORGE_WORKSPACE_ROOT", "workspaceRoot"],
      ["GITEA_BASE_URL", "giteaBaseUrl"],
      ["GITEA_USER", "giteaUser"],
      ["LARK_CODEX_APPROVER_OPEN_ID", "larkExecutionApproverId"],
      ["LARK_CODEX_TRUSTED_SENDER_IDS", "trustedLarkCodexSenderIds"]
    ];
    for (const [envKey, settingKey] of mappings) {
      const value = values.get(envKey)?.trim();
      if (value && appSettingValue(settingKey) === null) {
        setAppSettingValue(settingKey, settingKey === "trustedLarkCodexSenderIds" ? JSON.stringify(value.split(",").map((id) => id.trim()).filter(Boolean)) : value);
      }
    }
    const repos = values.get("GITEA_REPOS")?.trim();
    if (repos && appSettingValue("giteaRepos") === null) {
      setAppSettingValue("giteaRepos", JSON.stringify(repos.split(",").map((repo) => repo.trim()).filter(Boolean)));
    }
    setAppSettingValue("legacyEnvImported", "true");
  }
  if (!process.env.DATABASE_PATH && defaultTeaGiteaConfig) {
    if (defaultTeaGiteaConfig.giteaBaseUrl && appSettingValue("giteaBaseUrl") === null) {
      setAppSettingValue("giteaBaseUrl", defaultTeaGiteaConfig.giteaBaseUrl);
    }
    if (defaultTeaGiteaConfig.giteaUser && appSettingValue("giteaUser") === null) {
      setAppSettingValue("giteaUser", defaultTeaGiteaConfig.giteaUser);
    }
  }
  if (
    appSettingValue("legacyEnvImported") === "true"
    && appSettingValue("setupWizardCompleted") === null
    && appSettingValue("workspaceRoot")
  ) {
    setAppSettingValue("setupWizardCompleted", "true");
  }
}

export function migrate(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS issues (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      external_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('issue', 'pr')),
      repo_owner TEXT NOT NULL,
      repo_name TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT,
      url TEXT,
      state TEXT,
      assignee TEXT,
      author TEXT,
      reviewers TEXT NOT NULL DEFAULT '[]',
      labels TEXT NOT NULL DEFAULT '[]',
      head_sha TEXT,
      severity TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      last_synced_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(source, repo_owner, repo_name, kind, external_id)
    );

    CREATE TABLE IF NOT EXISTS repair_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      issue_id INTEGER NOT NULL,
      status TEXT NOT NULL,
      phase TEXT NOT NULL,
      mode TEXT NOT NULL,
      repo_hint TEXT,
      target_repo TEXT,
      branch_name TEXT,
      worktree_path TEXT,
      task_dir TEXT,
      codex_session_id TEXT,
      pr_url TEXT,
      final_json TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      FOREIGN KEY(issue_id) REFERENCES issues(id)
    );

    CREATE TABLE IF NOT EXISTS pr_review_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      issue_id INTEGER NOT NULL,
      job_id INTEGER,
      repo TEXT NOT NULL,
      pr_number TEXT NOT NULL,
      head_sha TEXT NOT NULL,
      review_key TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'cancelled')),
      runtime TEXT,
      verdict TEXT NOT NULL DEFAULT 'unknown' CHECK (verdict IN ('approve', 'comment', 'request_changes', 'unknown')),
      posted INTEGER NOT NULL DEFAULT 0,
      posted_comment_url TEXT,
      task_package_path TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      posted_at TEXT,
      FOREIGN KEY(issue_id) REFERENCES issues(id),
      FOREIGN KEY(job_id) REFERENCES repair_jobs(id)
    );

    CREATE TABLE IF NOT EXISTS job_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL,
      level TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(job_id) REFERENCES repair_jobs(id)
    );

    CREATE TABLE IF NOT EXISTS repo_setup_locks (
      repo_key TEXT PRIMARY KEY,
      job_id INTEGER NOT NULL,
      locked_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT,
      issue_id INTEGER,
      dedupe_key TEXT,
      read_at TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(issue_id) REFERENCES issues(id)
    );

    CREATE TABLE IF NOT EXISTS lark_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT,
      message_id TEXT,
      chat_id TEXT,
      chat_type TEXT,
      sender_id TEXT,
      message_type TEXT,
      content TEXT,
      reply_to_message_id TEXT,
      reply_to_message_type TEXT,
      reply_to_content TEXT,
      reply_to_raw_json TEXT,
      mentioned INTEGER NOT NULL DEFAULT 0,
      reply_trigger TEXT NOT NULL DEFAULT 'none',
      reply_status TEXT NOT NULL DEFAULT 'skipped',
      reply_error TEXT,
      reply_delivery_key TEXT,
      reply_delivery_text TEXT,
      reply_delivery_attempts INTEGER NOT NULL DEFAULT 0,
      reply_next_attempt_at TEXT,
      reply_sent_at TEXT,
      codex_status TEXT NOT NULL DEFAULT 'skipped',
      codex_reply TEXT,
      codex_error TEXT,
      codex_session_id TEXT,
      codex_turn_id TEXT,
      codex_last_heartbeat_at TEXT,
      codex_runner_generation TEXT,
      codex_task_dir TEXT,
      codex_started_at TEXT,
      codex_finished_at TEXT,
      raw_json TEXT NOT NULL,
      received_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS lark_codex_sessions (
      session_key TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      trust_scope TEXT NOT NULL CHECK (trust_scope IN ('trusted', 'untrusted')),
      codex_session_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS lark_group_context_cursors (
      chat_id TEXT NOT NULL,
      trust_scope TEXT NOT NULL CHECK (trust_scope IN ('trusted', 'untrusted')),
      last_message_id INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (chat_id, trust_scope)
    );

    CREATE TABLE IF NOT EXISTS lark_stickers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT '[]',
      file_name TEXT NOT NULL UNIQUE,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      source_url TEXT,
      source_site TEXT,
      content_hash TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      usage_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    );

    CREATE TABLE IF NOT EXISTS lark_sticker_sends (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sticker_id TEXT NOT NULL,
      lark_message_id INTEGER NOT NULL,
      chat_id TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(sticker_id) REFERENCES lark_stickers(id),
      FOREIGN KEY(lark_message_id) REFERENCES lark_messages(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS lark_execution_approvals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token TEXT NOT NULL UNIQUE,
      lark_message_id INTEGER NOT NULL,
      requester_id TEXT,
      approver_id TEXT NOT NULL,
      request_method TEXT NOT NULL,
      server_request_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      operation TEXT,
      cwd TEXT,
      reason TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'failed')),
      approval_scope TEXT NOT NULL DEFAULT 'once' CHECK (approval_scope IN ('once', 'turn')),
      card_message_id TEXT,
      card_error TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      decided_at TEXT,
      FOREIGN KEY(lark_message_id) REFERENCES lark_messages(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS lark_contacts (
      open_id TEXT PRIMARY KEY,
      user_id TEXT,
      name TEXT NOT NULL,
      aliases TEXT NOT NULL DEFAULT '[]',
      enterprise_email TEXT,
      department TEXT,
      p2p_chat_id TEXT,
      is_activated INTEGER NOT NULL DEFAULT 1,
      is_cross_tenant INTEGER NOT NULL DEFAULT 0,
      has_chatted INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'manual',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS lark_contact_aliases (
      alias TEXT NOT NULL,
      open_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(alias, open_id),
      FOREIGN KEY(open_id) REFERENCES lark_contacts(open_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS codex_todos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'running', 'blocked', 'review', 'done', 'archived', 'monitoring', 'longterm')),
      source_type TEXT NOT NULL DEFAULT 'manual' CHECK (source_type IN ('manual', 'issue_repair')),
      source_id TEXT,
      issue_id INTEGER,
      job_id INTEGER,
      codex_session_id TEXT,
      codex_task_dir TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(source_type, source_id),
      FOREIGN KEY(issue_id) REFERENCES issues(id),
      FOREIGN KEY(job_id) REFERENCES repair_jobs(id)
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS local_audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      summary TEXT NOT NULL,
      details TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_issues_status ON issues(status);
    CREATE INDEX IF NOT EXISTS idx_issues_kind_updated_at ON issues(kind, updated_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_jobs_status ON repair_jobs(status);
    CREATE INDEX IF NOT EXISTS idx_jobs_issue_id_id ON repair_jobs(issue_id, id DESC);
    CREATE INDEX IF NOT EXISTS idx_jobs_issue_mode_id ON repair_jobs(issue_id, mode, id DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pr_review_runs_review_key ON pr_review_runs(review_key);
    CREATE INDEX IF NOT EXISTS idx_pr_review_runs_issue_id ON pr_review_runs(issue_id);
    CREATE INDEX IF NOT EXISTS idx_job_events_job_id ON job_events(job_id);
    CREATE INDEX IF NOT EXISTS idx_notifications_read_at ON notifications(read_at);
    CREATE INDEX IF NOT EXISTS idx_lark_messages_received_at ON lark_messages(received_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_lark_messages_event_id ON lark_messages(event_id) WHERE event_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_lark_messages_message_id ON lark_messages(message_id) WHERE message_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_lark_contacts_name ON lark_contacts(name);
    CREATE INDEX IF NOT EXISTS idx_lark_execution_approvals_message ON lark_execution_approvals(lark_message_id, id DESC);
    CREATE INDEX IF NOT EXISTS idx_lark_stickers_enabled ON lark_stickers(enabled, deleted_at, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_lark_sticker_sends_chat ON lark_sticker_sends(chat_id, id DESC);
    CREATE INDEX IF NOT EXISTS idx_lark_execution_approvals_status ON lark_execution_approvals(status, expires_at);
    CREATE INDEX IF NOT EXISTS idx_lark_contacts_user_id ON lark_contacts(user_id);
    CREATE INDEX IF NOT EXISTS idx_lark_contacts_enterprise_email ON lark_contacts(enterprise_email);
    CREATE INDEX IF NOT EXISTS idx_lark_contact_aliases_alias ON lark_contact_aliases(alias);
    CREATE INDEX IF NOT EXISTS idx_codex_todos_status ON codex_todos(status);
    CREATE INDEX IF NOT EXISTS idx_codex_todos_job_id ON codex_todos(job_id);
    CREATE INDEX IF NOT EXISTS idx_codex_todos_issue_id ON codex_todos(issue_id);
    CREATE INDEX IF NOT EXISTS idx_local_audit_events_created_at ON local_audit_events(created_at DESC, id DESC);
  `);

  if (!columnExists("issues", "author")) {
    db.exec("ALTER TABLE issues ADD COLUMN author TEXT");
  }
  if (!columnExists("issues", "reviewers")) {
    db.exec("ALTER TABLE issues ADD COLUMN reviewers TEXT NOT NULL DEFAULT '[]'");
  }
  if (!columnExists("issues", "head_sha")) {
    db.exec("ALTER TABLE issues ADD COLUMN head_sha TEXT");
  }
  if (!columnExists("repair_jobs", "codex_session_id")) {
    db.exec("ALTER TABLE repair_jobs ADD COLUMN codex_session_id TEXT");
  }
  if (!columnExists("notifications", "dedupe_key")) {
    db.exec("ALTER TABLE notifications ADD COLUMN dedupe_key TEXT");
  }
  if (!columnExists("lark_messages", "codex_status")) {
    db.exec("ALTER TABLE lark_messages ADD COLUMN codex_status TEXT NOT NULL DEFAULT 'skipped'");
  }
  if (!columnExists("lark_messages", "reply_trigger")) {
    db.exec("ALTER TABLE lark_messages ADD COLUMN reply_trigger TEXT NOT NULL DEFAULT 'none'");
    db.exec(`
      UPDATE lark_messages
      SET reply_trigger = CASE
        WHEN chat_type = 'p2p' AND mentioned = 1 THEN 'p2p'
        WHEN mentioned = 1 THEN 'mention'
        ELSE 'none'
      END
    `);
  }
  if (!columnExists("lark_messages", "reply_to_message_id")) {
    db.exec("ALTER TABLE lark_messages ADD COLUMN reply_to_message_id TEXT");
  }
  if (!columnExists("lark_messages", "reply_to_message_type")) {
    db.exec("ALTER TABLE lark_messages ADD COLUMN reply_to_message_type TEXT");
  }
  if (!columnExists("lark_messages", "reply_to_content")) {
    db.exec("ALTER TABLE lark_messages ADD COLUMN reply_to_content TEXT");
  }
  if (!columnExists("lark_messages", "reply_to_raw_json")) {
    db.exec("ALTER TABLE lark_messages ADD COLUMN reply_to_raw_json TEXT");
  }
  if (!columnExists("lark_messages", "codex_reply")) {
    db.exec("ALTER TABLE lark_messages ADD COLUMN codex_reply TEXT");
  }
  if (!columnExists("lark_messages", "codex_error")) {
    db.exec("ALTER TABLE lark_messages ADD COLUMN codex_error TEXT");
  }
  if (!columnExists("lark_messages", "codex_session_id")) {
    db.exec("ALTER TABLE lark_messages ADD COLUMN codex_session_id TEXT");
  }
  if (!columnExists("lark_messages", "codex_turn_id")) {
    db.exec("ALTER TABLE lark_messages ADD COLUMN codex_turn_id TEXT");
  }
  if (!columnExists("lark_messages", "codex_last_heartbeat_at")) {
    db.exec("ALTER TABLE lark_messages ADD COLUMN codex_last_heartbeat_at TEXT");
  }
  if (!columnExists("lark_messages", "codex_runner_generation")) {
    db.exec("ALTER TABLE lark_messages ADD COLUMN codex_runner_generation TEXT");
  }
  if (!columnExists("lark_messages", "codex_task_dir")) {
    db.exec("ALTER TABLE lark_messages ADD COLUMN codex_task_dir TEXT");
  }
  if (!columnExists("lark_messages", "codex_started_at")) {
    db.exec("ALTER TABLE lark_messages ADD COLUMN codex_started_at TEXT");
  }
  if (!columnExists("lark_messages", "codex_finished_at")) {
    db.exec("ALTER TABLE lark_messages ADD COLUMN codex_finished_at TEXT");
  }
  if (!columnExists("lark_messages", "reply_delivery_key")) {
    db.exec("ALTER TABLE lark_messages ADD COLUMN reply_delivery_key TEXT");
  }
  if (!columnExists("lark_messages", "reply_delivery_text")) {
    db.exec("ALTER TABLE lark_messages ADD COLUMN reply_delivery_text TEXT");
  }
  if (!columnExists("lark_messages", "reply_delivery_attempts")) {
    db.exec("ALTER TABLE lark_messages ADD COLUMN reply_delivery_attempts INTEGER NOT NULL DEFAULT 0");
  }
  if (!columnExists("lark_messages", "reply_next_attempt_at")) {
    db.exec("ALTER TABLE lark_messages ADD COLUMN reply_next_attempt_at TEXT");
  }
  if (!columnExists("lark_messages", "reply_sent_at")) {
    db.exec("ALTER TABLE lark_messages ADD COLUMN reply_sent_at TEXT");
  }
  if (!columnExists("lark_stickers", "source_url")) {
    db.exec("ALTER TABLE lark_stickers ADD COLUMN source_url TEXT");
  }
  if (!columnExists("lark_stickers", "source_site")) {
    db.exec("ALTER TABLE lark_stickers ADD COLUMN source_site TEXT");
  }
  if (!columnExists("lark_stickers", "content_hash")) {
    db.exec("ALTER TABLE lark_stickers ADD COLUMN content_hash TEXT");
  }
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_lark_stickers_content_hash ON lark_stickers(content_hash) WHERE content_hash IS NOT NULL");
  if (!columnExists("lark_execution_approvals", "card_message_id")) {
    db.exec("ALTER TABLE lark_execution_approvals ADD COLUMN card_message_id TEXT");
  }
  if (!columnExists("lark_execution_approvals", "approval_scope")) {
    db.exec("ALTER TABLE lark_execution_approvals ADD COLUMN approval_scope TEXT NOT NULL DEFAULT 'once' CHECK (approval_scope IN ('once', 'turn'))");
  }
  if (!columnExists("lark_codex_sessions", "session_key")) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS lark_codex_sessions_v2 (
        session_key TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        trust_scope TEXT NOT NULL CHECK (trust_scope IN ('trusted', 'untrusted')),
        codex_session_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT OR IGNORE INTO lark_codex_sessions_v2 (session_key, chat_id, trust_scope, codex_session_id, created_at, updated_at)
      SELECT chat_id || '::trusted', chat_id, 'trusted', codex_session_id, created_at, updated_at
      FROM lark_codex_sessions
      WHERE chat_id IS NOT NULL;
      DROP TABLE lark_codex_sessions;
      ALTER TABLE lark_codex_sessions_v2 RENAME TO lark_codex_sessions;
    `);
  }
  if (!tableSql("codex_todos").includes("'monitoring'")) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS codex_todos_v2 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'running', 'blocked', 'review', 'done', 'archived', 'monitoring', 'longterm')),
        source_type TEXT NOT NULL DEFAULT 'manual' CHECK (source_type IN ('manual', 'issue_repair')),
        source_id TEXT,
        issue_id INTEGER,
        job_id INTEGER,
        codex_session_id TEXT,
        codex_task_dir TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(source_type, source_id),
        FOREIGN KEY(issue_id) REFERENCES issues(id),
        FOREIGN KEY(job_id) REFERENCES repair_jobs(id)
      );
      INSERT OR IGNORE INTO codex_todos_v2 (
        id, title, description, status, source_type, source_id, issue_id, job_id,
        codex_session_id, codex_task_dir, created_at, updated_at
      )
      SELECT
        id, title, description, status, source_type, source_id, issue_id, job_id,
        codex_session_id, codex_task_dir, created_at, updated_at
      FROM codex_todos;
      DROP TABLE codex_todos;
      ALTER TABLE codex_todos_v2 RENAME TO codex_todos;
    `);
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_lark_codex_sessions_chat_scope ON lark_codex_sessions(chat_id, trust_scope)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_issues_kind_updated_at ON issues(kind, updated_at DESC, id DESC)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_issue_id_id ON repair_jobs(issue_id, id DESC)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_issue_mode_id ON repair_jobs(issue_id, mode, id DESC)");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_dedupe_key ON notifications(dedupe_key) WHERE dedupe_key IS NOT NULL");
  db.exec("CREATE INDEX IF NOT EXISTS idx_lark_contacts_name ON lark_contacts(name)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_lark_messages_reply_delivery ON lark_messages(reply_status, reply_next_attempt_at, id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_lark_messages_codex_heartbeat ON lark_messages(codex_status, codex_last_heartbeat_at, id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_lark_execution_approvals_message ON lark_execution_approvals(lark_message_id, id DESC)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_lark_execution_approvals_status ON lark_execution_approvals(status, expires_at)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_lark_contacts_user_id ON lark_contacts(user_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_lark_contacts_enterprise_email ON lark_contacts(enterprise_email)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_lark_contact_aliases_alias ON lark_contact_aliases(alias)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_codex_todos_status ON codex_todos(status)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_codex_todos_job_id ON codex_todos(job_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_codex_todos_issue_id ON codex_todos(issue_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_local_audit_events_created_at ON local_audit_events(created_at DESC, id DESC)");
  importLegacyRuntimeConfig();
}

export function addLocalAuditEvent(action: string, summary: string, details?: Record<string, unknown>): void {
  db.prepare("INSERT INTO local_audit_events (action, summary, details, created_at) VALUES (?, ?, ?, ?)")
    .run(action, summary, details ? JSON.stringify(details) : null, nowIso());
}

export function listLocalAuditEvents(limit = 30): LocalAuditEventRow[] {
  return db.prepare("SELECT * FROM local_audit_events ORDER BY id DESC LIMIT ?").all(limit) as LocalAuditEventRow[];
}

export function getAppSettings(): AppSettings {
  const rows = db.prepare("SELECT key, value FROM app_settings").all() as Array<{ key: string; value: string }>;
  const values = new Map(rows.map((row) => [row.key, row.value]));
  const storedPollIntervalMs = Number(values.get("pollIntervalMs"));
  const storedLarkGroupContextMessageLimit = Number(values.get("larkGroupContextMessageLimit"));
  const storedLarkGroupContextMaxChars = Number(values.get("larkGroupContextMaxChars"));
  const storedSpontaneousCooldownMs = Number(values.get("larkGroupSpontaneousReplyCooldownMs") ?? config.larkGroupSpontaneousReplyCooldownMs);
  const storedReactionEmoji = values.get("larkAcknowledgeReactionEmoji") ?? defaultLarkAcknowledgeReactionEmoji;
  const storedGroupReactionEmoji = values.get("larkGroupMessageReactionEmoji") ?? defaultLarkAcknowledgeReactionEmoji;
  return {
    autoReviewNewPulls: values.get("autoReviewNewPulls") === "true",
    deploymentAdapterPath: values.get("deploymentAdapterPath")?.trim() ?? "",
    issueRepairEnabled: values.get("issueRepairEnabled") !== "false",
    larkMessageListenerEnabled: values.get("larkMessageListenerEnabled") === "true",
    larkCodexRepliesEnabled: values.get("larkCodexRepliesEnabled") === "true",
    larkExecutionReceiptsEnabled: values.get("larkExecutionReceiptsEnabled") !== "false",
    larkCodexModel: values.get("larkCodexModel")?.trim() || config.larkCodexModel,
    larkCodexReasoningEffort: ["low", "medium", "high", "xhigh", "max", "ultra"].includes(values.get("larkCodexReasoningEffort") ?? config.larkCodexReasoningEffort)
      ? (values.get("larkCodexReasoningEffort") ?? config.larkCodexReasoningEffort) as AppSettings["larkCodexReasoningEffort"]
      : "low",
    larkStickerUsageMode: ["off", "explicit", "natural", "always"].includes(values.get("larkStickerUsageMode") ?? "")
      ? values.get("larkStickerUsageMode") as AppSettings["larkStickerUsageMode"]
      : "natural",
    larkGroupSpontaneousRepliesEnabled: values.get("larkGroupSpontaneousRepliesEnabled") === "true",
    larkGroupSpontaneousReplyRate: Number(values.get("larkGroupSpontaneousReplyRate") ?? config.larkGroupSpontaneousReplyRate),
    larkGroupSpontaneousReplyCooldownMs: Number.isInteger(storedSpontaneousCooldownMs) && storedSpontaneousCooldownMs >= 0 && storedSpontaneousCooldownMs <= 604_800_000 ? storedSpontaneousCooldownMs : 600_000,
    larkGroupSpontaneousChatIds: parseGroupChatIds(values.get("larkGroupSpontaneousChatIds")),
    larkTrustedExecutionEnabled: values.get("larkTrustedExecutionEnabled") === "true",
    larkTurnAutoApprovalEnabled: values.get("larkTurnAutoApprovalEnabled") === "true",
    larkTurnAutoApprovalModel: values.get("larkTurnAutoApprovalModel")?.trim() || "gpt-6.1-sol",
    larkTurnAutoApprovalDataSources: parseApprovalDataSources(values.get("larkTurnAutoApprovalDataSources")),
    larkAcknowledgeReactionEmoji: isLarkReactionEmojiType(storedReactionEmoji) ? storedReactionEmoji : defaultLarkAcknowledgeReactionEmoji,
    larkGroupMessageReactionEnabled: values.get("larkGroupMessageReactionEnabled") === "true",
    larkGroupMessageReactionEmoji: isLarkReactionEmojiType(storedGroupReactionEmoji) ? storedGroupReactionEmoji : defaultLarkAcknowledgeReactionEmoji,
    larkGroupMessageReactionChatIds: parseGroupChatIds(values.get("larkGroupMessageReactionChatIds")),
    larkGroupContextMessageLimit: Number.isInteger(storedLarkGroupContextMessageLimit) && storedLarkGroupContextMessageLimit >= 1 && storedLarkGroupContextMessageLimit <= 200
      ? storedLarkGroupContextMessageLimit
      : config.larkRecentMessageFetchLimit,
    larkGroupContextMaxChars: Number.isInteger(storedLarkGroupContextMaxChars) && storedLarkGroupContextMaxChars >= 500 && storedLarkGroupContextMaxChars <= 30_000
      ? storedLarkGroupContextMaxChars
      : config.larkRecentMessageContextMaxChars,
    pollIntervalMs: Number.isFinite(storedPollIntervalMs) && storedPollIntervalMs >= 60000 ? storedPollIntervalMs : config.pollIntervalMs
  };
}

function parseApprovalDataSources(raw: string | undefined): string[] {
  try {
    const values: unknown = JSON.parse(raw ?? "[]");
    return Array.isArray(values) && values.length <= 100
      && values.every(value => typeof value === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(value))
      ? [...new Set(values.map(value => value.toLowerCase()))] : [];
  } catch { return []; }
}

function parseGroupChatIds(raw: string | undefined): string[] {
  try {
    const value: unknown = JSON.parse(raw ?? "[]");
    return Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === "string" && /^oc_[A-Za-z0-9]+$/.test(id)))] : [];
  } catch {
    return [];
  }
}

export function updateAppSettings(patch: Partial<AppSettings>): AppSettings {
  const updatedAt = nowIso();
  const write = db.prepare(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);
  if (patch.autoReviewNewPulls !== undefined) {
    write.run("autoReviewNewPulls", patch.autoReviewNewPulls ? "true" : "false", updatedAt);
  }
  if (patch.deploymentAdapterPath !== undefined) write.run("deploymentAdapterPath", patch.deploymentAdapterPath, updatedAt);
  if (patch.issueRepairEnabled !== undefined) {
    write.run("issueRepairEnabled", patch.issueRepairEnabled ? "true" : "false", updatedAt);
  }
  if (patch.larkMessageListenerEnabled !== undefined) {
    write.run("larkMessageListenerEnabled", patch.larkMessageListenerEnabled ? "true" : "false", updatedAt);
  }
  if (patch.larkCodexRepliesEnabled !== undefined) {
    write.run("larkCodexRepliesEnabled", patch.larkCodexRepliesEnabled ? "true" : "false", updatedAt);
  }
  if (patch.larkExecutionReceiptsEnabled !== undefined) {
    write.run("larkExecutionReceiptsEnabled", patch.larkExecutionReceiptsEnabled ? "true" : "false", updatedAt);
  }
  if (patch.larkCodexModel !== undefined) {
    write.run("larkCodexModel", patch.larkCodexModel, updatedAt);
  }
  if (patch.larkCodexReasoningEffort !== undefined) {
    write.run("larkCodexReasoningEffort", patch.larkCodexReasoningEffort, updatedAt);
  }
  if (patch.larkStickerUsageMode !== undefined) {
    write.run("larkStickerUsageMode", patch.larkStickerUsageMode, updatedAt);
  }
  if (patch.larkGroupSpontaneousRepliesEnabled !== undefined) {
    write.run("larkGroupSpontaneousRepliesEnabled", patch.larkGroupSpontaneousRepliesEnabled ? "true" : "false", updatedAt);
  }
  if (patch.larkGroupSpontaneousReplyRate !== undefined) {
    write.run("larkGroupSpontaneousReplyRate", String(patch.larkGroupSpontaneousReplyRate), updatedAt);
  }
  if (patch.larkGroupSpontaneousReplyCooldownMs !== undefined) {
    write.run("larkGroupSpontaneousReplyCooldownMs", String(patch.larkGroupSpontaneousReplyCooldownMs), updatedAt);
  }
  if (patch.larkGroupSpontaneousChatIds !== undefined) {
    write.run("larkGroupSpontaneousChatIds", JSON.stringify(patch.larkGroupSpontaneousChatIds), updatedAt);
  }
  if (patch.larkTrustedExecutionEnabled !== undefined) {
    write.run("larkTrustedExecutionEnabled", patch.larkTrustedExecutionEnabled ? "true" : "false", updatedAt);
  }
  if (patch.larkTurnAutoApprovalEnabled !== undefined) {
    write.run("larkTurnAutoApprovalEnabled", patch.larkTurnAutoApprovalEnabled ? "true" : "false", updatedAt);
  }
  if (patch.larkTurnAutoApprovalModel !== undefined) {
    write.run("larkTurnAutoApprovalModel", patch.larkTurnAutoApprovalModel, updatedAt);
  }
  if (patch.larkTurnAutoApprovalDataSources !== undefined) {
    write.run("larkTurnAutoApprovalDataSources", JSON.stringify(patch.larkTurnAutoApprovalDataSources), updatedAt);
  }
  if (patch.larkAcknowledgeReactionEmoji !== undefined) {
    write.run("larkAcknowledgeReactionEmoji", patch.larkAcknowledgeReactionEmoji, updatedAt);
  }
  if (patch.larkGroupMessageReactionEnabled !== undefined) {
    write.run("larkGroupMessageReactionEnabled", patch.larkGroupMessageReactionEnabled ? "true" : "false", updatedAt);
  }
  if (patch.larkGroupMessageReactionEmoji !== undefined) {
    write.run("larkGroupMessageReactionEmoji", patch.larkGroupMessageReactionEmoji, updatedAt);
  }
  if (patch.larkGroupMessageReactionChatIds !== undefined) {
    write.run("larkGroupMessageReactionChatIds", JSON.stringify(patch.larkGroupMessageReactionChatIds), updatedAt);
  }
  if (patch.larkGroupContextMessageLimit !== undefined) {
    write.run("larkGroupContextMessageLimit", String(patch.larkGroupContextMessageLimit), updatedAt);
  }
  if (patch.larkGroupContextMaxChars !== undefined) {
    write.run("larkGroupContextMaxChars", String(patch.larkGroupContextMaxChars), updatedAt);
  }
  if (patch.pollIntervalMs !== undefined) {
    write.run("pollIntervalMs", String(patch.pollIntervalMs), updatedAt);
  }
  return getAppSettings();
}

export function appSettingValue(key: string): string | null {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setAppSettingValue(key: string, value: string): void {
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, value, nowIso());
}

export function larkSenderReplyProfile(senderId: string | null): LarkSenderReplyProfile | null {
  if (!senderId) return null;
  const stored = appSettingValue("larkSenderReplyProfiles");
  if (!stored) return null;
  try {
    const profiles = JSON.parse(stored) as Record<string, unknown>;
    const profile = profiles[senderId];
    if (!profile || typeof profile !== "object" || Array.isArray(profile)) return null;
    const replyTone = (profile as { replyTone?: unknown }).replyTone;
    return typeof replyTone === "string" && replyTone.trim().length > 0
      ? { replyTone: replyTone.trim().slice(0, 300) }
      : null;
  } catch {
    return null;
  }
}

function storedString(key: string, fallback: string): string {
  return appSettingValue(key) ?? fallback;
}

function storedTrustedLarkSenderIds(): string[] {
  const stored = appSettingValue("trustedLarkCodexSenderIds");
  if (!stored) return config.trustedLarkCodexSenderIds;
  try {
    const parsed = JSON.parse(stored) as unknown;
    return Array.isArray(parsed)
      ? normalizeLarkSenderIds(parsed.filter((value): value is string => typeof value === "string"))
      : config.trustedLarkCodexSenderIds;
  } catch {
    return config.trustedLarkCodexSenderIds;
  }
}

function storedGiteaBaseUrls(): string[] {
  const stored = appSettingValue("giteaBaseUrls");
  if (stored) {
    try {
      const parsed = JSON.parse(stored) as unknown;
      if (Array.isArray(parsed)) {
        const urls = normalizeGiteaBaseUrls(parsed.filter((value): value is string => typeof value === "string"));
        if (urls.length > 0) return urls;
      }
    } catch {
      // Fall back to the legacy single-address setting below.
    }
  }
  const legacyBaseUrl = appSettingValue("giteaBaseUrl");
  return normalizeGiteaBaseUrls(legacyBaseUrl !== null ? [legacyBaseUrl] : config.giteaBaseUrls);
}

export function persistedRuntimeConfig(): PersistedRuntimeConfig {
  const giteaBaseUrls = storedGiteaBaseUrls();
  return {
    workspaceRoot: storedString("workspaceRoot", config.workspaceRoot),
    giteaBaseUrl: giteaBaseUrls[0] ?? "",
    giteaBaseUrls,
    giteaUser: storedString("giteaUser", config.giteaUser),
    larkExecutionApproverId: storedString("larkExecutionApproverId", config.larkExecutionApproverId),
    trustedLarkCodexSenderIds: storedTrustedLarkSenderIds()
  };
}

export function hydrateRuntimeConfig(): PersistedRuntimeConfig {
  const runtimeConfig = persistedRuntimeConfig();
  applyPersistedRuntimeConfig(runtimeConfig);
  return runtimeConfig;
}

export function updatePersistedRuntimeConfig(next: PersistedRuntimeConfig): PersistedRuntimeConfig {
  const trustedLarkCodexSenderIds = normalizeLarkSenderIds(next.trustedLarkCodexSenderIds);
  const giteaBaseUrls = normalizeGiteaBaseUrls(next.giteaBaseUrls?.length ? next.giteaBaseUrls : [next.giteaBaseUrl]);
  setAppSettingValue("workspaceRoot", next.workspaceRoot);
  setAppSettingValue("giteaBaseUrl", giteaBaseUrls[0] ?? "");
  setAppSettingValue("giteaBaseUrls", JSON.stringify(giteaBaseUrls));
  setAppSettingValue("giteaUser", next.giteaUser);
  setAppSettingValue("larkExecutionApproverId", next.larkExecutionApproverId.trim());
  setAppSettingValue("trustedLarkCodexSenderIds", JSON.stringify(trustedLarkCodexSenderIds));
  return hydrateRuntimeConfig();
}

function storedRepositories(): string[] {
  const stored = appSettingValue("giteaRepos");
  if (!stored) return config.giteaRepos.map((repo) => `${repo.owner}/${repo.name}`);
  try {
    const parsed = JSON.parse(stored) as unknown;
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string" && /^[^/\\\s]+\/[^/\\\s]+$/.test(value)) : [];
  } catch {
    return [];
  }
}

function storedTodoWorkflowMetadata(): Record<string, unknown> {
  try {
    const parsed = JSON.parse(appSettingValue("todoWorkflowMetadataV1") ?? "{}") as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function createLocalBackup(): LocalBackup {
  const todos = db.prepare(`
    SELECT id, title, description, status, codex_session_id, created_at, updated_at
    FROM codex_todos
    ORDER BY id
  `).all() as Array<{
    id: number;
    title: string;
    description: string | null;
    status: CodexTodoStatus;
    codex_session_id: string | null;
    created_at: string;
    updated_at: string;
  }>;
  const auditEvents = db.prepare("SELECT action, summary, details, created_at FROM local_audit_events ORDER BY id").all() as Array<{
    action: string;
    summary: string;
    details: string | null;
    created_at: string;
  }>;
  return {
    schemaVersion: 1,
    exportedAt: nowIso(),
    runtimeConfig: persistedRuntimeConfig(),
    appSettings: getAppSettings(),
    repositories: storedRepositories(),
    todoWorkflowMetadata: storedTodoWorkflowMetadata(),
    todos: todos.map((todo) => ({
      id: todo.id,
      title: todo.title,
      description: todo.description,
      status: todo.status,
      codexSessionId: todo.codex_session_id,
      createdAt: todo.created_at,
      updatedAt: todo.updated_at
    })),
    auditEvents: auditEvents.map((event) => ({
      action: event.action,
      summary: event.summary,
      details: event.details,
      createdAt: event.created_at
    }))
  };
}

export function restoreLocalBackup(backup: LocalBackup): { todos: number; auditEvents: number } {
  const restore = db.transaction(() => {
    updatePersistedRuntimeConfig(backup.runtimeConfig);
    updateAppSettings(backup.appSettings);
    setAppSettingValue("giteaRepos", JSON.stringify([...new Set(backup.repositories)].sort()));

    db.exec("DELETE FROM codex_todos");
    const insertTodo = db.prepare(`
      INSERT INTO codex_todos (
        id, title, description, status, source_type, source_id, issue_id, job_id,
        codex_session_id, codex_task_dir, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'manual', NULL, NULL, NULL, ?, NULL, ?, ?)
    `);
    for (const todo of backup.todos) {
      insertTodo.run(todo.id ?? null, todo.title, todo.description, todo.status, todo.codexSessionId, todo.createdAt, todo.updatedAt);
    }
    setAppSettingValue("todoWorkflowMetadataV1", JSON.stringify(backup.todoWorkflowMetadata ?? {}));

    db.exec("DELETE FROM local_audit_events");
    const insertAudit = db.prepare("INSERT INTO local_audit_events (action, summary, details, created_at) VALUES (?, ?, ?, ?)");
    for (const event of backup.auditEvents) {
      insertAudit.run(event.action, event.summary, event.details, event.createdAt);
    }
    hydrateRuntimeConfig();
    return { todos: backup.todos.length, auditEvents: backup.auditEvents.length };
  });
  return restore();
}

export function prReviewKey(issue: Pick<IssueRow, "repo_owner" | "repo_name" | "external_id" | "head_sha">): string | null {
  if (!issue.head_sha) {
    return null;
  }
  return `${issue.repo_owner}/${issue.repo_name}#pr-${issue.external_id}@${issue.head_sha}`;
}

export function prReviewStateFromRuns(
  issue: Pick<IssueRow, "id" | "repo_owner" | "repo_name" | "external_id" | "head_sha">,
  runs: PrReviewRunRow[]
): PrReviewState {
  const statusRank = (status: PrReviewRunRow["status"]): number => {
    if (status === "running") return 0;
    if (status === "pending") return 1;
    if (status === "succeeded") return 2;
    if (status === "failed") return 3;
    return 4;
  };
  const run = [...runs].sort((left, right) => {
    const headRank = Number(left.head_sha !== (issue.head_sha ?? "")) - Number(right.head_sha !== (issue.head_sha ?? ""));
    if (headRank !== 0) return headRank;
    const stateRank = statusRank(left.status) - statusRank(right.status);
    if (stateRank !== 0) return stateRank;
    const leftTime = left.finished_at ?? left.started_at ?? left.created_at;
    const rightTime = right.finished_at ?? right.started_at ?? right.created_at;
    return rightTime.localeCompare(leftTime) || right.id - left.id;
  })[0];

  if (!run) {
    return {
      review_state: "none",
      review_key: prReviewKey(issue),
      review_head_sha: null,
      review_status: null,
      review_verdict: null,
      review_posted: false,
      review_task_package_path: null,
      review_finished_at: null,
      review_stale: false
    };
  }

  const stale = Boolean(issue.head_sha && run.head_sha !== issue.head_sha);
  let reviewState: PrReviewState["review_state"] = "reviewed";
  if (stale) {
    reviewState = "stale";
  } else if (run.status === "pending" || run.status === "running") {
    reviewState = "running";
  } else if (run.status === "failed" || run.status === "cancelled") {
    reviewState = "failed";
  } else if (run.posted) {
    reviewState = "posted";
  }

  return {
    review_state: reviewState,
    review_key: run.review_key,
    review_head_sha: run.head_sha,
    review_status: run.status,
    review_verdict: run.verdict,
    review_posted: Boolean(run.posted),
    review_task_package_path: run.task_package_path,
    review_finished_at: run.finished_at,
    review_stale: stale
  };
}

export function prReviewState(issue: Pick<IssueRow, "id" | "repo_owner" | "repo_name" | "external_id" | "head_sha">): PrReviewState {
  const runs = db.prepare("SELECT * FROM pr_review_runs WHERE issue_id = ?").all(issue.id) as PrReviewRunRow[];
  return prReviewStateFromRuns(issue, runs);
}

export function updatePrReviewRunForJob(
  jobId: number,
  patch: {
    status?: PrReviewRunRow["status"];
    verdict?: PrReviewRunRow["verdict"];
    posted?: boolean;
    postedCommentUrl?: string | null;
    taskPackagePath?: string | null;
    errorMessage?: string | null;
    startedAt?: string | null;
    finishedAt?: string | null;
    postedAt?: string | null;
  }
): void {
  const assignments: string[] = [];
  const values: unknown[] = [];
  if (patch.status !== undefined) {
    assignments.push("status = ?");
    values.push(patch.status);
  }
  if (patch.verdict !== undefined) {
    assignments.push("verdict = ?");
    values.push(patch.verdict);
  }
  if (patch.posted !== undefined) {
    assignments.push("posted = ?");
    values.push(patch.posted ? 1 : 0);
  }
  if (patch.postedCommentUrl !== undefined) {
    assignments.push("posted_comment_url = ?");
    values.push(patch.postedCommentUrl);
  }
  if (patch.taskPackagePath !== undefined) {
    assignments.push("task_package_path = ?");
    values.push(patch.taskPackagePath);
  }
  if (patch.errorMessage !== undefined) {
    assignments.push("error_message = ?");
    values.push(patch.errorMessage);
  }
  if (patch.startedAt !== undefined) {
    assignments.push("started_at = ?");
    values.push(patch.startedAt);
  }
  if (patch.finishedAt !== undefined) {
    assignments.push("finished_at = ?");
    values.push(patch.finishedAt);
  }
  if (patch.postedAt !== undefined) {
    assignments.push("posted_at = ?");
    values.push(patch.postedAt);
  }
  if (assignments.length === 0) {
    return;
  }
  values.push(jobId);
  db.prepare(`UPDATE pr_review_runs SET ${assignments.join(", ")} WHERE job_id = ?`).run(...values);
}

export function addJobEvent(jobId: number, level: string, message: string): void {
  db.prepare("INSERT INTO job_events (job_id, level, message, created_at) VALUES (?, ?, ?, ?)").run(
    jobId,
    level,
    message,
    nowIso()
  );
}

export function cleanupExpiredRepoSetupLocks(at = nowIso()): void {
  db.prepare("DELETE FROM repo_setup_locks WHERE expires_at < ?").run(at);
}

export function acquireRepoSetupLock(repoKey: string, jobId: number, ttlMs: number): boolean {
  cleanupExpiredRepoSetupLocks();
  const lockedAt = new Date();
  const expiresAt = new Date(lockedAt.getTime() + ttlMs);
  try {
    db.prepare("INSERT INTO repo_setup_locks (repo_key, job_id, locked_at, expires_at) VALUES (?, ?, ?, ?)").run(
      repoKey,
      jobId,
      lockedAt.toISOString(),
      expiresAt.toISOString()
    );
    return true;
  } catch (error) {
    if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
      return false;
    }
    throw error;
  }
}

export function releaseRepoSetupLock(repoKey: string, jobId: number): void {
  db.prepare("DELETE FROM repo_setup_locks WHERE repo_key = ? AND job_id = ?").run(repoKey, jobId);
}

export function addNotification(type: string, title: string, body: string | null, issueId: number | null, dedupeKey?: string | null): void {
  db.prepare("INSERT OR IGNORE INTO notifications (type, title, body, issue_id, dedupe_key, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    type,
    title,
    body,
    issueId,
    dedupeKey ?? null,
    nowIso()
  );
}
