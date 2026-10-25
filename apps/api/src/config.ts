import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readGiteaTokenFromKeychain } from "./credentialStore.js";
import { preferredEnvironmentValue } from "./environment.js";

const apiDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(apiDir, "..", "..", "..");

function resolveFromRepoRoot(value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(repoRoot, value);
}

type TeaLogin = {
  url: string;
  token: string;
  user: string;
};

function loadDefaultTeaLogin(): TeaLogin | null {
  const configPath = path.join(os.homedir(), "Library", "Application Support", "tea", "config.yml");
  if (!fs.existsSync(configPath)) {
    return null;
  }

  const text = fs.readFileSync(configPath, "utf8");
  const blocks = text.split(/\n(?=\s*- name: )/g).filter((block) => block.includes("- name: "));
  const selected = blocks.find((block) => /^\s*default:\s*true\s*$/m.test(block)) ?? blocks[0];
  if (!selected) {
    return null;
  }

  const value = (key: string) => selected.match(new RegExp(`^\\s*${key}:\\s*(.*)$`, "m"))?.[1]?.trim().replace(/^"|"$/g, "") ?? "";
  const url = value("url");
  const token = value("token");
  const user = value("user");
  if (!url || !token) {
    return null;
  }
  return { url, token, user };
}

const teaLogin = loadDefaultTeaLogin();
const keychainGiteaToken = readGiteaTokenFromKeychain();

export const defaultTeaGiteaConfig = teaLogin ? {
  giteaBaseUrl: teaLogin.url.replace(/\/$/, ""),
  giteaUser: teaLogin.user
} : null;

const repoList = (process.env.GITEA_REPOS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean)
  .map((value) => {
    const [owner, name] = value.split("/");
    if (!owner || !name) {
      throw new Error(`Invalid GITEA_REPOS entry: ${value}`);
    }
    return { owner, name };
  });

export function normalizeLarkSenderIds(values: string[]): string[] {
  return [...new Set(values
    .flatMap((value) => value.split(/[,，;；\r\n]+/))
    .map((value) => value.trim())
    .filter(Boolean))];
}

export function normalizeGiteaBaseUrls(values: string[]): string[] {
  return [...new Set(values
    .flatMap((value) => value.split(/[,，;；\r\n]+/))
    .map((value) => value.trim().replace(/\/+$/, ""))
    .filter(Boolean))];
}

const configuredGiteaBaseUrls = normalizeGiteaBaseUrls([
  process.env.GITEA_BASE_URLS ?? process.env.GITEA_BASE_URL ?? ""
]);

const trustedLarkCodexSenderIds = normalizeLarkSenderIds([
  process.env.LARK_CODEX_TRUSTED_SENDER_IDS ?? ""
]);

const larkExecutionApproverId = (process.env.LARK_CODEX_APPROVER_OPEN_ID ?? "").trim();

