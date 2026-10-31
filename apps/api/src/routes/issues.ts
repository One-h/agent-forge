import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { z } from "zod";
import { config, normalizeGiteaBaseUrls } from "../config.js";
import { giteaTokenKeychainAvailable, saveGiteaTokenToKeychain } from "../credentialStore.js";
import { ensureTodoForIssueRepairJob } from "../codexTodos.js";
import { localDiagnostics } from "../diagnostics.js";
import { addJobEvent, addLocalAuditEvent, appSettingValue, createLocalBackup, db, getAppSettings, hydrateRuntimeConfig, listLocalAuditEvents, persistedRuntimeConfig, prReviewStateFromRuns, restoreLocalBackup, setAppSettingValue, updateAppSettings, updatePersistedRuntimeConfig, type IssueRow, type LocalBackup, type PrReviewRunRow, type RepairJobRow } from "../db.js";
import { giteaSyncConfigStatus, syncGiteaIssues } from "../gitea.js";
import { findLarkContactByAlias, listLarkContacts, syncLarkContactsFromCli } from "../larkContacts.js";
import { larkMessageWorkerStatus, reconcileLarkMessageWorker } from "../larkWorker.js";
import { enqueueLarkCodexReply, larkCodexAppServerStatus, larkCodexNativeRuntime } from "../larkCodexResponder.js";
import { discoverLocalRepositories } from "../localRepos.js";
import { cleanupLocalData, localDataUsage } from "../localData.js";
import { installLaunchAgent, launchAgentStatus, restartLaunchAgent, uninstallLaunchAgent } from "../launchAgent.js";
import { createReviewOnlyJobForPull } from "../repairJobs.js";
import { configurablePromptKeys, configurablePromptSettings, updateConfigurablePrompts } from "../promptSettings.js";
import { developmentPlanFromFinalJson, taskPackageSummary, triageSummaryFromFinalJson } from "../taskPackages.js";
import { nowIso } from "../time.js";
import { rescheduleGiteaSyncTimer } from "../worker.js";
import { defaultLarkAcknowledgeReactionEmoji, isLarkReactionEmojiType } from "../larkReactionEmojis.js";
import { apiErrorCodes } from "../errorCodes.js";
import { LarkAgentResponseError, larkAgentFetch, larkAgentProxyFetch, larkAgentRequest } from "../larkAgentIntegration.js";
import { approvalDataSourcesSchema, larkAppSettingFields, larkAppSettingsPatch, ownerMentionAssistOwnerIdSchema, ownerMentionAssistSettingsSchema, readLarkAppSettings, syncLarkRuntimeSettings, withLarkRuntimeSettingsLock } from "../larkRuntimeSettingsSync.js";
import { requireLarkHostAuthorization } from "../larkHostAuthorization.js";

const repairBodySchema = z.object({
  mode: z.enum(["review_only", "issue_triage", "issue_implementation", "reviewed_pr"]).default("issue_triage"),
  repoHint: z.string().min(1).optional(),
  approveTriagePlan: z.boolean().optional()
});

const modelIdSchema = z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/, "请输入有效的模型 ID");
const deploymentAdapterSchema = z.string().trim().max(4096).refine(value => !value || path.isAbsolute(value), "部署适配脚本必须是绝对路径");
const approvalHistoryQuerySchema = z.object({
  kind: z.enum(["auto", "manual", "all"]).default("auto"),
  source: z.enum(["history", "model", "manual"]).optional(),
  status: z.enum(["approved", "manual", "reviewing", "pending", "rejected", "expired", "failed"]).optional(),
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0)
});

const settingsPatchSchema = z.object({
  autoReviewNewPulls: z.boolean().optional(),
  deploymentAdapterPath: deploymentAdapterSchema.optional(),
  issueRepairEnabled: z.boolean().optional(),
  larkMessageListenerEnabled: z.boolean().optional(),
  larkCodexRepliesEnabled: z.boolean().optional(),
  larkExecutionReceiptsEnabled: z.boolean().optional(),
  larkCodexModel: modelIdSchema.optional(),
  larkCodexReasoningEffort: z.enum(["low", "medium", "high", "xhigh", "max", "ultra"]).optional(),
  larkStickerUsageMode: z.enum(["off", "explicit", "natural", "always"]).optional(),
  larkGroupSpontaneousRepliesEnabled: z.boolean().optional(),
  larkTopicNativeModeEnabled: z.boolean().optional(),
  larkOwnerMentionAssistEnabled: z.boolean().optional(),
  larkOwnerMentionAssistOwnerId: ownerMentionAssistOwnerIdSchema.optional(),
  larkGroupSpontaneousReplyRate: z.number().min(0).max(1).optional(),
  larkGroupSpontaneousReplyCooldownMs: z.number().int().min(0).max(604_800_000).optional(),
  larkGroupSpontaneousChatIds: z.array(z.string().trim().regex(/^oc_[A-Za-z0-9]+$/, "群 ID 必须是 oc_ 开头的有效 ID")).max(200).transform((ids) => [...new Set(ids)]).optional(),
  larkTrustedExecutionEnabled: z.boolean().optional(),
  larkTurnAutoApprovalEnabled: z.boolean().optional(),
  larkTurnAutoApprovalModel: modelIdSchema.optional(),
  larkTurnAutoApprovalDataSources: approvalDataSourcesSchema.optional(),
  larkAcknowledgeReactionEmoji: z.string().refine(isLarkReactionEmojiType, "不支持的飞书表情类型").optional(),
  larkGroupMessageReactionEnabled: z.boolean().optional(),
  larkGroupMessageReactionEmoji: z.string().refine(isLarkReactionEmojiType, "不支持的飞书表情类型").optional(),
  larkGroupMessageReactionChatIds: z.array(z.string().trim().regex(/^oc_[A-Za-z0-9]+$/, "群 ID 必须是 oc_ 开头的有效 ID")).max(200).transform((ids) => [...new Set(ids)]).optional(),
  larkGroupContextMessageLimit: z.number().int().min(1).max(200).optional(),
  larkGroupContextMaxChars: z.number().int().min(500).max(30_000).optional(),
  pollIntervalMs: z.number().int().min(60_000).max(86_400_000).optional()
}).strict();

const promptSettingsSchema = z.object({
  larkAssistant: z.string().max(50_000).nullable().optional(),
  prReview: z.string().max(50_000).nullable().optional(),
  issueTriage: z.string().max(50_000).nullable().optional(),
  issueImplementation: z.string().max(50_000).nullable().optional()
}).strict().refine((value) => Object.keys(value).length > 0, "至少提交一类提示词配置");

const giteaRepositoriesSchema = z.object({
  repositories: z.array(z.string().regex(/^[^/\\\s]+\/[^/\\\s]+$/)).max(200)
});

const giteaTokenSchema = z.object({
  token: z.string().min(1).max(10_000)
});

const giteaBaseUrlSchema = z.string().trim().max(1_000).refine((value) => /^https?:\/\/[^\s]+$/i.test(value), "Gitea 地址必须是 http(s) URL");

const runtimeConfigSchema = z.object({
  workspaceRoot: z.string().trim().min(1).max(1_000).refine((value) => path.isAbsolute(value), "工作区必须是绝对路径"),
  giteaBaseUrl: z.string().trim().max(1_000).refine((value) => !value || /^https?:\/\/[^\s]+$/i.test(value), "Gitea 地址必须是 http(s) URL").optional().default(""),
  giteaBaseUrls: z.array(giteaBaseUrlSchema).max(20).optional(),
  giteaUser: z.string().trim().max(200),
  larkExecutionApproverId: z.string().trim().max(200).default(""),
  trustedLarkCodexSenderIds: z.array(z.string().trim().min(1).max(200)).max(100).default([])
}).strict().transform((value) => {
  const giteaBaseUrls = normalizeGiteaBaseUrls(value.giteaBaseUrls?.length ? value.giteaBaseUrls : [value.giteaBaseUrl]);
  return { ...value, workspaceRoot: path.resolve(value.workspaceRoot), giteaBaseUrl: giteaBaseUrls[0] ?? "", giteaBaseUrls };
});

const larkAgentCapabilitySchema = z.object({
  input: z.record(z.unknown()).default({})
});

const larkAgentDeployInputSchema = z.object({
  repo: z.string().regex(/^[A-Za-z0-9_-]+$/),
  apps: z.union([z.string().min(1), z.array(z.string().regex(/^[A-Za-z0-9_.-]+$/)).min(1).max(20)]),
  expectedRevision: z.string().regex(/^[0-9a-f]{7,64}$/i).optional(),
  timeout: z.number().int().min(30).max(1800).optional()
});

const auditQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30)
});

const refreshQuerySchema = z.object({
  refresh: z.coerce.boolean().optional()
});

