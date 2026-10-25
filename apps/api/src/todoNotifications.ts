import { createHash } from "node:crypto";
import { config } from "./config.js";
import { larkAgentRequest } from "./larkAgentIntegration.js";
import {
  activeTodoWorkflowViews,
  listTodoWorkflowViews,
  nextTodoReminder,
  notificationState,
  setNotificationState,
  todoWorkflowView,
  updateTodoDelivery,
  type TodoWorkflowView
} from "./todoWorkflow.js";
import { nowIso } from "./time.js";

let reminderTimer: NodeJS.Timeout | undefined;
let reminderActive = false;
const notificationRetryDelayMs = 15 * 60 * 1000;

export type TodoOutboundSender = (payload: Record<string, unknown>) => Promise<void>;

function localParts(date: Date): { date: string; hour: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: config.todoReminderTimeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return { date: `${value("year")}-${value("month")}-${value("day")}`, hour: Number(value("hour")) };
}

function displayDate(value: string | null): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "未设置";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: config.todoReminderTimeZone,
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).format(new Date(value));
}

function priorityLabel(todo: TodoWorkflowView): string {
  return { urgent: "紧急", high: "高", normal: "普通", low: "低" }[todo.priority];
}

function sourceLabel(todo: TodoWorkflowView): string {
  if (todo.source_lark_message_id) return todo.source_chat_type === "group" ? "飞书群聊" : "飞书联系人";
  if (todo.source_type === "issue_repair") return "Issue 修复";
  return "手动创建";
}

function idempotencyKey(kind: string, seed: string): string {
  return `forge-${kind}-${createHash("sha1").update(seed).digest("hex").slice(0, 20)}`;
}

