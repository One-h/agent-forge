export type Issue = {
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
  status: string;
  updated_at: string;
  review_state?: "none" | "running" | "reviewed" | "posted" | "failed" | "stale";
  review_key?: string | null;
  review_head_sha?: string | null;
  review_status?: string | null;
  review_verdict?: string | null;
  review_posted?: boolean;
  review_task_package_path?: string | null;
  review_finished_at?: string | null;
  review_stale?: boolean;
  triage?: TriageSummary;
  development_plan?: DevelopmentPlanSummary | null;
  triage_task_package?: TaskPackageSummary | null;
};

export type TriageSummary = {
  decision: "easy-direct" | "mid-human-review" | "hard-human-handoff" | "unknown";
  difficulty: number | null;
  workload: number | null;
  importance: number | null;
  complexity: number | null;
  summary: string | null;
};

export type TaskPackageSummary = {
  path: string | null;
  files: Array<{
    name: string;
    path: string;
    exists: boolean;
    bytes: number | null;
  }>;
  finalJson: Record<string, unknown> | null;
  triage: TriageSummary;
  developmentPlan: DevelopmentPlanSummary;
};

export type DevelopmentPlanSummary = {
  summary: string | null;
  steps: string[];
  targetFiles: string[];
  verification: string[];
  risks: string[];
};

export type RepairJob = {
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
  pr_url: string | null;
  error: string | null;
  updated_at: string;
  final_json?: string | null;
  task_package?: TaskPackageSummary;
};

export type RepairRun = Pick<RepairJob, "id" | "status" | "mode" | "updated_at"> & {
  repo_owner: string;
  repo_name: string;
  issue_title: string;
  issue_kind: "issue" | "pr";
  external_id: string;
};

export type Notification = {
  id: number;
  type: string;
  title: string;
  body: string | null;
  issue_id: number | null;
  read_at: string | null;
  created_at: string;
  repo_owner?: string | null;
  repo_name?: string | null;
  kind?: "issue" | "pr" | null;
  external_id?: string | null;
};