const localDataCleanupSchema = z.object({
  target: z.enum(["completed-task-artifacts", "launchd-logs"]),
  olderThanDays: z.number().int().min(1).max(3_650).default(30)
});

const backupTodoStatusSchema = z.enum(["todo", "running", "blocked", "review", "done", "archived", "monitoring", "longterm"]);
const localBackupSchema = z.object({
  schemaVersion: z.literal(1),
  exportedAt: z.string().min(1).max(100),
  runtimeConfig: runtimeConfigSchema,
  appSettings: z.object({
    autoReviewNewPulls: z.boolean(),
    deploymentAdapterPath: deploymentAdapterSchema.default(""),
    issueRepairEnabled: z.boolean(),
    larkMessageListenerEnabled: z.boolean(),
    larkCodexRepliesEnabled: z.boolean(),
    larkExecutionReceiptsEnabled: z.boolean().default(true),
    larkCodexModel: modelIdSchema.default(config.larkCodexModel),
    larkCodexReasoningEffort: z.enum(["low", "medium", "high", "xhigh", "max", "ultra"]).default("low"),
    larkStickerUsageMode: z.enum(["off", "explicit", "natural", "always"]).default("natural"),
    larkGroupSpontaneousRepliesEnabled: z.boolean().default(false),
    larkTopicNativeModeEnabled: z.boolean().default(false),
    larkOwnerMentionAssistEnabled: z.boolean().default(false),
    larkOwnerMentionAssistOwnerId: ownerMentionAssistOwnerIdSchema.default(""),
    larkGroupSpontaneousReplyRate: z.number().min(0).max(1).default(0.08),
    larkGroupSpontaneousReplyCooldownMs: z.number().int().min(0).max(604_800_000).default(600_000),
    larkGroupSpontaneousChatIds: z.array(z.string().trim().regex(/^oc_[A-Za-z0-9]+$/)).max(200).default([]),
    larkTrustedExecutionEnabled: z.boolean(),
    larkTurnAutoApprovalEnabled: z.boolean().default(false),
    larkTurnAutoApprovalModel: modelIdSchema.default("gpt-6.1-sol"),
    larkTurnAutoApprovalDataSources: approvalDataSourcesSchema.default([]),
    larkAcknowledgeReactionEmoji: z.string().refine(isLarkReactionEmojiType).optional().default(defaultLarkAcknowledgeReactionEmoji),
    larkGroupMessageReactionEnabled: z.boolean().default(false),
    larkGroupMessageReactionEmoji: z.string().refine(isLarkReactionEmojiType).default(defaultLarkAcknowledgeReactionEmoji),
    larkGroupMessageReactionChatIds: z.array(z.string().trim().regex(/^oc_[A-Za-z0-9]+$/)).max(200).default([]),
    larkGroupContextMessageLimit: z.number().int().min(1).max(200).optional().default(config.larkRecentMessageFetchLimit),
    larkGroupContextMaxChars: z.number().int().min(500).max(30_000).optional().default(config.larkRecentMessageContextMaxChars),
    pollIntervalMs: z.number().int().min(60_000).max(86_400_000)
  }).strict(),
  repositories: z.array(z.string().regex(/^[^/\\\s]+\/[^/\\\s]+$/)).max(200),
  todoWorkflowMetadata: z.record(z.unknown()).optional().default({}),
  todos: z.array(z.object({
    id: z.number().int().positive().optional(),
    title: z.string().min(1).max(500),
    description: z.string().max(20_000).nullable(),
    status: backupTodoStatusSchema,
    codexSessionId: z.string().max(200).nullable(),
    createdAt: z.string().min(1).max(100),
    updatedAt: z.string().min(1).max(100)
  })).max(5_000),
  auditEvents: z.array(z.object({
    action: z.string().min(1).max(200),
    summary: z.string().min(1).max(1_000),
    details: z.string().max(20_000).nullable(),
    createdAt: z.string().min(1).max(100)
  })).max(10_000)
});

const pullQuerySchema = z.object({
  scope: z.enum(["relevant", "authored", "review", "all"]).default("relevant")
});

const larkContactQuerySchema = z.object({
  q: z.string().min(1).optional()
});

const larkMessageListQuerySchema = z.object({
  after_id: z.coerce.number().int().positive().optional(),
  include_ids: z.string().optional(),
  chat_type: z.enum(["group", "p2p"]).optional(),
  sender_id: z.string().trim().min(1).max(200).optional(),
  chat_id: z.string().trim().min(1).max(200).optional(),
  status: z.enum(["active", "answered", "failed"]).optional(),
  q: z.string().trim().min(1).max(300).optional()
});

const larkConversationListQuerySchema = z.object({
  chat_type: z.enum(["group", "p2p"]).optional(),
  keyword: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0)
});

const larkConversationMessagesQuerySchema = z.object({
  cursor: z.string().trim().min(1).max(500).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50)
});

const larkExecutionApprovalParamsSchema = z.object({
  token: z.string().regex(/^[a-f0-9]{48}$/),
  decision: z.enum(["approve", "approve-turn", "reject"])
});