async function sendOutbound(payload: Record<string, unknown>): Promise<void> {
  if (!config.larkAgentUrl) throw new Error("Lark Agent Runtime is not configured");
  await larkAgentRequest("/v1/internal/outbound", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
}

export async function notifyTodoOwner(todoId: number, outbound: TodoOutboundSender = sendOutbound): Promise<boolean> {
  const todo = todoWorkflowView(todoId);
  const recipient = config.larkExecutionApproverId.trim();
  if (!todo || !todo.source_lark_message_id || !recipient) return false;
  if (todo.owner_notified_at) return true;
  const text = [
    `📥 新待办 #${todo.id} · ${priorityLabel(todo)}优先级`,
    todo.title,
    `来源：${sourceLabel(todo)}`,
    `截止：${displayDate(todo.due_at)}`,
    todo.tags.length ? `标签：${todo.tags.join("、")}` : ""
  ].filter(Boolean).join("\n");
  try {
    await outbound({ recipient, text, idempotencyKey: idempotencyKey("todo-assigned", String(todo.id)) });
    updateTodoDelivery(todo.id, { owner_notified_at: nowIso(), owner_notification_error: null });
    return true;
  } catch (error) {
    updateTodoDelivery(todo.id, {
      owner_notification_error: error instanceof Error ? error.message.slice(0, 1_000) : String(error).slice(0, 1_000)
    });
    return false;
  }
}

export async function notifyTodoCompletion(todoId: number, outbound: TodoOutboundSender = sendOutbound): Promise<boolean> {
  const todo = todoWorkflowView(todoId);
  if (!todo?.source_lark_message_id || !todo.completion_result || !todo.notify_on_completion) return false;
  if (todo.notified_at) return true;
  try {
    await outbound({
      replyToLarkMessageId: todo.source_lark_message_id,
      text: `待办 #${todo.id}「${todo.title}」已完成。\n结果：${todo.completion_result}`,
      idempotencyKey: idempotencyKey("todo-completed", `${todo.id}:${todo.completed_at ?? "done"}`)
    });
    updateTodoDelivery(todo.id, { notified_at: nowIso(), notification_error: null });
    return true;
  } catch (error) {
    updateTodoDelivery(todo.id, {
      notification_error: error instanceof Error ? error.message.slice(0, 1_000) : String(error).slice(0, 1_000)
    });
    return false;
  }
}

function digestText(todos: TodoWorkflowView[], date: string): string {
  const lines = todos.slice(0, 20).map((todo) =>
    `- #${todo.id} [${priorityLabel(todo)}] ${todo.title} · 截止 ${displayDate(todo.due_at)}`
  );
  return [
    `☀️ ${date} 待办日报`,
    `未完成 ${todos.length} 项。`,
    ...lines,
    todos.length > 20 ? `- 另有 ${todos.length - 20} 项，请到 Forge 查看。` : ""
  ].filter(Boolean).join("\n");
}

async function sendDailyDigest(now: Date, todos: TodoWorkflowView[], outbound: TodoOutboundSender): Promise<void> {
  const recipient = config.larkExecutionApproverId.trim();
  const local = localParts(now);
  const retryAt = Date.parse(notificationState("todo.digest.retryAt") ?? "");
  if (!recipient || local.hour < config.todoDigestHour || local.hour >= config.todoReminderEndHour || notificationState("todo.digest.date") === local.date || (Number.isFinite(retryAt) && retryAt > now.getTime())) return;
  try {
    await outbound({
      recipient,
      text: digestText(todos, local.date),
      idempotencyKey: idempotencyKey("todo-digest", local.date)
    });
    setNotificationState("todo.digest.date", local.date);
    setNotificationState("todo.digest.error", "");
    setNotificationState("todo.digest.retryAt", "");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setNotificationState("todo.digest.error", message.slice(0, 1_000));
    setNotificationState("todo.digest.retryAt", new Date(now.getTime() + notificationRetryDelayMs).toISOString());
  }
}

async function sendDueReminders(now: Date, todos: TodoWorkflowView[], outbound: TodoOutboundSender): Promise<void> {
  const recipient = config.larkExecutionApproverId.trim();
  const { hour } = localParts(now);
  if (!recipient || hour < config.todoReminderStartHour || hour >= config.todoReminderEndHour) return;
  for (const todo of todos.filter((item) => item.next_reminder_at && Date.parse(item.next_reminder_at) <= now.getTime()).slice(0, 20)) {
    try {
      await outbound({
        recipient,
        text: `⏰ 待办提醒 #${todo.id} · ${priorityLabel(todo)}优先级\n${todo.title}\n截止：${displayDate(todo.due_at)}\n来源：${sourceLabel(todo)}`,
        idempotencyKey: idempotencyKey("todo-reminder", `${todo.id}:${todo.next_reminder_at}`)
      });
      updateTodoDelivery(todo.id, {
        last_reminded_at: nowIso(),
        next_reminder_at: nextTodoReminder(todo.reminder_frequency, now),
        owner_notification_error: null
      });
    } catch (error) {
      const retryAt = new Date(now.getTime() + notificationRetryDelayMs).toISOString();
      updateTodoDelivery(todo.id, {
        next_reminder_at: retryAt,
        owner_notification_error: error instanceof Error ? error.message.slice(0, 1_000) : String(error).slice(0, 1_000)
      });
    }
  }
}

export async function runTodoNotificationTick(now = new Date(), outbound: TodoOutboundSender = sendOutbound): Promise<void> {
  if (reminderActive) return;
  reminderActive = true;
  try {
    const todos = activeTodoWorkflowViews();
    for (const todo of todos.filter((item) => item.source_lark_message_id && !item.owner_notified_at).slice(0, 20)) {
      await notifyTodoOwner(todo.id, outbound);
    }
    for (const todo of listTodoWorkflowViews().filter((item) =>
      item.status === "done"
      && item.source_lark_message_id
      && item.completion_result
      && item.notify_on_completion
      && !item.notified_at
    ).slice(0, 20)) {
      await notifyTodoCompletion(todo.id, outbound);
    }
    await sendDailyDigest(now, todos, outbound);
    await sendDueReminders(now, todos, outbound);
  } finally {
    reminderActive = false;
  }
}

function runTodoNotificationTickSafely(): void {
  void runTodoNotificationTick().catch((error) => {
    console.warn(`Todo notification tick failed: ${error instanceof Error ? error.message : String(error)}`);
  });
}

export function startTodoNotificationWorker(): void {
  if (reminderTimer) return;
  runTodoNotificationTickSafely();
  reminderTimer = setInterval(runTodoNotificationTickSafely, Math.max(10_000, config.todoReminderPollIntervalMs));
}

export function stopTodoNotificationWorker(): void {
  if (reminderTimer) clearInterval(reminderTimer);
  reminderTimer = undefined;
}