export type Settings = {
  workspaceRoot: string;
  runtimeConfig: RuntimeConfig;
  setupComplete: boolean;
  bindHost: string;
  giteaSync: {
    configured: boolean;
    missing: string[];
    repoCount: number;
    repos: string[];
    userFilter: string | null;
  };
  giteaCredential: {
    source: "keychain" | "env" | "tea" | "missing";
    keychainAvailable: boolean;
  };
  pollIntervalMs: number;
  maxConcurrentCodexJobs: number;
  codexModel: string;
  codexReasoningEffort: string;
  larkMessageListener: {
    enabled: boolean;
    running: boolean;
    command: string;
    approvalRunning: boolean;
    approvalCommand: string;
    acknowledgeReactionEmoji: string;
    acknowledgeReactionOptions: string[];
  };
  runtimeStatus: {
    lastGiteaSyncAt: string | null;
    activeCodexJobs: number;
    recentFailedJobs: number;
    larkListenerRunning: boolean;
  };
  larkCodexResponder: {
    transport: string;
    running: boolean;
    activeTurns: number;
    lastError: string | null;
    progressReminderMs: number;
    model: string;
    reasoningEffort: string;
    reasoningEffortConfigurable: boolean;
    turnAutoApprovalConfigurable: boolean;
    trustedExecutionConfigurable: boolean;
    turnAutoApprovalModel: string;
    turnAutoApprovalModelConfigurable: boolean;
    turnAutoApprovalDataSourcesConfigurable: boolean;
    sandbox: string;
    approvalRecipientConfigured: boolean;
    trustedSenderCount: number;
    native: {
      available: boolean;
      refreshedAt: string | null;
      configuredModelAvailable: boolean | null;
      models: Array<{ id: string; displayName: string; efforts: string[]; inputModalities: string[] }>;
      skills: Array<{ name: string; scope: string; enabled: boolean }>;
      threads: Array<{ id: string; name: string | null; status: string; updatedAt: number | null }>;
    };
  };
  appSettings: {
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
  prompts: PromptSettings;
};

export type PromptKey = "larkAssistant" | "prReview" | "issueTriage" | "issueImplementation";

export type LarkCodexModel = { id: string; displayName: string; efforts: string[]; inputModalities: string[] };

export type PromptSettings = Record<PromptKey, {
  value: string;
  defaultValue: string;
  customized: boolean;
}>;

export type RuntimeConfig = {
  workspaceRoot: string;
  giteaBaseUrl: string;
  giteaBaseUrls: string[];
  giteaUser: string;
  larkExecutionApproverId: string;
  trustedLarkCodexSenderIds: string[];
};

export type LocalDiagnostic = {
  key: string;
  label: string;
  status: "pass" | "warn" | "fail";
  detail: string;
};

export type LocalRepository = {
  name: string;
  path: string;
  remote: string;
  repo: string | null;
};

export type LaunchAgentStatus = {
  supported: boolean;
  label: string;
  plistPath: string;
  installed: boolean;
  loaded: boolean;
  running: boolean;
  startDeferred: boolean;
  logDirectory: string;
};

export type LocalDataUsage = {
  databaseBytes: number;
  taskArtifactBytes: number;
  taskArtifactCount: number;
  larkArtifactBytes: number;
  larkArtifactCount: number;
  launchLogBytes: number;
  totalBytes: number;
};

export type LocalDataCleanupResult = {
  target: "completed-task-artifacts" | "launchd-logs";
  removedCount: number;
  reclaimedBytes: number;
  usage: LocalDataUsage;
};

export type LocalAuditEvent = {
  id: number;
  action: string;
  summary: string;
  details: string | null;
  created_at: string;
};

export type LocalBackup = {
  schemaVersion: 1;
  exportedAt: string;
  runtimeConfig: RuntimeConfig;
  appSettings: Settings["appSettings"];
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

export type LarkMessage = {
  id: number;
  direction: "inbound" | "outbound";
  senderType: string | null;
  recipientId: string | null;
  recipientName: string | null;
  messageAt: string;
  outboundSource: string | null;
  event_id: string | null;
  message_id: string | null;
  chat_id: string | null;
  chat_type: string | null;
  sender_id: string | null;
  sender_name?: string | null;
  sender_enterprise_email?: string | null;
  sender_department?: string | null;
  sender_p2p_chat_id?: string | null;
  message_type: string | null;
  content: string | null;
  reply_to_message_id: string | null;
  reply_to_message_type: string | null;
  reply_to_content: string | null;
  reply_to_raw_json?: string | null;
  mentioned: number;
  reply_trigger: "none" | "p2p" | "mention" | "spontaneous";
  reply_status: string;
  reply_error: string | null;
  codex_status: "skipped" | "queued" | "running" | "answered" | "no_reply" | "failed" | "timeout";
  codex_reply: string | null;
  codex_error: string | null;
  codex_session_id: string | null;
  codex_task_dir: string | null;
  codex_started_at: string | null;
  codex_finished_at: string | null;
  received_at: string;
  created_at: string;
};

export type LarkMessageListItem = Pick<LarkMessage,
  "id" | "direction" | "senderType" | "recipientId" | "recipientName" | "messageAt" | "outboundSource" |
  "message_id" | "chat_id" | "chat_type" | "sender_id" | "sender_name" |
  "sender_enterprise_email" | "sender_department" | "message_type" | "content" |
  "reply_to_message_id" | "reply_to_message_type" | "reply_to_content" | "mentioned" | "reply_trigger" |
  "reply_status" | "reply_error" | "codex_status" | "codex_reply" | "codex_error" |
  "codex_session_id" | "received_at"
>;

export type LarkMessageFilters = {
  senders: Array<{
    id: string;
    name: string | null;
    enterprise_email: string | null;
    department: string | null;
    message_count: number;
    group_count: number;
    p2p_count: number;
  }>;
  chats: Array<{
    id: string;
    chat_type: string | null;
    name: string | null;
    message_count: number;
    last_message_at: string;
  }>;
};

export type LarkMessageQuery = {
  afterId?: number;
  includeIds?: number[];
  chatType?: "group" | "p2p";
  senderId?: string;
  chatId?: string;
  status?: "active" | "answered" | "failed";
  query?: string;
};

export type LarkContactSyncResult = {
  scanned: number;
  upserted: number;
  hasMore: boolean;
};

export type LarkExecutionConfig = {
  schemaVersion: 1;
  recordedAt: string;
  threadId: string;
  turnId: string;
  action: "turn/start" | "turn/steer";
  model: string | null;
  reasoningEffort: string | null;
  approvalPolicy: string | null;
  sandbox: string | null;
  workspaceRoot: string | null;
  trustScope: "trusted" | "untrusted";
  persona: {
    mode: "default" | "custom";
    name: string;
    version: number;
    updatedAt: string | null;
  };
  globalPromptHash: string;
  source: "accepted-request";
};

export type LarkMessageDetail = LarkMessage & { executionConfigs?: LarkExecutionConfig[] };

export type LarkConversation = {
  chatType?: "group" | "p2p";
  chatId?: string | null;
  codexSessionIds?: string[];
  contactId: string;
  contactName: string | null;
  lastMessageAt: string;
  lastMessagePreview: string | null;
  messageCount: number;
  inboundCount: number;
  outboundCount: number;
};

export type LarkCodexSession = {
  sessionKey: string;
  trustScope: "trusted" | "untrusted";
  codexSessionId: string;
  createdAt?: string;
  resetAt?: string;
};
export type LarkCodexSessions = { active: LarkCodexSession[]; previous: LarkCodexSession[] };

export type ConversationPersona = {
  mode: "default" | "custom";
  name: string;
  instructions: string;
  version: number;
  updatedAt: string | null;
};
export type PersonaInput = Pick<ConversationPersona, "mode" | "name" | "instructions">;
export type ConversationStyle = {
  persona: ConversationPersona;
  globalPrompt: string;
  globalPromptHash: string;
  effectiveInstructions: string;
};
export type ConversationStickerUsage = {
  mode: "global" | "off" | "explicit" | "natural" | "always";
  effectiveMode: "off" | "explicit" | "natural" | "always";
  globalMode: "off" | "explicit" | "natural" | "always";
};
export type ConversationSpontaneousReply = {
  mode: "global" | "on" | "off";
  replyRate: number;
  cooldownMs: number;
  effectiveEnabled: boolean;
  effectiveReplyRate: number;
  effectiveCooldownMs: number;
  globalEnabled: boolean;
  globallyAllowed: boolean;
  globalReplyRate: number;
  globalCooldownMs: number;
};
export type ConversationSettings = { stickerUsage: ConversationStickerUsage; spontaneousReply: ConversationSpontaneousReply };

export type LarkConversationPagination = {
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
};

export type LarkConversationPage = {
  namesRefreshing?: boolean;
  items: LarkConversation[];
  pagination: LarkConversationPagination;
};

export type LarkConversationMessagesPage = {
  items: LarkMessageListItem[];
  pagination: {
    limit: number;
    hasMore: boolean;
    nextCursor?: string;
  };
};

export type LarkMessageArtifacts = {
  executionConfigs?: LarkExecutionConfig[];
  prompt: string | null;
  stdout: string | null;
  stderr: string | null;
  tmuxCapture: string | null;
  launcher: string | null;
  referencedImages: string | null;
  referencedFiles: string | null;
  imageDownloadError: string | null;
  fileDownloadError: string | null;
  trustedSender: string | null;
  resumeSession: string | null;
  outboundMedia: string | null;
  turnResult: string | null;
  receipts: Array<{ id: number; status: string; entries_json: string; card_message_id: string | null; delivery_status: string; delivery_attempts: number; delivery_error: string | null; created_at: string; updated_at: string }>;
  deliveries: Array<{ id: number; kind: string; status: string; attempts: number; last_error: string | null; sent_at: string | null; created_at: string }>;
  approvals: LarkExecutionApproval[];
};

export type LarkExecutionApproval = {
  id: number;
  approverId: string;
  operation: string;
  cwd: string | null;
  reason: string | null;
  status: "pending" | "approved" | "rejected" | "expired" | "failed";
  approvalScope: "once" | "turn";
  createdAt: string;
  decidedAt: string | null;
  expiresAt: string;
  cardError: string | null;
};

export type LarkMessageImage = {
  name: string;
  path: string;
  mimeType: string;
  dataUrl: string;
};

export type LarkMessageFile = {
  name: string;
  path: string;
  mimeType: string;
  size: number;
  text: string;
};

export type LarkSticker = {
  id: string;
  name: string;
  description: string;
  tags: string[];
  mimeType: string;
  sizeBytes: number;
  sourceUrl: string | null;
  sourceSite: string | null;
  enabled: boolean;
  usageCount: number;
  createdAt: string;
  updatedAt: string;
  imageUrl: string;
};

export type LarkStickerUpload = {
  name: string;
  description?: string;
  tags?: string[];
  fileName: string;
  mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "image/bmp";
  dataBase64: string;
  sourceUrl?: string;
  sourceSite?: string;
};

export type ApprovalHistoryItem = {
  id: number;
  kind: "auto" | "execution" | "capability";
  messageId: number;
  source: "history" | "model" | "manual";
  status: string;
  reason: string | null;
  requesterId: string | null;
  requesterName: string | null;
  approverId: string | null;
  approverName: string | null;
  taskType: string | null;
  target: string | null;
  model: string | null;
  matchedApprovalId: number | null;
  appliedAt: string | null;
  createdAt: string;
  completedAt: string | null;
  scope: string | null;
  requestPreview: string | null;
};
export type ApprovalHistoryDetail = ApprovalHistoryItem & {
  request: string | null;
  operation: string | null;
  cwd: string | null;
  turnId: string | null;
  sessionId: string | null;
  error: string | null;
  usage: Record<string, unknown> | null;
  matchedApproval: ApprovalHistoryDetail | null;
};
export type ApprovalHistoryPage = {
  items: ApprovalHistoryItem[];
  total: number;
  limit: number;
  offset: number;
  summary: { historyApproved: number; modelApproved: number; manualRequired: number; pendingHuman: number };
};

export type JobEvent = {
  id: number;
  job_id: number;
  level: string;
  message: string;
  created_at: string;
};

export type CodexTodoStatus = "todo" | "running" | "blocked" | "review" | "done" | "archived" | "monitoring" | "longterm";

export type CodexTodo = {
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
  job_status: string | null;
  job_mode: string | null;
  job_phase: string | null;
  job_task_dir: string | null;
  job_codex_session_id: string | null;
  issue_title: string | null;
  issue_kind: string | null;
  issue_external_id: string | null;
  issue_repo_owner: string | null;
  issue_repo_name: string | null;
  effective_codex_session_id: string | null;
  effective_codex_task_dir: string | null;
  codex_thread_url: string | null;
  runner_state: "running" | "completed" | "stopped" | "unknown";
  codex_unread: boolean;
};

export type CodexSessionSummary = {
  id: string;
  title: string;
  updated_at: string;
};

export type PullScope = "relevant" | "authored" | "review" | "all";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(path, {
    ...init,
    headers
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

export const api = {
  approvalHistory: (options: { kind: "auto" | "manual"; source?: string; status?: string; q?: string; offset: number }) => {
    const params = new URLSearchParams({ kind: options.kind, limit: "50", offset: String(options.offset) });
    for (const key of ["source", "status", "q"] as const) if (options[key]) params.set(key, options[key]);
    return request<ApprovalHistoryPage>(`/api/lark/approval-history?${params}`);
  },
  approvalHistoryDetail: (kind: ApprovalHistoryItem["kind"], id: number) => request<ApprovalHistoryDetail>(`/api/lark/approval-history/${kind}/${id}`),
  issues: () => request<Issue[]>("/api/issues"),
  pulls: (scope: PullScope = "relevant") => request<Issue[]>(`/api/pulls?scope=${encodeURIComponent(scope)}`),
  settings: () => request<Settings>("/api/settings"),
  larkModels: () => request<{ models: LarkCodexModel[] }>("/api/lark/models"),
  updateSettings: (patch: Partial<Settings["appSettings"]>) =>
    request<Settings["appSettings"]>("/api/settings", {
      method: "PATCH",
      body: JSON.stringify(patch)
    }),
  updatePrompts: (patch: Partial<Record<PromptKey, string | null>>) => request<PromptSettings>("/api/settings/prompts", {
    method: "PUT",
    body: JSON.stringify(patch)
  }),
  updateRuntimeConfig: (runtimeConfig: RuntimeConfig) => request<RuntimeConfig>("/api/settings/runtime-config", {
    method: "PUT",
    body: JSON.stringify(runtimeConfig)
  }),
  completeOnboarding: () => request<{ setupComplete: boolean; giteaConfigured: boolean }>("/api/settings/onboarding/complete", { method: "POST" }),
  localBackup: () => request<LocalBackup>("/api/settings/backup"),
  restoreLocalBackup: (backup: LocalBackup) => request<{ todos: number; auditEvents: number; setupComplete: boolean }>("/api/settings/backup/restore", {
    method: "POST",
    body: JSON.stringify(backup)
  }),
  diagnostics: (refresh = false) => request<LocalDiagnostic[]>(`/api/settings/diagnostics${refresh ? "?refresh=1" : ""}`),
  discoverRepositories: (refresh = false) => request<LocalRepository[]>(`/api/settings/repositories/discover${refresh ? "?refresh=1" : ""}`),
  updateGiteaRepositories: (repositories: string[]) => request<Settings["giteaSync"]>("/api/settings/repositories", {
    method: "PUT",
    body: JSON.stringify({ repositories })
  }),
  saveGiteaToken: (token: string) => request<{ stored: boolean; source: Settings["giteaCredential"]["source"] }>("/api/settings/gitea-token", {
    method: "POST",
    body: JSON.stringify({ token })
  }),
  launchAgent: () => request<LaunchAgentStatus>("/api/settings/launchd"),
  installLaunchAgent: () => request<LaunchAgentStatus>("/api/settings/launchd/install", { method: "POST" }),
  restartLaunchAgent: () => request<{ scheduled: boolean }>("/api/settings/launchd/restart", { method: "POST" }),
  uninstallLaunchAgent: () => request<{ scheduled: boolean }>("/api/settings/launchd/uninstall", { method: "POST" }),
  localDataUsage: () => request<LocalDataUsage>("/api/settings/local-data"),
  cleanupLocalData: (target: "completed-task-artifacts" | "launchd-logs", olderThanDays: number) => request<LocalDataCleanupResult>("/api/settings/local-data/cleanup", {
    method: "POST",
    body: JSON.stringify({ target, olderThanDays })
  }),
  localAudit: (limit = 30) => request<LocalAuditEvent[]>(`/api/settings/audit?limit=${limit}`),
  notifications: () => request<Notification[]>("/api/notifications"),
  larkMessages: (options: LarkMessageQuery = {}) => {
    const params = new URLSearchParams();
    if (options.afterId) params.set("after_id", String(options.afterId));
    if (options.includeIds && options.includeIds.length > 0) params.set("include_ids", options.includeIds.join(","));
    if (options.chatType) params.set("chat_type", options.chatType);
    if (options.senderId) params.set("sender_id", options.senderId);
    if (options.chatId) params.set("chat_id", options.chatId);
    if (options.status) params.set("status", options.status);
    if (options.query?.trim()) params.set("q", options.query.trim());
    const suffix = params.toString() ? `?${params.toString()}` : "";
    return request<LarkMessageListItem[]>(`/api/lark/messages${suffix}`);
  },
  larkMessageFilters: () => request<LarkMessageFilters>("/api/lark/messages/filters"),
  larkConversations: (options: { keyword?: string; limit?: number; offset?: number; chatType?: "group" | "p2p" } = {}) => {
    const params = new URLSearchParams();
    if (options.chatType) params.set("chat_type", options.chatType);
    if (options.keyword?.trim()) params.set("keyword", options.keyword.trim());
    if (options.limit) params.set("limit", String(options.limit));
    if (options.offset !== undefined) params.set("offset", String(options.offset));
    const suffix = params.toString() ? `?${params.toString()}` : "";
    return request<LarkConversationPage>(`/api/lark/conversations${suffix}`);
  },
  larkConversationMessages: (contactId: string, options: { cursor?: string; limit?: number } = {}) => {
    const params = new URLSearchParams();
    if (options.cursor) params.set("cursor", options.cursor);
    if (options.limit) params.set("limit", String(options.limit));
    const suffix = params.toString() ? `?${params.toString()}` : "";
    return request<LarkConversationMessagesPage>(`/api/lark/conversations/${encodeURIComponent(contactId)}/messages${suffix}`);
  },
  larkCodexSessions: (chatId: string) => request<LarkCodexSessions>(`/api/lark/conversations/${encodeURIComponent(chatId)}/sessions`),
  resetLarkCodexSession: (chatId: string, sessionKey: string, expectedSessionId: string) => request<{ sessionKey: string; oldSessionId: string; resetAt: string }>(`/api/lark/conversations/${encodeURIComponent(chatId)}/sessions/reset`, { method: "POST", body: JSON.stringify({ sessionKey, expectedSessionId }) }),
  larkMessage: (id: number) => request<LarkMessageDetail>(`/api/lark/messages/${id}`),
  larkPersona: (chatId: string) => request<ConversationStyle>(`/api/lark/chats/${encodeURIComponent(chatId)}/persona`),
  saveLarkPersona: (chatId: string, input: PersonaInput) => request<ConversationStyle>(`/api/lark/chats/${encodeURIComponent(chatId)}/persona`, { method: "PUT", body: JSON.stringify({ mode: input.mode, name: input.name, instructions: input.instructions }) }),
  previewLarkPersona: (chatId: string, input: PersonaInput) => request<ConversationStyle>(`/api/lark/chats/${encodeURIComponent(chatId)}/persona/preview`, { method: "POST", body: JSON.stringify({ mode: input.mode, name: input.name, instructions: input.instructions }) }),
  larkConversationSettings: (chatId: string) => request<ConversationSettings>(`/api/lark/chats/${encodeURIComponent(chatId)}/settings`),
  updateLarkConversationSettings: (chatId: string, stickerUsageMode: ConversationStickerUsage["mode"]) => request<ConversationSettings>(`/api/lark/chats/${encodeURIComponent(chatId)}/settings`, { method: "PATCH", body: JSON.stringify({ stickerUsageMode }) }),
  updateLarkSpontaneousReply: (chatId: string, input: { spontaneousMode: ConversationSpontaneousReply["mode"]; spontaneousReplyRate?: number; spontaneousReplyCooldownMs?: number }) => request<ConversationSettings>(`/api/lark/chats/${encodeURIComponent(chatId)}/settings`, { method: "PATCH", body: JSON.stringify(input) }),
  larkMessageArtifacts: (id: number) => request<LarkMessageArtifacts>(`/api/lark/messages/${id}/artifacts`),
  larkMessageImages: (id: number) => request<LarkMessageImage[]>(`/api/lark/messages/${id}/images`),
  larkMessageFiles: (id: number) => request<LarkMessageFile[]>(`/api/lark/messages/${id}/files`),
  syncLarkContacts: () => request<LarkContactSyncResult>("/api/lark/contacts/sync", { method: "POST" }),
  larkStickers: () => request<LarkSticker[]>("/api/lark/stickers"),
  uploadLarkStickers: (files: LarkStickerUpload[]) => request<LarkSticker[]>("/api/lark/stickers/batch", {
    method: "POST",
    body: JSON.stringify({ files })
  }),
  updateLarkSticker: (id: string, patch: Partial<Pick<LarkSticker, "name" | "description" | "tags" | "enabled">>) =>
    request<LarkSticker>(`/api/lark/stickers/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch)
    }),
  deleteLarkSticker: (id: string) => request<void>(`/api/lark/stickers/${encodeURIComponent(id)}`, { method: "DELETE" }),
  markNotificationRead: (id: number) => request<Notification>(`/api/notifications/${id}/read`, { method: "POST" }),
  issue: (id: number) => request<Issue>(`/api/issues/${id}`),
  sync: () => request<{ scanned: number; upserted: number; filtered: number; pullsScanned?: number }>("/api/issues/sync", { method: "POST" }),
  issueJobs: (id: number) => request<RepairJob[]>(`/api/issues/${id}/jobs`),
  repair: (id: number, repoHint?: string, mode: "review_only" | "issue_triage" | "issue_implementation" | "reviewed_pr" = "issue_triage", approveTriagePlan = false) =>
    request<RepairJob>(`/api/issues/${id}/repair`, {
      method: "POST",
      body: JSON.stringify({ mode, repoHint, approveTriagePlan })
    }),
  job: (id: number) => request<RepairJob>(`/api/jobs/${id}`),
  jobs: (updatedAfter?: string) => request<RepairRun[]>(updatedAfter ? `/api/jobs?updated_after=${encodeURIComponent(updatedAfter)}` : "/api/jobs"),
  jobEvents: (id: number) => request<JobEvent[]>(`/api/jobs/${id}/events`),
  todos: () => request<CodexTodo[]>("/api/todos"),
  codexSessions: (query?: string) => {
    const params = new URLSearchParams();
    if (query?.trim()) {
      params.set("q", query.trim());
      params.set("limit", "50");
    }
    const suffix = params.toString() ? `?${params.toString()}` : "";
    return request<CodexSessionSummary[]>(`/api/codex/sessions${suffix}`);
  },
  createTodo: (payload: { title: string; description?: string | null; status?: CodexTodoStatus; codexSessionId?: string | null; codexTaskDir?: string | null }) =>
    request<CodexTodo>("/api/todos", {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  updateTodo: (id: number, patch: Partial<{ title: string; description: string | null; status: CodexTodoStatus; codexSessionId: string | null; codexTaskDir: string | null }>) =>
    request<CodexTodo>(`/api/todos/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch)
    }),
  deleteTodo: (id: number) => request<void>(`/api/todos/${id}`, { method: "DELETE" })
};
