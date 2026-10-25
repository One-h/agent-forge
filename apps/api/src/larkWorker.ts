import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { config } from "./config.js";
import { db, getAppSettings } from "./db.js";
import { decideLarkExecutionApprovalFromCard, enqueueLarkCodexReply } from "./larkCodexResponder.js";
import { backfillLarkContactsFromMessageMentions, upsertLarkContactsFromMentions } from "./larkContacts.js";
import { sendLarkReaction } from "./larkReply.js";
import { defaultLarkAcknowledgeReactionEmoji, isLarkReactionEmojiType, larkReactionEmojiTypes } from "./larkReactionEmojis.js";
import { nowIso } from "./time.js";

const messageConsumeCommand = "tail -f /dev/null | lark-cli event consume im.message.receive_v1 --as bot";
const approvalConsumeCommand = "tail -f /dev/null | lark-cli event consume card.action.trigger --as bot";

type LarkEvent = Record<string, unknown>;

type ListenerKind = "message" | "approval";

type ListenerState = {
  command: string;
  label: string;
  consumer: ChildProcessWithoutNullStreams | null;
  stdoutBuffer: string;
  restartTimer: NodeJS.Timeout | undefined;
  handleLine: (line: string) => void;
};

const listeners = {} as Record<ListenerKind, ListenerState>;
let intentionallyStopped = false;
let currentBotOpenId: string | undefined;
let botOpenIdRetryAfterMs = 0;
const botOpenIdRetryDelayMs = 5_000;