function approvalDecisionHtml(title: string, message: string, success: boolean): string {
  const escapedTitle = title.replace(/[&<>"']/g, (value) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[value] ?? value);
  const escapedMessage = message.replace(/[&<>"']/g, (value) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[value] ?? value);
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapedTitle}</title><style>body{margin:0;background:#f6f7f9;color:#17181a;font:15px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;display:grid;min-height:100vh;place-items:center}.panel{width:min(420px,calc(100vw - 40px));background:#fff;border:1px solid #e4e6ea;border-radius:8px;padding:28px;box-shadow:0 16px 40px rgba(0,0,0,.08)}.mark{width:36px;height:36px;border-radius:50%;display:grid;place-items:center;background:${success ? "#e8f7ef" : "#fdecec"};color:${success ? "#18794e" : "#c23b3b"};font-weight:700}h1{font-size:20px;margin:18px 0 8px}p{color:#63666d;line-height:1.6;margin:0}</style></head><body><main class="panel"><div class="mark">${success ? "✓" : "×"}</div><h1>${escapedTitle}</h1><p>${escapedMessage}</p></main></body></html>`;
}

function readTaskFile(taskDir: string | null, fileName: string): string | null {
  if (!taskDir || !path.isAbsolute(taskDir)) {
    return null;
  }
  const filePath = path.join(taskDir, fileName);
  if (!filePath.startsWith(`${taskDir}${path.sep}`) || !fs.existsSync(filePath)) {
    return null;
  }
  return fs.readFileSync(filePath, "utf8");
}

function parseTaskJsonArray(taskDir: string | null, fileName: string): string[] {
  const text = readTaskFile(taskDir, fileName);
  if (!text) {
    return [];
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function imageMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "image/png";
}

function readLarkMessageImages(taskDir: string | null): Array<{ name: string; path: string; mimeType: string; dataUrl: string }> {
  if (!taskDir || !path.isAbsolute(taskDir)) {
    return [];
  }
  const realTaskDir = fs.existsSync(taskDir) ? fs.realpathSync(taskDir) : taskDir;
  const imagePaths = parseTaskJsonArray(taskDir, "referenced-images.json");
  return imagePaths.flatMap((imagePath) => {
    const resolved = path.isAbsolute(imagePath) ? imagePath : path.resolve(taskDir, imagePath);
    if (!fs.existsSync(resolved)) {
      return [];
    }
    const realResolved = fs.realpathSync(resolved);
    if (!realResolved.startsWith(`${realTaskDir}${path.sep}`)) {
      return [];
    }
    const mimeType = imageMimeType(realResolved);
    const data = fs.readFileSync(realResolved).toString("base64");
    return [{
      name: path.basename(realResolved),
      path: realResolved,
      mimeType,
      dataUrl: `data:${mimeType};base64,${data}`
    }];
  });
}

function readLarkMessageFiles(taskDir: string | null): Array<{ name: string; path: string; mimeType: string; size: number; text: string }> {
  if (!taskDir || !path.isAbsolute(taskDir)) {
    return [];
  }
  const realTaskDir = fs.existsSync(taskDir) ? fs.realpathSync(taskDir) : taskDir;
  const text = readTaskFile(taskDir, "referenced-files.json");
  if (!text) {
    return [];
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return [];
      }
      const file = item as { name?: unknown; path?: unknown; mimeType?: unknown; size?: unknown; text?: unknown };
      if (typeof file.name !== "string" || typeof file.path !== "string" || typeof file.text !== "string") {
        return [];
      }
      const resolved = path.isAbsolute(file.path) ? file.path : path.resolve(taskDir, file.path);
      if (!fs.existsSync(resolved)) {
        return [];
      }
      const realResolved = fs.realpathSync(resolved);
      if (!realResolved.startsWith(`${realTaskDir}${path.sep}`)) {
        return [];
      }
      return [{
        name: file.name,
        path: realResolved,
        mimeType: typeof file.mimeType === "string" ? file.mimeType : "text/plain",
        size: typeof file.size === "number" ? file.size : fs.statSync(realResolved).size,
        text: file.text
      }];
    });
  } catch {
    return [];
  }
}

function parseJsonArray(value: string | null): string[] {
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function pullMatchesScope(pull: IssueRow, scope: "relevant" | "authored" | "review" | "all"): boolean {
  if (scope === "all" || !config.giteaUser) {
    return true;
  }
  const authored = pull.author === config.giteaUser;
  const reviewRequested = parseJsonArray(pull.reviewers).includes(config.giteaUser);
  if (scope === "authored") {
    return authored;
  }
  if (scope === "review") {
    return reviewRequested;
  }
  return authored || reviewRequested;
}

function parseFinalJson(value: string | null | undefined): Record<string, unknown> | null {
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function latestIssueTriageJob(issueId: number): RepairJobRow | null {
  return db.prepare(`
    SELECT * FROM repair_jobs
    WHERE issue_id = ?
      AND mode = 'issue_triage'
      AND final_json IS NOT NULL
    ORDER BY id DESC
    LIMIT 1
  `).get(issueId) as RepairJobRow | undefined ?? null;
}

function latestIssueFinalJson(issueId: number): Record<string, unknown> | null {
  const latestJob = db.prepare("SELECT final_json FROM repair_jobs WHERE issue_id = ? ORDER BY id DESC LIMIT 1").get(issueId) as { final_json?: string | null } | undefined;
  return parseFinalJson(latestJob?.final_json);
}

function triageDecision(finalJson: Record<string, unknown> | null): string {
  const triage = finalJson?.triage && typeof finalJson.triage === "object" && !Array.isArray(finalJson.triage)
    ? finalJson.triage as Record<string, unknown>
    : {};
  return typeof triage.decision === "string" ? triage.decision : "unknown";
}

function larkMessageSelect(): string {
  return `
    SELECT
      lark_messages.id,
      lark_messages.event_id,
      lark_messages.message_id,
      lark_messages.chat_id,
      lark_messages.chat_type,
      lark_messages.sender_id,
      lark_messages.message_type,
      lark_messages.content,
      lark_messages.reply_to_message_id,
      lark_messages.reply_to_message_type,
      lark_messages.reply_to_content,
      lark_messages.reply_to_raw_json,
      lark_messages.mentioned,
      lark_messages.reply_trigger,
      lark_messages.reply_status,
      lark_messages.reply_error,
      lark_messages.codex_status,
      lark_messages.codex_reply,
      lark_messages.codex_error,
      lark_messages.codex_session_id,
      lark_messages.codex_task_dir,
      lark_messages.codex_started_at,
      lark_messages.codex_finished_at,
      lark_messages.received_at,
      lark_messages.created_at,
      lark_contacts.name AS sender_name,
      lark_contacts.enterprise_email AS sender_enterprise_email,
      lark_contacts.department AS sender_department,
      lark_contacts.p2p_chat_id AS sender_p2p_chat_id
    FROM lark_messages
    LEFT JOIN lark_contacts ON lark_contacts.open_id = lark_messages.sender_id
  `;
}

function larkMessageListSelect(): string {
  return `
    SELECT
      lark_messages.id,
      lark_messages.message_id,
      lark_messages.chat_id,
      lark_messages.chat_type,
      lark_messages.sender_id,
      lark_messages.message_type,
      substr(lark_messages.content, 1, 320) AS content,
      lark_messages.reply_to_message_id,
      lark_messages.reply_to_message_type,
      substr(lark_messages.reply_to_content, 1, 180) AS reply_to_content,
      lark_messages.mentioned,
      lark_messages.reply_trigger,
      lark_messages.reply_status,
      substr(lark_messages.reply_error, 1, 180) AS reply_error,
      lark_messages.codex_status,
      substr(lark_messages.codex_reply, 1, 320) AS codex_reply,
      substr(lark_messages.codex_error, 1, 180) AS codex_error,
      lark_messages.codex_session_id,
      lark_messages.received_at,
      lark_contacts.name AS sender_name,
      lark_contacts.enterprise_email AS sender_enterprise_email,
      lark_contacts.department AS sender_department
    FROM lark_messages
    LEFT JOIN lark_contacts ON lark_contacts.open_id = lark_messages.sender_id
  `;
}

function standaloneLarkMessage(row: Record<string, unknown>): Record<string, unknown> {
  const optionalString = (value: unknown): string | null => typeof value === "string" && value.trim() ? value : null;
  const messageAt = optionalString(row.messageAt) ?? optionalString(row.received_at) ?? new Date().toISOString();
  const receivedAt = optionalString(row.received_at) ?? messageAt;
  return {
    ...row,
    direction: row.direction === "outbound" ? "outbound" : "inbound",
    senderType: optionalString(row.senderType),
    recipientId: optionalString(row.recipientId),
    recipientName: optionalString(row.recipientName),
    messageAt,
    outboundSource: optionalString(row.outboundSource),
    sender_p2p_chat_id: row.sender_p2p_chat_id ?? null,
    reply_to_message_id: row.reply_to_message_id ?? null,
    reply_to_message_type: row.reply_to_message_type ?? null,
    reply_to_content: row.reply_to_content ?? null,
    reply_to_raw_json: row.reply_to_raw_json ?? null,
    mentioned: typeof row.mentioned === "number" ? row.mentioned : row.chat_type === "p2p" ? 1 : 0,
    reply_trigger: row.reply_trigger ?? (row.chat_type === "p2p" ? "p2p" : "mention"),
    codex_task_dir: row.codex_task_dir ?? null,
    codex_started_at: row.codex_started_at ?? null,
    codex_finished_at: row.codex_finished_at ?? null,
    created_at: row.created_at ?? receivedAt
  };
}

function errorResponse(definition: { code: string; message: string }, request: FastifyRequest): Record<string, string> {
  return { ...definition, traceId: request.id };
}

function sendLarkAgentProxyError(reply: FastifyReply, request: FastifyRequest, error: unknown) {
  if (error instanceof LarkAgentResponseError) {
    const body = error.responseBody;
    if (body && typeof body === "object" && !Array.isArray(body)) {
      const candidate = body as Record<string, unknown>;
      if (typeof candidate.code === "string" && typeof candidate.message === "string") {
        return reply.code(error.statusCode).send({
          code: candidate.code,
          message: candidate.message,
          ...(candidate.details !== undefined ? { details: candidate.details } : {}),
          traceId: typeof candidate.traceId === "string" ? candidate.traceId : request.id
        });
      }
    }
    return reply.code(error.statusCode).send(errorResponse(apiErrorCodes.LARK_AGENT_UPSTREAM_FAILED, request));
  }
  return reply.code(502).send(errorResponse(apiErrorCodes.LARK_AGENT_UNAVAILABLE, request));
}

export async function issueRoutes(app: FastifyInstance): Promise<void> {
  for (const [method, suffix] of [["GET", ""], ["PUT", ""], ["POST", "/preview"]] as const) {
    app.route({
      method,
      url: `/api/lark/chats/:chatId/persona${suffix}`,
      handler: async (request, reply) => {
        const params = z.object({ chatId: z.string().regex(/^oc_[A-Za-z0-9]+$/) }).safeParse(request.params);
        if (!params.success) return reply.code(400).send(errorResponse(apiErrorCodes.VALIDATION_FAILED, request));
        if (!config.larkAgentUrl) return reply.code(503).send(errorResponse(apiErrorCodes.LARK_AGENT_NOT_CONFIGURED, request));
        try {
          return await larkAgentProxyFetch(`/v1/chats/${encodeURIComponent(params.data.chatId)}/persona${suffix}`, {
            method,
            ...(method === "GET" ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(request.body ?? {}) })
          });
        } catch (error) { return sendLarkAgentProxyError(reply, request, error); }
      }
    });
  }
  for (const method of ["GET", "PATCH"] as const) {
    app.route({
      method,
      url: "/api/lark/chats/:chatId/settings",
      handler: async (request, reply) => {
        const params = z.object({ chatId: z.string().regex(/^oc_[A-Za-z0-9]+$/) }).safeParse(request.params);
        if (!params.success) return reply.code(400).send(errorResponse(apiErrorCodes.VALIDATION_FAILED, request));
        if (!config.larkAgentUrl) return reply.code(503).send(errorResponse(apiErrorCodes.LARK_AGENT_NOT_CONFIGURED, request));
        let body = request.body;
        if (method === "PATCH") {
          const parsed = z.object({
            stickerUsageMode: z.enum(["global", "off", "explicit", "natural", "always"]).optional(),
            spontaneousMode: z.enum(["global", "on", "off"]).optional(),
            ownerMentionAssistMode: z.enum(["global", "on", "off"]).optional(),
            spontaneousReplyRate: z.number().min(0).max(1).optional(),
            spontaneousReplyCooldownMs: z.number().int().min(0).max(604_800_000).optional()
          }).strict().refine((value) => Object.values(value).some((item) => item !== undefined)).safeParse(request.body);
          if (!parsed.success) return reply.code(400).send(errorResponse(apiErrorCodes.VALIDATION_FAILED, request));
          body = parsed.data;
        }
        try {
          const target = `/v1/chats/${encodeURIComponent(params.data.chatId)}/settings`;
          const ownerMode = method === "PATCH" ? (body as { ownerMentionAssistMode?: string }).ownerMentionAssistMode : undefined;
          const ownerSettings = (value: unknown) => ownerMentionAssistSettingsSchema.safeParse(
            value && typeof value === "object" ? (value as Record<string, unknown>).ownerMentionAssist : undefined
          );
          if (ownerMode !== undefined && !ownerSettings(await larkAgentProxyFetch(target)).success) {
            return reply.code(409).send({ error: "Lark Agent does not support owner mention assist settings yet" });
          }
          const result = await larkAgentProxyFetch(target, {
            method,
            ...(method === "GET" ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
          });
          if (ownerMode !== undefined) {
            const echo = ownerSettings(result);
            const readback = await larkAgentProxyFetch(target);
            const confirmed = ownerSettings(readback);
            if (!echo.success || echo.data.mode !== ownerMode || !confirmed.success || confirmed.data.mode !== ownerMode) {
              return reply.code(502).send({ error: "Owner mention assist settings could not be confirmed; refresh before retrying" });
            }
            return readback;
          }
          return result;
        } catch (error) { return sendLarkAgentProxyError(reply, request, error); }
      }
    });
  }
  app.post("/api/lark-agent/capabilities/:id", { preHandler: requireLarkHostAuthorization }, async (request, reply) => {
    const { id } = z.object({ id: z.enum(["forge.gitea.review-pr", "forge.gitea.triage-issue", "forge.todo.create", "forge.deploy.inspect", "forge.deploy.production"]) }).parse(request.params);
    const { input } = larkAgentCapabilitySchema.parse(request.body ?? {});
    if (id === "forge.todo.create") {
      const title = typeof input.title === "string" ? input.title.trim() : "";
      if (!title) return reply.code(400).send({ error: "title is required" });
      const response = await app.inject({ method: "POST", url: "/api/todos", payload: { title, description: typeof input.description === "string" ? input.description : null, codexSessionId: typeof input.codexSessionId === "string" ? input.codexSessionId : null } });
      const todo = response.json() as Record<string, unknown>;
      return reply.code(response.statusCode).send({ ...todo, _receipt: { status: "verified", summary: `已创建待办：${String(todo.title ?? title)}`, evidence: todo.id ? [`todo_id: ${String(todo.id)}`] : [] } });
    }
    if (id === "forge.deploy.inspect" || id === "forge.deploy.production") {
      const deployment = larkAgentDeployInputSchema.parse(input);
      if (id === "forge.deploy.production" && !deployment.expectedRevision) return reply.code(400).send({ error: "expectedRevision from forge.deploy.inspect is required" });
      const workspaceRoot = config.workspaceRoot;
      const script = getAppSettings().deploymentAdapterPath;
      if (!workspaceRoot || !script || !fs.existsSync(script) || !fs.statSync(script).isFile()) return reply.code(409).send({ error: "A local deployment adapter must be configured before using deployment capabilities" });
      const apps = Array.isArray(deployment.apps) ? deployment.apps : deployment.apps.split(",").map((value) => value.trim()).filter(Boolean);
      const args = [script, "--repo", deployment.repo, "--app", apps.join(","), "--timeout", String(deployment.timeout ?? 300), ...(deployment.expectedRevision ? ["--expected-revision", deployment.expectedRevision] : []), ...(id === "forge.deploy.production" ? ["--execute"] : [])];
      const result = await new Promise<{ status: number | null; stdout: string; stderr: string; error: string | null }>((resolve) => {
        const child = spawn(process.execPath, args, { cwd: workspaceRoot, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = ""; let stderr = "";
        child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
        child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
        child.on("error", (error) => resolve({ status: null, stdout, stderr, error: error.message }));
        child.on("close", (status) => resolve({ status, stdout, stderr, error: null }));
      });
      if (result.status !== 0) return reply.code(409).send({ error: result.error ?? (result.stderr.trim() || "production deploy command failed"), stdout: result.stdout.trim() });
      let output: Record<string, unknown>;
      try {
        const parsed = JSON.parse(result.stdout) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid adapter object");
        output = parsed as Record<string, unknown>;
      } catch { return reply.code(409).send({ error: "Deployment adapter must return a JSON object" }); }
      const verified = output.verified === true || output.fresh === true && ["deployed", "verified-noop"].includes(String(output.result));
      const appNames = apps.join(",");
      return reply.send({
        ...output,
        result: output.result ?? (id === "forge.deploy.production" ? "deployed" : "inspected"),
        _receipt: id === "forge.deploy.production"
          ? { status: verified ? "verified" : "executed", summary: verified ? `生产发布已执行并完成适配脚本验证：${appNames}` : `部署适配脚本已执行，尚未确认验证结果：${appNames}`, evidence: [`revision: ${deployment.expectedRevision}`, `apps: ${appNames}`] }
          : { status: "queried", summary: `已检查生产发布目标：${appNames}`, evidence: [`repo: ${deployment.repo}`, `apps: ${appNames}`] }
      });
    }
    const issueId = typeof input.issueId === "number" ? input.issueId : Number(input.issueId);
    if (!Number.isInteger(issueId) || issueId <= 0) return reply.code(400).send({ error: "issueId is required" });
    const response = await app.inject({ method: "POST", url: `/api/issues/${issueId}/repair`, payload: { mode: id === "forge.gitea.review-pr" ? "review_only" : "issue_triage", repoHint: typeof input.repoHint === "string" ? input.repoHint : undefined } });
    const job = response.json() as Record<string, unknown>;
    return reply.code(response.statusCode).send({ ...job, _receipt: { status: "executed", summary: id === "forge.gitea.review-pr" ? "已发起 PR 评审任务；任务结果尚未完成验证。" : "已发起 Issue 分析任务；任务结果尚未完成验证。", evidence: job.id ? [`job_id: ${String(job.id)}`] : [] } });
  });
  app.get("/api/settings", async () => {
    const appSettings = getAppSettings();
    const runtimeConfig = persistedRuntimeConfig();
    const remoteLarkSettings = config.larkAgentUrl
      ? await larkAgentFetch("/v1/settings").catch(() => null) as Record<string, unknown> | null
      : null;
    const remoteAppSettings = readLarkAppSettings(remoteLarkSettings);
    Object.assign(appSettings, remoteAppSettings);
    if (config.larkAgentUrl) appSettings.larkTrustedExecutionEnabled = remoteAppSettings.larkTrustedExecutionEnabled === true;
    appSettings.larkTurnAutoApprovalEnabled = remoteAppSettings.larkTurnAutoApprovalEnabled === true;
    const larkSettingsKnown = Object.fromEntries(Object.keys(larkAppSettingFields).map((key) => [
      key, config.larkAgentUrl ? Object.hasOwn(remoteAppSettings, key) : !key.startsWith("larkTurnAutoApproval") && !key.startsWith("larkOwnerMentionAssist") && key !== "larkTopicNativeModeEnabled"
    ]));
    const trustedSenderIds = new Set([runtimeConfig.larkExecutionApproverId, ...runtimeConfig.trustedLarkCodexSenderIds].filter(Boolean));
    const trustedExecutionKnown = !config.larkAgentUrl || typeof remoteLarkSettings?.trustedExecutionEnabled === "boolean";
    const trustedExecutionAvailable = appSettings.larkTrustedExecutionEnabled && trustedSenderIds.size > 0;
    const activeRepairJobs = db.prepare("SELECT count(*) AS count FROM repair_jobs WHERE status IN ('queued', 'running')").get() as { count: number };
    const activeReviewRuns = db.prepare("SELECT count(*) AS count FROM pr_review_runs WHERE status IN ('pending', 'running')").get() as { count: number };
    const recentFailures = db.prepare(`
      SELECT count(*) AS count
      FROM repair_jobs
      WHERE status IN ('failed', 'blocked')
        AND updated_at >= datetime('now', '-7 days')
    `).get() as { count: number };
    const legacyLarkWorker = larkMessageWorkerStatus();
    const standaloneLark = config.larkAgentUrl ? await larkAgentFetch("/v1/health").catch(() => null) as { listenerRunning?: boolean; approvalListenerRunning?: boolean; activeTurns?: number } | null : null;
    const larkWorker = standaloneLark ? { ...legacyLarkWorker, enabled: true, running: Boolean(standaloneLark.listenerRunning), approvalRunning: Boolean(standaloneLark.approvalListenerRunning), command: "Lark Agent Runtime" } : legacyLarkWorker;
    const larkCodexServer = larkCodexAppServerStatus();
    const larkCodexNative = await larkCodexNativeRuntime();
    return {
      workspaceRoot: runtimeConfig.workspaceRoot,
      runtimeConfig,
      setupComplete: Boolean(runtimeConfig.workspaceRoot && appSettingValue("setupWizardCompleted") === "true"),
      bindHost: config.host,
      giteaSync: giteaSyncConfigStatus(),
      giteaCredential: {
        source: config.giteaTokenSource,
        keychainAvailable: giteaTokenKeychainAvailable()
      },
      pollIntervalMs: appSettings.pollIntervalMs,
      maxConcurrentCodexJobs: config.maxConcurrentCodexJobs,
      codexModel: config.codexModel,
      codexReasoningEffort: config.codexReasoningEffort,
      larkCodexResponder: {
        transport: "app-server",
        running: standaloneLark ? true : larkCodexServer.running,
        activeTurns: standaloneLark?.activeTurns ?? larkCodexServer.activeTurns,
        lastError: standaloneLark ? null : larkCodexServer.lastError,
        progressReminderMs: config.larkCodexProgressReminderMs,
        model: appSettings.larkCodexModel,
        reasoningEffort: appSettings.larkCodexReasoningEffort,
        reasoningEffortConfigurable: ["low", "medium", "high", "xhigh", "max", "ultra"].includes(String(remoteLarkSettings?.reasoningEffort)),
        trustedExecutionConfigurable: trustedExecutionKnown,
        turnAutoApprovalConfigurable: typeof remoteLarkSettings?.turnAutoApprovalEnabled === "boolean",
        turnAutoApprovalModel: appSettings.larkTurnAutoApprovalModel,
        turnAutoApprovalDataSourcesConfigurable: Object.hasOwn(remoteAppSettings, "larkTurnAutoApprovalDataSources"),
        turnAutoApprovalModelConfigurable: remoteLarkSettings?.turnAutoApprovalModelConfigurable === true,
        sandbox: !trustedExecutionKnown ? "unknown" : trustedExecutionAvailable ? "trusted-senders-bypass-others-read-only" : "all-senders-read-only",
        approvalRecipientConfigured: Boolean(runtimeConfig.larkExecutionApproverId),
        trustedSenderCount: trustedSenderIds.size,
        native: standaloneLark ? { available: false, refreshedAt: null, configuredModelAvailable: null, models: [], skills: [], threads: [] } : larkCodexNative
      },
      larkMessageListener: larkWorker,
      runtimeStatus: {
        lastGiteaSyncAt: appSettingValue("giteaSearchSyncAt") ?? appSettingValue("giteaFullSyncAt"),
        activeCodexJobs: activeRepairJobs.count + activeReviewRuns.count,
        recentFailedJobs: recentFailures.count,
        larkListenerRunning: larkWorker.running
      },
      appSettings,
      larkSettingsKnown,
      prompts: config.larkAgentUrl
        ? await (async () => {
            const defaults = configurablePromptSettings();
            const remote = await larkAgentFetch("/v1/prompts").catch(() => ({ larkAssistant: "", defaultLarkAssistant: "", customized: false })) as { larkAssistant?: unknown; defaultLarkAssistant?: unknown; customized?: unknown };
            const value = String(remote.larkAssistant ?? "").trim();
            const defaultValue = String(remote.defaultLarkAssistant ?? "").trim() || defaults.larkAssistant.defaultValue;
            return { ...defaults, larkAssistant: { value: value || defaultValue, defaultValue, customized: remote.customized === true } };
          })()
        : configurablePromptSettings()
    };
  });

  app.get("/api/lark/models", async (request, reply) => {
    if (!config.larkAgentUrl) return { models: (await larkCodexNativeRuntime()).models };
    try { return await larkAgentProxyFetch("/v1/models"); }
    catch (error) { return sendLarkAgentProxyError(reply, request, error); }
  });

  app.patch("/api/settings", async (request, reply) => withLarkRuntimeSettingsLock(async () => {
    const parsed = settingsPatchSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Invalid settings" });
    const patch = parsed.data;
    const rollback = await syncLarkRuntimeSettings(larkAppSettingsPatch(patch));
    const changedKeys = Object.keys(patch);
    let saved;
    try {
      saved = db.transaction(() => {
        const settings = updateAppSettings(patch);
        if (changedKeys.length > 0) addLocalAuditEvent("settings.updated", "更新本机功能开关", { changedKeys });
        return settings;
      })();
    } catch (error) { await rollback(error); throw error; }
    if (!config.larkAgentUrl && patch.larkMessageListenerEnabled !== undefined) reconcileLarkMessageWorker();
    if (patch.pollIntervalMs !== undefined) rescheduleGiteaSyncTimer();
    return saved;
  }));

  app.put("/api/settings/prompts", async (request, reply) => {
    const parsed = promptSettingsSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Invalid prompt settings" });
    const patch = parsed.data;
    let remoteLarkPrompt: { larkAssistant?: unknown; defaultLarkAssistant?: unknown; customized?: unknown } | null = null;
    if (config.larkAgentUrl && patch.larkAssistant !== undefined) {
      remoteLarkPrompt = await larkAgentRequest("/v1/prompts", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ larkAssistant: patch.larkAssistant ?? "" }) }) as { larkAssistant?: unknown; defaultLarkAssistant?: unknown; customized?: unknown };
      delete patch.larkAssistant;
    }
    const prompts = updateConfigurablePrompts(patch);
    addLocalAuditEvent("prompts.updated", "更新 Codex 提示词配置", {
      changedKeys: configurablePromptKeys.filter((key) => key in patch)
    });
    if (!remoteLarkPrompt) return prompts;
    const defaultValue = String(remoteLarkPrompt.defaultLarkAssistant ?? "").trim() || prompts.larkAssistant.defaultValue;
    return { ...prompts, larkAssistant: { value: String(remoteLarkPrompt.larkAssistant ?? defaultValue), defaultValue, customized: remoteLarkPrompt.customized === true } };
  });

  app.put("/api/settings/runtime-config", async (request, reply) => withLarkRuntimeSettingsLock(async () => {
    const parsed = runtimeConfigSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Invalid runtime config" });
    const next = parsed.data;
    const rollback = await syncLarkRuntimeSettings({
      workspaceRoot: next.workspaceRoot,
      approverId: next.larkExecutionApproverId,
      trustedSenderIds: [...new Set([next.larkExecutionApproverId, ...next.trustedLarkCodexSenderIds].filter(Boolean))]
    });
    let runtimeConfig;
    try {
      runtimeConfig = db.transaction(() => {
        const saved = updatePersistedRuntimeConfig({ ...next, trustedLarkCodexSenderIds: [...new Set(next.trustedLarkCodexSenderIds)] });
        addLocalAuditEvent("runtime-config.updated", "更新本机基础配置", {
          workspaceConfigured: Boolean(saved.workspaceRoot),
          giteaConfigured: saved.giteaBaseUrls.length > 0,
          approvalRecipientConfigured: Boolean(saved.larkExecutionApproverId),
          trustedSenderCount: new Set([saved.larkExecutionApproverId, ...saved.trustedLarkCodexSenderIds].filter(Boolean)).size
        });
        return saved;
      })();
    } catch (error) {
      hydrateRuntimeConfig();
      await rollback(error);
      throw error;
    }
    rescheduleGiteaSyncTimer();
    return runtimeConfig;
  }));

  app.post("/api/settings/onboarding/complete", async (_request, reply) => {
    const runtimeConfig = persistedRuntimeConfig();
    if (!runtimeConfig.workspaceRoot) {
      return reply.code(409).send({ error: "请先配置工作区路径" });
    }
    setAppSettingValue("setupWizardCompleted", "true");
    addLocalAuditEvent("onboarding.completed", "完成首次配置引导");
    return { setupComplete: true, giteaConfigured: giteaSyncConfigStatus().configured };
  });

  app.get("/api/settings/backup", async () => createLocalBackup());

  app.post("/api/settings/backup/restore", async (request, reply) => withLarkRuntimeSettingsLock(async () => {
    try {
      const backup = localBackupSchema.parse(request.body ?? {}) as LocalBackup;
      const rollback = await syncLarkRuntimeSettings({
        ...larkAppSettingsPatch(backup.appSettings),
        workspaceRoot: backup.runtimeConfig.workspaceRoot,
        approverId: backup.runtimeConfig.larkExecutionApproverId,
        trustedSenderIds: [...new Set([backup.runtimeConfig.larkExecutionApproverId, ...backup.runtimeConfig.trustedLarkCodexSenderIds].filter(Boolean))]
      }, { allowLegacyBackup: true });
      let restored;
      try {
        restored = db.transaction(() => {
          const result = restoreLocalBackup(backup);
          setAppSettingValue("setupWizardCompleted", backup.runtimeConfig.workspaceRoot ? "true" : "false");
          addLocalAuditEvent("backup.restored", "恢复本机备份", { todos: result.todos, auditEvents: result.auditEvents });
          return result;
        })();
      } catch (error) {
        hydrateRuntimeConfig();
        await rollback(error);
        throw error;
      }
      rescheduleGiteaSyncTimer();
      const runtimeConfig = persistedRuntimeConfig();
      return { ...restored, setupComplete: Boolean(runtimeConfig.workspaceRoot) };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  }));

  app.get("/api/settings/diagnostics", async (request) => {
    const { refresh } = refreshQuerySchema.parse(request.query ?? {});
    return await localDiagnostics({ refresh: Boolean(refresh) });
  });

  app.get("/api/settings/audit", async (request) => {
    const { limit } = auditQuerySchema.parse(request.query ?? {});
    return listLocalAuditEvents(limit);
  });

  app.get("/api/settings/local-data", async () => localDataUsage());

  app.post("/api/settings/local-data/cleanup", async (request) => {
    const { target, olderThanDays } = localDataCleanupSchema.parse(request.body ?? {});
    const result = cleanupLocalData(target, olderThanDays);
    addLocalAuditEvent("local-data.cleaned", "清理本机数据", { olderThanDays, ...result });
    return { ...result, usage: localDataUsage() };
  });

  app.get("/api/settings/launchd", async () => launchAgentStatus());

  app.post("/api/settings/launchd/install", async (request, reply) => {
    try {
      const status = installLaunchAgent();
      addLocalAuditEvent("launchd.installed", status.startDeferred ? "已安装常驻服务，等待当前开发服务退出" : "已安装并启动常驻服务", { startDeferred: status.startDeferred });
      return status;
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/settings/launchd/restart", async (_request, reply) => {
    const status = launchAgentStatus();
    if (!status.installed) {
      return reply.code(400).send({ error: "请先安装常驻服务" });
    }
    addLocalAuditEvent("launchd.restart-requested", "请求重启常驻服务");
    setTimeout(() => {
      try {
        restartLaunchAgent();
      } catch (error) {
        addLocalAuditEvent("launchd.restart-failed", "常驻服务重启失败", { error: error instanceof Error ? error.message : String(error) });
      }
    }, 350).unref();
    return { scheduled: true };
  });

  app.post("/api/settings/launchd/uninstall", async (_request, reply) => {
    const status = launchAgentStatus();
    if (!status.installed) {
      return reply.code(400).send({ error: "常驻服务尚未安装" });
    }
    addLocalAuditEvent("launchd.uninstall-requested", "请求移除常驻服务");
    setTimeout(() => {
      try {
        uninstallLaunchAgent();
      } catch (error) {
        addLocalAuditEvent("launchd.uninstall-failed", "常驻服务移除失败", { error: error instanceof Error ? error.message : String(error) });
      }
    }, 350).unref();
    return { scheduled: true };
  });

  app.get("/api/settings/repositories/discover", async (request) => {
    const { refresh } = refreshQuerySchema.parse(request.query ?? {});
    return discoverLocalRepositories({ refresh: Boolean(refresh) });
  });

  app.put("/api/settings/repositories", async (request) => {
    const { repositories } = giteaRepositoriesSchema.parse(request.body ?? {});
    const selected = [...new Set(repositories)].sort();
    setAppSettingValue("giteaRepos", JSON.stringify(selected));
    addLocalAuditEvent("repositories.updated", "更新可同步仓库", { repositoryCount: selected.length });
    return giteaSyncConfigStatus();
  });

  app.post("/api/settings/gitea-token", async (request, reply) => {
    const { token } = giteaTokenSchema.parse(request.body ?? {});
    try {
      saveGiteaTokenToKeychain(token.trim());
      config.giteaToken = token.trim();
      config.giteaTokenSource = "keychain";
      addLocalAuditEvent("gitea-token.saved", "已更新 Gitea 钥匙串凭据");
      return { stored: true, source: config.giteaTokenSource };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/lark/approval-history", async (request, reply) => {
    const parsed = approvalHistoryQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "审批记录筛选条件无效" });
    if (!config.larkAgentUrl) return reply.code(503).send(errorResponse(apiErrorCodes.LARK_AGENT_NOT_CONFIGURED, request));
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(parsed.data)) if (value !== undefined) params.set(key, String(value));
    try { return await larkAgentProxyFetch(`/v1/approval-history?${params}`); }
    catch (error) { return sendLarkAgentProxyError(reply, request, error); }
  });
  app.get("/api/lark/approval-history/:kind/:id", async (request, reply) => {
    const { kind, id } = request.params as { kind: string; id: string };
    if (!["auto", "execution", "capability"].includes(kind) || !/^\d+$/.test(id) || !Number.isSafeInteger(Number(id)) || Number(id) < 1) return reply.code(400).send({ error: "审批记录 ID 无效" });
    if (!config.larkAgentUrl) return reply.code(503).send(errorResponse(apiErrorCodes.LARK_AGENT_NOT_CONFIGURED, request));
    try { return await larkAgentProxyFetch(`/v1/approval-history/${kind}/${id}`); }
    catch (error) { return sendLarkAgentProxyError(reply, request, error); }
  });

  app.get("/api/lark/messages", async (request) => {
    const {
      after_id: afterId,
      include_ids: includeIdsValue,
      chat_type: chatType,
      sender_id: senderId,
      chat_id: chatId,
      status,
      q: query
    } = larkMessageListQuerySchema.parse(request.query ?? {});
    if (!config.larkAgentUrl) {
      return (db.prepare(`${larkMessageListSelect()} ORDER BY lark_messages.received_at DESC, lark_messages.id DESC LIMIT 150`).all() as Array<Record<string, unknown>>)
        .map(standaloneLarkMessage);
    }
    const params = new URLSearchParams();
    if (afterId) params.set("after_id", String(afterId));
    if (includeIdsValue) params.set("include_ids", includeIdsValue);
    if (chatType) params.set("chat_type", chatType);
    if (senderId) params.set("sender_id", senderId);
    if (chatId) params.set("chat_id", chatId);
    if (status) params.set("status", status);
    if (query) params.set("q", query);
    params.set("limit", "150");
    return (await larkAgentFetch(`/v1/messages?${params.toString()}`) as Array<Record<string, unknown>>).map(standaloneLarkMessage);
  });

  app.get("/api/lark/messages/filters", async () => {
    if (!config.larkAgentUrl) return { senders: [], chats: [] };
    return larkAgentFetch("/v1/messages/filters");
  });

  app.get("/api/lark/conversations", async (request, reply) => {
    const parsedQuery = larkConversationListQuerySchema.safeParse(request.query ?? {});
    if (!parsedQuery.success) return reply.code(400).send(errorResponse(apiErrorCodes.VALIDATION_FAILED, request));
    const { keyword, limit, offset, chat_type } = parsedQuery.data;
    if (!config.larkAgentUrl) {
      return reply.code(503).send(errorResponse(apiErrorCodes.LARK_AGENT_NOT_CONFIGURED, request));
    }
    const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    if (chat_type) params.set("chat_type", chat_type);
    if (keyword) params.set("keyword", keyword);
    try {
      return await larkAgentProxyFetch(`/v1/contact-conversations?${params.toString()}`);
    } catch (error) {
      return sendLarkAgentProxyError(reply, request, error);
    }
  });

  app.get("/api/lark/conversations/:chatId/sessions", async (request, reply) => {
    const parsed = z.object({ chatId: z.string().regex(/^oc_[A-Za-z0-9]+$/) }).safeParse(request.params);
    if (!parsed.success) return reply.code(400).send(errorResponse(apiErrorCodes.VALIDATION_FAILED, request));
    if (!config.larkAgentUrl) return reply.code(503).send(errorResponse(apiErrorCodes.LARK_AGENT_NOT_CONFIGURED, request));
    try {
      return await larkAgentProxyFetch(`/v1/contact-conversations/${encodeURIComponent(parsed.data.chatId)}/sessions`);
    } catch (error) { return sendLarkAgentProxyError(reply, request, error); }
  });

  app.post("/api/lark/conversations/:chatId/sessions/reset", async (request, reply) => {
    const parsed = z.object({ chatId: z.string().regex(/^oc_[A-Za-z0-9]+$/) }).safeParse(request.params);
    const body = z.object({ sessionKey: z.string().min(1).max(300), expectedSessionId: z.string().min(1).max(100) }).safeParse(request.body);
    if (!parsed.success || !body.success) return reply.code(400).send(errorResponse(apiErrorCodes.VALIDATION_FAILED, request));
    if (!config.larkAgentUrl) return reply.code(503).send(errorResponse(apiErrorCodes.LARK_AGENT_NOT_CONFIGURED, request));
    try {
      return await larkAgentProxyFetch(`/v1/contact-conversations/${encodeURIComponent(parsed.data.chatId)}/sessions/reset`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body.data)
      });
    } catch (error) { return sendLarkAgentProxyError(reply, request, error); }
  });

  app.get("/api/lark/conversations/:contactId/messages", async (request, reply) => {
    const parsedParams = z.object({ contactId: z.string().regex(/^o[uc]_[A-Za-z0-9]+$/) }).safeParse(request.params);
    const parsedQuery = larkConversationMessagesQuerySchema.safeParse(request.query ?? {});
    if (!parsedParams.success || !parsedQuery.success) return reply.code(400).send(errorResponse(apiErrorCodes.VALIDATION_FAILED, request));
    const { contactId } = parsedParams.data;
    const { cursor, limit } = parsedQuery.data;
    if (!config.larkAgentUrl) {
      return reply.code(503).send(errorResponse(apiErrorCodes.LARK_AGENT_NOT_CONFIGURED, request));
    }
    const params = new URLSearchParams({ limit: String(limit) });
    if (cursor) params.set("cursor", cursor);
    try {
      const response = await larkAgentProxyFetch(`/v1/contact-conversations/${encodeURIComponent(contactId)}/messages?${params.toString()}`) as { items?: Array<Record<string, unknown>> } & Record<string, unknown>;
      return {
        ...response,
        items: Array.isArray(response.items) ? response.items.map(standaloneLarkMessage) : []
      };
    } catch (error) {
      return sendLarkAgentProxyError(reply, request, error);
    }
  });

  app.get("/api/lark/messages/:id", async (request, reply) => {
    const { id } = z.object({ id: z.coerce.number() }).parse(request.params);
    if (!config.larkAgentUrl) {
      const message = db.prepare(`${larkMessageSelect()} WHERE lark_messages.id = ?`).get(id) as Record<string, unknown> | undefined;
      return message ? standaloneLarkMessage(message) : reply.code(404).send({ error: "Lark message not found" });
    }
    try { return standaloneLarkMessage(await larkAgentFetch(`/v1/messages/${id}`) as Record<string, unknown>); } catch { return reply.code(404).send({ error: "Lark message not found" }); }
  });

  app.post("/api/lark/messages/:id/retry", async (request, reply) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
    if (!config.larkAgentUrl) { const message = db.prepare("SELECT id, codex_status FROM lark_messages WHERE id = ?").get(id) as { id: number; codex_status: string } | undefined; if (!message) return reply.code(404).send({ error: "Lark message not found" }); if (!enqueueLarkCodexReply(id)) return reply.code(409).send({ error: `消息当前状态为 ${message.codex_status}，不能重新执行` }); return reply.code(202).send({ id, status: "queued" }); }
    try { return reply.code(202).send(await larkAgentRequest(`/v1/messages/${id}/retry`, { method: "POST" })); } catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) }); }
  });

  app.get("/api/lark/execution-approvals/:token/:decision", async (_request, reply) => reply.code(410).send({ error: "Legacy Forge approval endpoint is retired; use the Lark Agent card action." }));

  app.get("/api/lark/messages/:id/artifacts", async (request, reply) => {
    const { id } = z.object({ id: z.coerce.number() }).parse(request.params);
    if (config.larkAgentUrl) {
      try {
        const result = await larkAgentFetch(`/v1/messages/${id}/artifacts`) as Record<string, unknown> & { approvals?: Array<Record<string, unknown>> };
        return { prompt: result.prompt ?? null, stdout: result.stdout ?? null, stderr: result.stderr ?? null, tmuxCapture: null, launcher: result.launcher ?? null, referencedImages: result.referencedImages ?? null, referencedFiles: result.referencedFiles ?? null, imageDownloadError: result.imageDownloadError ?? null, fileDownloadError: result.fileDownloadError ?? null, trustedSender: result.trustedSender ?? null, resumeSession: result.resumeSession ?? null, outboundMedia: result.outboundMedia ?? null, turnResult: result.turnResult ?? null, executionConfigs: Array.isArray(result.executionConfigs) ? result.executionConfigs : [], receipts: result.receipts ?? [], deliveries: result.deliveries ?? [], approvals: (result.approvals ?? []).map((approval) => ({ id: approval.id, approverId: approval.approver_id, operation: approval.operation, cwd: approval.cwd ?? null, reason: approval.reason ?? null, status: approval.status, approvalScope: approval.approval_scope ?? "once", createdAt: approval.created_at ?? null, decidedAt: approval.decided_at ?? null, expiresAt: approval.expires_at, cardError: approval.card_error ?? null })) };
      } catch { return reply.code(404).send({ error: "Lark message not found" }); }
    }
    const message = db.prepare("SELECT codex_task_dir FROM lark_messages WHERE id = ?").get(id) as { codex_task_dir?: string | null } | undefined;
    if (!message) {
      return reply.code(404).send({ error: "Lark message not found" });
    }
    const taskDir = message.codex_task_dir ?? null;
    return {
      prompt: readTaskFile(taskDir, "prompt.md"),
      stdout: readTaskFile(taskDir, "codex.stdout.jsonl"),
      stderr: readTaskFile(taskDir, "codex.stderr.log"),
      tmuxCapture: readTaskFile(taskDir, "tmux-capture.log"),
      launcher: readTaskFile(taskDir, "run-codex-lark.sh"),
      referencedImages: readTaskFile(taskDir, "referenced-images.json"),
      referencedFiles: readTaskFile(taskDir, "referenced-files.json"),
      imageDownloadError: readTaskFile(taskDir, "image-download-error.log"),
      fileDownloadError: readTaskFile(taskDir, "file-download-error.log"),
      trustedSender: readTaskFile(taskDir, "trusted-sender.json"),
      resumeSession: readTaskFile(taskDir, "resume-session.json"),
      outboundMedia: readTaskFile(taskDir, "outbound-media.json"),
      turnResult: readTaskFile(taskDir, "turn-result.json"),
      receipts: [],
      deliveries: [],
      approvals: db.prepare(`
        SELECT id, approver_id AS approverId, operation, cwd, reason, status,
          approval_scope AS approvalScope,
          created_at AS createdAt, decided_at AS decidedAt, expires_at AS expiresAt,
          card_error AS cardError
        FROM lark_execution_approvals
        WHERE lark_message_id = ?
        ORDER BY id
      `).all(id)
    };
  });

  app.get("/api/lark/messages/:id/images", async (request, reply) => {
    const { id } = z.object({ id: z.coerce.number() }).parse(request.params);
    if (config.larkAgentUrl) {
      try { return await larkAgentFetch(`/v1/messages/${id}/images`); } catch { return reply.code(404).send({ error: "Lark message not found" }); }
    }
    const message = db.prepare("SELECT codex_task_dir FROM lark_messages WHERE id = ?").get(id) as { codex_task_dir?: string | null } | undefined;
    if (!message) {
      return reply.code(404).send({ error: "Lark message not found" });
    }
    return readLarkMessageImages(message.codex_task_dir ?? null);
  });

  app.get("/api/lark/messages/:id/files", async (request, reply) => {
    const { id } = z.object({ id: z.coerce.number() }).parse(request.params);
    if (config.larkAgentUrl) {
      try { return await larkAgentFetch(`/v1/messages/${id}/files`); } catch { return reply.code(404).send({ error: "Lark message not found" }); }
    }
    const message = db.prepare("SELECT codex_task_dir FROM lark_messages WHERE id = ?").get(id) as { codex_task_dir?: string | null } | undefined;
    if (!message) {
      return reply.code(404).send({ error: "Lark message not found" });
    }
    return readLarkMessageFiles(message.codex_task_dir ?? null);
  });

  app.get("/api/lark/contacts", async (request) => {
    const { q } = larkContactQuerySchema.parse(request.query ?? {});
    if (!config.larkAgentUrl) return q ? findLarkContactByAlias(q) : listLarkContacts();
    const contacts = await larkAgentFetch("/v1/contacts") as Array<{ open_id: string; name: string; aliases: string; email: string | null; department: string | null }>;
    const matched = q ? contacts.filter((contact) => [contact.open_id, contact.name, contact.aliases, contact.email, contact.department].some((value) => String(value ?? "").toLowerCase().includes(q.toLowerCase()))) : contacts;
    return matched.map((contact) => ({ ...contact, enterprise_email: contact.email, user_id: contact.open_id }));
  });

  app.post("/api/lark/contacts/sync", async (_request, reply) => {
    try {
      if (!config.larkAgentUrl) return syncLarkContactsFromCli();
      const result = await larkAgentRequest("/v1/contacts/sync", { method: "POST" });
      addLocalAuditEvent("lark-contacts.synced", "更新飞书人员列表", result as Record<string, unknown>);
      return result;
    } catch (error) {
      return reply.code(502).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/notifications", async () => {
    return db.prepare(`
      SELECT notifications.*, issues.repo_owner, issues.repo_name, issues.kind, issues.external_id
      FROM notifications
      LEFT JOIN issues ON issues.id = notifications.issue_id
      ORDER BY notifications.created_at DESC, notifications.id DESC
      LIMIT 100
    `).all();
  });

  app.post("/api/notifications/:id/read", async (request, reply) => {
    const { id } = z.object({ id: z.coerce.number() }).parse(request.params);
    const result = db.prepare("UPDATE notifications SET read_at = ? WHERE id = ?").run(nowIso(), id);
    if (result.changes === 0) {
      return reply.code(404).send({ error: "Notification not found" });
    }
    return db.prepare("SELECT * FROM notifications WHERE id = ?").get(id);
  });

  app.get("/api/issues", async () => {
    const issues = db.prepare(`
      SELECT issues.*, triage_jobs.final_json AS triage_final_json
      FROM issues
      LEFT JOIN repair_jobs AS triage_jobs ON triage_jobs.id = (
        SELECT id
        FROM repair_jobs
        WHERE issue_id = issues.id
          AND mode = 'issue_triage'
          AND final_json IS NOT NULL
        ORDER BY id DESC
        LIMIT 1
      )
      WHERE issues.kind = 'issue'
      ORDER BY issues.updated_at DESC, issues.id DESC
      LIMIT 300
    `).all() as Array<IssueRow & { triage_final_json: string | null }>;
    return issues.map(({ triage_final_json: triageFinalJson, ...issue }) => {
      const finalJson = parseFinalJson(triageFinalJson);
      return {
        ...issue,
        triage: triageSummaryFromFinalJson(finalJson)
      };
    });
  });

  app.get("/api/pulls", async (request) => {
    const { scope } = pullQuerySchema.parse(request.query ?? {});
    const pulls = db.prepare(`
      SELECT * FROM issues
      WHERE kind = 'pr' AND status = 'open'
      ORDER BY updated_at DESC, id DESC
      LIMIT 300
    `).all() as IssueRow[];
    const scopedPulls = pulls.filter((pull) => pullMatchesScope(pull, scope)).slice(0, 200);
    if (scopedPulls.length === 0) {
      return [];
    }
    const reviewRuns = db.prepare(`
      SELECT * FROM pr_review_runs
      WHERE issue_id IN (${scopedPulls.map(() => "?").join(", ")})
    `).all(...scopedPulls.map((pull) => pull.id)) as PrReviewRunRow[];
    const runsByIssueId = new Map<number, PrReviewRunRow[]>();
    for (const run of reviewRuns) {
      const runs = runsByIssueId.get(run.issue_id) ?? [];
      runs.push(run);
      runsByIssueId.set(run.issue_id, runs);
    }
    return scopedPulls.map((pull) => ({
      ...pull,
      ...prReviewStateFromRuns(pull, runsByIssueId.get(pull.id) ?? [])
    }));
  });

  app.get("/api/issues/:id", async (request, reply) => {
    const { id } = z.object({ id: z.coerce.number() }).parse(request.params);
    const issue = db.prepare("SELECT * FROM issues WHERE id = ?").get(id) as IssueRow | undefined;
    if (!issue) return reply.code(404).send({ error: "Issue not found" });
    const triageJob = latestIssueTriageJob(id);
    const finalJson = parseFinalJson(triageJob?.final_json) ?? latestIssueFinalJson(id);
    const triagePackage = triageJob ? taskPackageSummary(triageJob) : null;
    return {
      ...issue,
      triage: triageSummaryFromFinalJson(finalJson),
      development_plan: developmentPlanFromFinalJson(finalJson),
      triage_task_package: triagePackage
    };
  });

  app.post("/api/issues/sync", async (_request, reply) => {
    try {
      return await syncGiteaIssues({ forceFull: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith("Gitea sync is not configured")) {
        return reply.code(400).send({ error: message });
      }
      if (message.startsWith("Gitea request failed")) {
        return reply.code(502).send({ error: message });
      }
      throw error;
    }
  });

  app.get("/api/issues/:id/jobs", async (request) => {
    const { id } = z.object({ id: z.coerce.number() }).parse(request.params);
    const jobs = db.prepare("SELECT * FROM repair_jobs WHERE issue_id = ? ORDER BY id DESC").all(id) as RepairJobRow[];
    return jobs.map((job) => ({
      ...job,
      task_package: taskPackageSummary(job)
    }));
  });

  app.post("/api/issues/:id/repair", async (request, reply) => {
    const { id } = z.object({ id: z.coerce.number() }).parse(request.params);
    const body = repairBodySchema.parse(request.body ?? {});
    const issue = db.prepare("SELECT * FROM issues WHERE id = ?").get(id) as IssueRow | undefined;
    if (!issue) return reply.code(404).send({ error: "Issue not found" });
    if (issue.kind === "pr" && body.mode !== "review_only") {
      return reply.code(409).send({
        error: "Pull requests can only start review_only Codex jobs. Use an issue repair job to create a new PR."
      });
    }
    if (issue.kind !== "pr" && !getAppSettings().issueRepairEnabled) {
      return reply.code(409).send({ error: "Issue repair is disabled in local settings." });
    }

    if (issue.kind === "pr") {
      if (!issue.head_sha) {
        return reply.code(409).send({
          error: "Pull request head_sha is missing. Sync Gitea before starting a review job."
        });
      }
      const created = createReviewOnlyJobForPull(issue, body.repoHint ?? issue.repo_name, { retryFailed: true });
      if (!created.ok && created.reason === "duplicate") {
        return reply.code(409).send({
          error: "A review run already exists for this pull request head.",
          review_key: created.reviewKey,
          job: created.job
        });
      }
      if (!created.ok && created.reason === "active_review") {
        return reply.code(409).send({
          error: "A review run is already active for this pull request.",
          review_key: created.reviewKey,
          job: created.job
        });
      }
      if (!created.ok) {
        return reply.code(409).send({ error: `Unable to start pull request review: ${created.reason}` });
      }
      return created.job;
    }

    const createdAt = nowIso();
    const mode = body.mode === "reviewed_pr" ? "issue_implementation" : body.mode;
    const approvedPlan = body.approveTriagePlan === true;
    if (mode === "issue_implementation") {
      const triageJob = latestIssueTriageJob(id);
      if (!triageJob) {
        return reply.code(409).send({ error: "Run issue triage before starting implementation." });
      }
      const decision = triageDecision(parseFinalJson(triageJob.final_json));
      if (decision === "hard-human-handoff") {
        return reply.code(409).send({ error: "Triage requires human handoff and cannot start implementation automatically." });
      }
      if (decision === "mid-human-review" && !approvedPlan) {
        return reply.code(409).send({
          error: "Triage plan needs human approval before implementation.",
          required: "approveTriagePlan"
        });
      }
      if (decision !== "easy-direct" && decision !== "mid-human-review") {
        return reply.code(409).send({ error: `Triage decision ${decision} cannot start implementation.` });
      }
    }
    const phase = mode === "issue_triage" ? "triage" : "implementation";
    const result = db.prepare(`
      INSERT INTO repair_jobs (issue_id, status, phase, mode, repo_hint, created_at, updated_at)
      VALUES (?, 'queued', ?, ?, ?, ?, ?)
    `).run(id, phase, mode, body.repoHint ?? issue.repo_name, createdAt, createdAt);
    if (approvedPlan && mode === "issue_implementation") {
      addJobEvent(Number(result.lastInsertRowid), "info", "Human approved triage plan for implementation");
    }
    db.prepare("UPDATE issues SET status = 'queued', updated_at = ? WHERE id = ?").run(createdAt, id);
    const job = db.prepare("SELECT * FROM repair_jobs WHERE id = ?").get(result.lastInsertRowid) as RepairJobRow;
    ensureTodoForIssueRepairJob(job, issue);
    return job;
  });
}