export const config = {
  port: Number(process.env.PORT ?? 4731),
  webPort: Number(process.env.WEB_PORT ?? 4732),
  companionPort: Number(process.env.AUTOFIX_COMPANION_PORT ?? 4734),
  host: process.env.HOST ?? "127.0.0.1",
  repoRoot,
  databasePath: resolveFromRepoRoot(process.env.DATABASE_PATH ?? "./apps/api/data/autofix.sqlite"),
  taskOutputDir: resolveFromRepoRoot(process.env.AUTOFIX_TASK_DIR ?? "./data/tasks"),
  larkStickerDirectory: resolveFromRepoRoot(process.env.LARK_STICKER_DIR ?? "./data/lark-stickers"),
  workspaceRoot: preferredEnvironmentValue("FORGE_WORKSPACE_ROOT", "_WORKSPACE_ROOT") ?? "",
  giteaBaseUrl: configuredGiteaBaseUrls[0] ?? "",
  giteaBaseUrls: configuredGiteaBaseUrls,
  giteaToken: keychainGiteaToken || process.env.GITEA_TOKEN || teaLogin?.token || "",
  giteaTokenSource: keychainGiteaToken ? "keychain" : process.env.GITEA_TOKEN ? "env" : teaLogin?.token ? "tea" : "missing",
  giteaUser: process.env.GITEA_USER ?? "",
  giteaRepos: repoList,
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? 600000),
  giteaFullSyncIntervalMs: Number(process.env.GITEA_FULL_SYNC_INTERVAL_MS ?? 3_600_000),
  giteaSearchSyncLookbackMs: Number(process.env.GITEA_SEARCH_SYNC_LOOKBACK_MS ?? 300_000),
  giteaFetchTimeoutMs: Number(process.env.GITEA_FETCH_TIMEOUT_MS ?? 15_000),
  maxConcurrentCodexJobs: Number(process.env.MAX_CONCURRENT_CODEX_JOBS ?? 3),
  repoSetupLockTtlMs: Number(process.env.REPO_SETUP_LOCK_TTL_MS ?? 300000),
  codexModel: process.env.CODEX_MODEL ?? "gpt-5.6-terra",
  codexReasoningEffort: process.env.CODEX_REASONING_EFFORT ?? "medium",
  codexJobTimeoutMs: Number(process.env.CODEX_JOB_TIMEOUT_MS ?? 14_400_000),
  codexJobNoProgressTimeoutMs: Number(process.env.CODEX_JOB_NO_PROGRESS_TIMEOUT_MS ?? 120_000),
  codexJobAutoContinueAttempts: Number(process.env.CODEX_JOB_AUTO_CONTINUE_ATTEMPTS ?? 10),
  codexJobAutoContinueCooldownMs: Number(process.env.CODEX_JOB_AUTO_CONTINUE_COOLDOWN_MS ?? 120_000),
  codexTmuxKeepSessions: (process.env.CODEX_TMUX_KEEP_SESSIONS ?? "false").toLowerCase() !== "false",
  larkCodexProgressReminderMs: Number(process.env.LARK_CODEX_PROGRESS_REMINDER_MS ?? process.env.LARK_CODEX_REPLY_TIMEOUT_MS ?? 300_000),
  larkCodexStartupStallMs: Number(process.env.LARK_CODEX_STARTUP_STALL_MS ?? 60_000),
  larkCodexOrphanRecoveryMs: Number(process.env.LARK_CODEX_ORPHAN_RECOVERY_MS ?? 120_000),
  larkCodexReasoningEffort: process.env.LARK_CODEX_REASONING_EFFORT ?? "low",
  larkCodexModel: process.env.LARK_CODEX_MODEL ?? process.env.CODEX_MODEL ?? "gpt-5.6-terra",
  larkCodexStreamReplyMinIntervalMs: Number(process.env.LARK_CODEX_STREAM_REPLY_MIN_INTERVAL_MS ?? 15_000),
  larkCodexMaxInterimReplies: Number(process.env.LARK_CODEX_MAX_INTERIM_REPLIES ?? 4),
  larkRecentMessageFetchLimit: Number(process.env.LARK_RECENT_MESSAGE_FETCH_LIMIT ?? 50),
  larkRecentMessageContextMaxChars: Number(process.env.LARK_RECENT_MESSAGE_CONTEXT_MAX_CHARS ?? 6000),
  larkGroupSpontaneousReplyRate: Number(process.env.LARK_GROUP_SPONTANEOUS_REPLY_RATE ?? 0.08),
  larkGroupSpontaneousReplyCooldownMs: Number(process.env.LARK_GROUP_SPONTANEOUS_REPLY_COOLDOWN_MS ?? 600_000),
  larkAgentUrl: (process.env.LARK_AGENT_URL ?? "").replace(/\/$/, ""),
  larkAgentToken: process.env.LARK_AGENT_TOKEN ?? "",
  larkAgentHostToken: process.env.LARK_AGENT_HOST_TOKEN ?? "",
  todoReminderTimeZone: process.env.TODO_REMINDER_TIME_ZONE ?? "Asia/Shanghai",
  todoDigestHour: Number(process.env.TODO_DIGEST_HOUR ?? 9),
  todoReminderStartHour: Number(process.env.TODO_REMINDER_START_HOUR ?? 9),
  todoReminderEndHour: Number(process.env.TODO_REMINDER_END_HOUR ?? 22),
  todoReminderPollIntervalMs: Number(process.env.TODO_REMINDER_POLL_INTERVAL_MS ?? 60_000),
  larkExecutionApproverId,
  trustedLarkCodexSenderIds
};

export type AppConfig = typeof config;

export type PersistedRuntimeConfig = {
  workspaceRoot: string;
  giteaBaseUrl: string;
  giteaBaseUrls: string[];
  giteaUser: string;
  larkExecutionApproverId: string;
  trustedLarkCodexSenderIds: string[];
};

export function applyPersistedRuntimeConfig(next: PersistedRuntimeConfig): void {
  const giteaBaseUrls = normalizeGiteaBaseUrls(next.giteaBaseUrls?.length ? next.giteaBaseUrls : [next.giteaBaseUrl]);
  config.workspaceRoot = next.workspaceRoot;
  config.giteaBaseUrl = giteaBaseUrls[0] ?? "";
  config.giteaBaseUrls = giteaBaseUrls;
  config.giteaUser = next.giteaUser;
  config.larkExecutionApproverId = next.larkExecutionApproverId;
  config.trustedLarkCodexSenderIds = normalizeLarkSenderIds(next.trustedLarkCodexSenderIds);
}