function cleanupStaleConsumers(): void {
  const result = spawnSync("ps", ["-axo", "pid,ppid,pgid,command"], { encoding: "utf8" });
  if (result.status !== 0) {
    return;
  }
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
    if (!match) {
      continue;
    }
    const [, pidText, ppidText, pgidText, command] = match;
    if (Number(ppidText) !== 1 || ![messageConsumeCommand, approvalConsumeCommand].some((candidate) => command.includes(`sh -lc ${candidate}`))) {
      continue;
    }
    const pgid = Number(pgidText);
    if (!Number.isFinite(pgid) || pgid <= 0 || pgid === process.pid) {
      continue;
    }
    try {
      process.kill(-pgid, "SIGTERM");
      console.warn(`Cleaned stale Lark message listener process group ${pgid} (pid ${pidText})`);
    } catch (error) {
      console.warn(`Failed to clean stale Lark listener ${pidText}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function eventMentions(event: LarkEvent): unknown[] {
  const mentions = event.mentions;
  if (Array.isArray(mentions)) {
    return mentions;
  }
  const rawEvent = event.event;
  if (rawEvent && typeof rawEvent === "object") {
    const message = (rawEvent as { message?: { mentions?: unknown } }).message;
    return Array.isArray(message?.mentions) ? message.mentions : [];
  }
  return [];
}

function mentionIdentifier(value: unknown): string | null {
  if (typeof value === "string") return stringValue(value);
  if (!value || typeof value !== "object") return null;
  const nested = value as { open_id?: unknown; openId?: unknown; user_id?: unknown; userId?: unknown };
  return stringValue(nested.open_id) ?? stringValue(nested.openId) ?? stringValue(nested.user_id) ?? stringValue(nested.userId);
}

export function larkBotOpenIdFromAuthStatus(stdout: string): string | null {
  try {
    const parsed = JSON.parse(stdout) as { identities?: { bot?: { openId?: unknown; open_id?: unknown } } };
    return stringValue(parsed.identities?.bot?.openId) ?? stringValue(parsed.identities?.bot?.open_id);
  } catch {
    return null;
  }
}

function resolveCurrentBotOpenId(): string | null {
  if (currentBotOpenId) {
    return currentBotOpenId;
  }
  if (Date.now() < botOpenIdRetryAfterMs) {
    return null;
  }
  const result = spawnSync("lark-cli", ["auth", "status", "--json", "--verify"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
      LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1"
    }
  });
  const resolved = result.status === 0 ? larkBotOpenIdFromAuthStatus(result.stdout) : null;
  if (resolved) {
    currentBotOpenId = resolved;
    botOpenIdRetryAfterMs = 0;
    return resolved;
  }
  botOpenIdRetryAfterMs = Date.now() + botOpenIdRetryDelayMs;
  if (!resolved) {
    console.warn(`Unable to resolve current Lark bot open_id: ${(result.stderr || result.stdout || "lark-cli auth status failed").trim()}`);
  }
  return null;
}

export function isAtMeMessage(event: LarkEvent, botOpenId = resolveCurrentBotOpenId()): boolean {
  if (event.chat_type === "p2p") {
    return true;
  }
  const mentions = eventMentions(event);
  if (!botOpenId) {
    return false;
  }
  return mentions.some((mention) => {
    if (!mention || typeof mention !== "object") {
      return false;
    }
    const value = mention as { id?: unknown; open_id?: unknown; openId?: unknown };
    return mentionIdentifier(value.id) === botOpenId
      || mentionIdentifier(value.open_id) === botOpenId
      || mentionIdentifier(value.openId) === botOpenId;
  });
}

export function shouldStartSpontaneousLarkReply(
  event: LarkEvent,
  explicitlyMentioned: boolean,
  hasRecentReply: boolean,
  randomValue = Math.random(),
  enabled = getAppSettings().larkGroupSpontaneousRepliesEnabled,
  rate = getAppSettings().larkGroupSpontaneousReplyRate,
  allowedChatIds = getAppSettings().larkGroupSpontaneousChatIds
): boolean {
  const normalizedRate = Math.max(0, Math.min(1, rate));
  return enabled
    && typeof event.chat_id === "string"
    && allowedChatIds.includes(event.chat_id)
    && !explicitlyMentioned
    && !hasRecentReply
    && event.chat_type === "group"
    && event.sender_type === "user"
    && event.message_type === "text"
    && Boolean(stringValue(event.content))
    && randomValue < normalizedRate;
}

function hasRecentHandledLarkMessage(chatId: string | null, nowMs = Date.now()): boolean {
  const cooldownMs = getAppSettings().larkGroupSpontaneousReplyCooldownMs;
  if (!chatId || cooldownMs <= 0) return false;
  const cutoff = new Date(nowMs - cooldownMs).toISOString();
  return Boolean(db.prepare(`
    SELECT 1
    FROM lark_messages
    WHERE chat_id = ?
      AND mentioned = 1
      AND received_at >= ?
      AND codex_status IN ('queued', 'running', 'answered', 'no_reply')
    LIMIT 1
  `).get(chatId, cutoff));
}

function acknowledgeMessage(messageId: string): { ok: true } | { ok: false; error: string } {
  const selected = getAppSettings().larkAcknowledgeReactionEmoji;
  return sendLarkReaction(messageId, isLarkReactionEmojiType(selected) ? selected : defaultLarkAcknowledgeReactionEmoji);
}

type LarkMessageSnapshot = {
  message_id?: string;
  msg_type?: string;
  message_type?: string;
  content?: string;
  reply_to?: string;
};

type LarkReplyContext = {
  replyToMessageId: string | null;
  replyToMessageType: string | null;
  replyToContent: string | null;
  replyToRawJson: string | null;
};

function firstFetchedMessage(stdout: string): LarkMessageSnapshot | null {
  try {
    const parsed = JSON.parse(stdout) as { data?: { messages?: unknown } };
    const messages = parsed.data?.messages;
    return Array.isArray(messages) && messages[0] && typeof messages[0] === "object" ? messages[0] as LarkMessageSnapshot : null;
  } catch {
    return null;
  }
}

function fetchLarkMessage(messageId: string): LarkMessageSnapshot | null {
  const result = spawnSync("lark-cli", ["im", "+messages-mget", "--as", "bot", "--message-ids", messageId, "--format", "json"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  if (result.status !== 0) {
    console.warn(`Unable to fetch Lark message ${messageId}: ${(result.stderr || result.stdout).trim()}`);
    return null;
  }
  return firstFetchedMessage(result.stdout);
}

function resolveReplyContext(messageId: string | null): LarkReplyContext {
  if (!messageId) {
    return { replyToMessageId: null, replyToMessageType: null, replyToContent: null, replyToRawJson: null };
  }
  const currentMessage = fetchLarkMessage(messageId);
  const replyToMessageId = stringValue(currentMessage?.reply_to);
  if (!replyToMessageId) {
    return { replyToMessageId: null, replyToMessageType: null, replyToContent: null, replyToRawJson: null };
  }
  const repliedMessage = fetchLarkMessage(replyToMessageId);
  return {
    replyToMessageId,
    replyToMessageType: stringValue(repliedMessage?.msg_type) ?? stringValue(repliedMessage?.message_type),
    replyToContent: stringValue(repliedMessage?.content),
    replyToRawJson: repliedMessage ? JSON.stringify(repliedMessage) : null
  };
}

function persistLarkEvent(event: LarkEvent): void {
  const eventId = stringValue(event.event_id);
  const messageId = stringValue(event.message_id) ?? stringValue(event.id);
  const directlyMentioned = isAtMeMessage(event);
  const chatId = stringValue(event.chat_id);
  const spontaneous = shouldStartSpontaneousLarkReply(event, directlyMentioned, hasRecentHandledLarkMessage(chatId));
  const shouldRespond = directlyMentioned || spontaneous;
  const replyTrigger = spontaneous ? "spontaneous" : event.chat_type === "p2p" ? "p2p" : directlyMentioned ? "mention" : "none";
  const replyContext = resolveReplyContext(messageId);
  upsertLarkContactsFromMentions(eventMentions(event));
  let replyStatus = shouldRespond ? "pending" : "skipped";
  let replyError: string | null = null;

  if (directlyMentioned && messageId) {
    const reply = acknowledgeMessage(messageId);
    replyStatus = reply.ok ? "sent" : "failed";
    replyError = reply.ok ? null : reply.error;
  } else if (shouldRespond && !messageId) {
    replyStatus = "failed";
    replyError = "Missing message_id for Lark reply";
  }

  const receivedAt = nowIso();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO lark_messages (
      event_id, message_id, chat_id, chat_type, sender_id, message_type, content,
      reply_to_message_id, reply_to_message_type, reply_to_content, reply_to_raw_json,
      mentioned, reply_trigger, reply_status, reply_error, raw_json, received_at, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    eventId,
    messageId,
    chatId,
    stringValue(event.chat_type),
    stringValue(event.sender_id),
    stringValue(event.message_type),
    stringValue(event.content),
    replyContext.replyToMessageId,
    replyContext.replyToMessageType,
    replyContext.replyToContent,
    replyContext.replyToRawJson,
    shouldRespond ? 1 : 0,
    replyTrigger,
    replyStatus,
    replyError,
    JSON.stringify(event),
    receivedAt,
    receivedAt
  );
  if (insert.changes === 0) {
    const keyColumn = messageId ? "message_id" : "event_id";
    const keyValue = messageId ?? eventId;
    if (!keyValue) {
      return;
    }
    db.prepare(`
      UPDATE lark_messages
      SET event_id = COALESCE(?, event_id),
          chat_id = ?,
          chat_type = ?,
          sender_id = ?,
          message_type = ?,
          content = ?,
          reply_to_message_id = ?,
          reply_to_message_type = ?,
          reply_to_content = ?,
          reply_to_raw_json = ?,
          mentioned = ?,
          reply_trigger = ?,
          reply_status = ?,
          reply_error = ?,
          codex_status = CASE WHEN ? = 1 THEN codex_status ELSE 'skipped' END,
          raw_json = ?,
          received_at = ?
      WHERE ${keyColumn} = ?
    `).run(
      eventId,
      chatId,
      stringValue(event.chat_type),
      stringValue(event.sender_id),
      stringValue(event.message_type),
      stringValue(event.content),
      replyContext.replyToMessageId,
      replyContext.replyToMessageType,
      replyContext.replyToContent,
      replyContext.replyToRawJson,
      shouldRespond ? 1 : 0,
      replyTrigger,
      replyStatus,
      replyError,
      shouldRespond ? 1 : 0,
      JSON.stringify(event),
      receivedAt,
      keyValue
    );
  }
  if (shouldRespond) {
    const row = db.prepare("SELECT id FROM lark_messages WHERE message_id = ? OR event_id = ? ORDER BY id DESC LIMIT 1").get(messageId, eventId) as { id: number } | undefined;
    if (row) {
      enqueueLarkCodexReply(row.id);
    }
  }
}

function handleLine(line: string): void {
  const trimmed = line.trim();
  if (!trimmed) {
    return;
  }
  try {
    persistLarkEvent(JSON.parse(trimmed) as LarkEvent);
  } catch (error) {
    console.warn(`Lark message event skipped: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export type LarkExecutionApprovalAction = {
  token: string;
  decision: "approve" | "approve-turn" | "reject";
};

export function parseLarkExecutionApprovalAction(event: LarkEvent): LarkExecutionApprovalAction | null {
  if (event.action_tag !== "button") {
    return null;
  }
  let value: unknown = event.action_value;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object") {
    return null;
  }
  const action = stringValue((value as Record<string, unknown>).action);
  const token = stringValue((value as Record<string, unknown>).approval_token);
  if (!token || (action !== "approve" && action !== "approve-turn" && action !== "reject")) {
    return null;
  }
  return { token, decision: action };
}

function handleApprovalLine(line: string): void {
  const trimmed = line.trim();
  if (!trimmed) {
    return;
  }
  try {
    const event = JSON.parse(trimmed) as LarkEvent;
    const action = parseLarkExecutionApprovalAction(event);
    if (!action) {
      console.warn("Lark approval callback skipped: unsupported card action");
      return;
    }
    const operatorId = stringValue(event.operator_id);
    const messageId = stringValue(event.message_id);
    if (!operatorId || !messageId) {
      console.warn("Lark approval callback skipped: missing operator_id or message_id");
      return;
    }
    const result = decideLarkExecutionApprovalFromCard({
      token: action.token,
      decision: action.decision,
      operatorId,
      messageId
    });
    if (!result.ok) {
      console.warn(`Lark approval callback rejected: ${result.status}`);
    }
  } catch (error) {
    console.warn(`Lark approval callback skipped: ${error instanceof Error ? error.message : String(error)}`);
  }
}

listeners.message = {
  command: messageConsumeCommand,
  label: "message",
  consumer: null,
  stdoutBuffer: "",
  restartTimer: undefined,
  handleLine
};
listeners.approval = {
  command: approvalConsumeCommand,
  label: "approval",
  consumer: null,
  stdoutBuffer: "",
  restartTimer: undefined,
  handleLine: handleApprovalLine
};

function scheduleRestart(kind: ListenerKind): void {
  const listener = listeners[kind];
  if (intentionallyStopped || !getAppSettings().larkMessageListenerEnabled || listener.restartTimer) {
    return;
  }
  listener.restartTimer = setTimeout(() => {
    listener.restartTimer = undefined;
    startListener(kind);
  }, 5000);
}

function startListener(kind: ListenerKind): void {
  const listener = listeners[kind];
  if (listener.consumer || intentionallyStopped || !getAppSettings().larkMessageListenerEnabled) {
    return;
  }
  listener.stdoutBuffer = "";
  const child = spawn("sh", ["-lc", listener.command], {
    cwd: process.cwd(),
    detached: true,
    env: process.env
  });
  listener.consumer = child;
  console.log(`Started Lark ${listener.label} listener: ${listener.command}`);

  child.stdout.on("data", (chunk: Buffer) => {
    listener.stdoutBuffer += chunk.toString();
    const lines = listener.stdoutBuffer.split(/\r?\n/);
    listener.stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      listener.handleLine(line);
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (text) {
      console.warn(`Lark ${listener.label} listener: ${text}`);
    }
  });
  child.on("error", (error) => {
    console.warn(`Lark ${listener.label} listener failed: ${error.message}`);
  });
  child.on("close", (code) => {
    console.warn(`Lark ${listener.label} listener exited with code ${code}`);
    if (listener.consumer === child) {
      listener.consumer = null;
    }
    scheduleRestart(kind);
  });
}

export function startLarkMessageWorker(): void {
  if (config.larkAgentUrl) {
    stopLarkMessageWorker();
    return;
  }
  if (!getAppSettings().larkMessageListenerEnabled) {
    return;
  }
  if (process.env.LARK_MESSAGE_LISTENER_RUNTIME === "false") {
    console.warn("Lark message listener runtime is disabled by LARK_MESSAGE_LISTENER_RUNTIME=false");
    return;
  }
  cleanupStaleConsumers();
  const contactBackfill = backfillLarkContactsFromMessageMentions();
  if (contactBackfill.upserted > 0) {
    console.log(`Discovered ${contactBackfill.upserted} Lark contact mentions from ${contactBackfill.scanned} stored messages`);
  }
  intentionallyStopped = false;
  startListener("message");
  startListener("approval");
}

export function stopLarkMessageWorker(): void {
  intentionallyStopped = true;
  for (const listener of Object.values(listeners)) {
    if (listener.restartTimer) {
      clearTimeout(listener.restartTimer);
      listener.restartTimer = undefined;
    }
    if (!listener.consumer) {
      continue;
    }
    if (listener.consumer.pid) {
      try {
        process.kill(-listener.consumer.pid, "SIGTERM");
      } catch {
        listener.consumer.kill("SIGTERM");
      }
    } else {
      listener.consumer.kill("SIGTERM");
    }
    listener.consumer = null;
  }
}

export function reconcileLarkMessageWorker(): void {
  if (getAppSettings().larkMessageListenerEnabled) {
    startLarkMessageWorker();
  } else {
    stopLarkMessageWorker();
  }
}

export function larkMessageWorkerStatus(): {
  enabled: boolean;
  running: boolean;
  command: string;
  approvalRunning: boolean;
  approvalCommand: string;
  acknowledgeReactionEmoji: string;
  acknowledgeReactionOptions: string[];
} {
  return {
    enabled: getAppSettings().larkMessageListenerEnabled,
    running: Boolean(listeners.message.consumer) && Boolean(listeners.approval.consumer),
    command: messageConsumeCommand,
    approvalRunning: Boolean(listeners.approval.consumer),
    approvalCommand: approvalConsumeCommand,
    acknowledgeReactionEmoji: getAppSettings().larkAcknowledgeReactionEmoji,
    acknowledgeReactionOptions: larkReactionEmojiTypes
  };
}
