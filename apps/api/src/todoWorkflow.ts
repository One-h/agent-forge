import { createManualCodexTodo, listCodexTodos, updateCodexTodo, type CodexTodoView } from "./codexTodos.js";
import { appSettingValue, setAppSettingValue } from "./db.js";
import { nowIso } from "./time.js";

export const todoPriorities = ["urgent", "high", "normal", "low"] as const;
export const todoReminderFrequencies = ["none", "every_2_hours", "daily", "weekly"] as const;

export type TodoPriority = typeof todoPriorities[number];
export type TodoReminderFrequency = typeof todoReminderFrequencies[number];

export type TodoWorkflowPatch = {
  priority?: TodoPriority;
  tags?: string[];
  dueAt?: string | null;
  reminderFrequency?: TodoReminderFrequency;
  completionResult?: string | null;
  notifyOnCompletion?: boolean;
};

export type LarkTodoContext = {
  larkMessageId: number;
  chatId: string | null;
  chatType: string | null;
  senderId: string | null;
};

export type TodoWorkflowMetadata = {
  todo_id: number;
  priority: TodoPriority;
  tags: string;
  due_at: string | null;
  reminder_frequency: TodoReminderFrequency;
  next_reminder_at: string | null;
  source_lark_message_id: number | null;
  source_chat_id: string | null;
  source_chat_type: string | null;
  source_sender_id: string | null;
  completion_result: string | null;
  completed_at: string | null;
  notify_on_completion: number;
  notified_at: string | null;
  notification_error: string | null;
  owner_notified_at: string | null;
  owner_notification_error: string | null;
  last_reminded_at: string | null;
  created_at: string;
  updated_at: string;
};

export type TodoWorkflowView = CodexTodoView & Omit<TodoWorkflowMetadata, "tags"> & { tags: string[] };

const metadataSettingKey = "todoWorkflowMetadataV1";
const notificationSettingPrefix = "todoNotification.";
const activeStatuses = ["todo", "running", "blocked", "review", "monitoring", "longterm"];

function compactText(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, maxLength) : "";
}

function normalizedTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((tag) => compactText(tag, 32)).filter(Boolean))].slice(0, 8);
}

function parsedTags(value: string | null | undefined): string[] {
  try {
    return normalizedTags(JSON.parse(value ?? "[]"));
  } catch {
    return [];
  }
}

function normalizedDueAt(value: string | null | undefined): string | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error("Invalid todo due date");
  return new Date(timestamp).toISOString();
}

function loadMetadata(): Record<string, TodoWorkflowMetadata> {
  try {
    const value = JSON.parse(appSettingValue(metadataSettingKey) ?? "{}") as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, TodoWorkflowMetadata>
      : {};
  } catch {
    return {};
  }
}

function saveMetadata(metadata: Record<string, TodoWorkflowMetadata>): void {
  setAppSettingValue(metadataSettingKey, JSON.stringify(metadata));
}

export function recommendedTodoReminder(
  priority: TodoPriority,
  dueAt: string | null,
  now = new Date()
): TodoReminderFrequency {
  if (dueAt) {
    const remaining = Date.parse(dueAt) - now.getTime();
    if (Number.isFinite(remaining) && remaining > 0 && remaining <= 24 * 60 * 60 * 1000) return "every_2_hours";
  }
  return priority === "urgent" ? "every_2_hours" : priority === "low" ? "weekly" : "daily";
}

export function nextTodoReminder(frequency: TodoReminderFrequency, from = new Date()): string | null {
  const interval = {
    none: 0,
    every_2_hours: 2 * 60 * 60 * 1000,
    daily: 24 * 60 * 60 * 1000,
    weekly: 7 * 24 * 60 * 60 * 1000
  }[frequency];
  return interval ? new Date(from.getTime() + interval).toISOString() : null;
}

export function defaultTodoSchedule(priority: TodoPriority, now = new Date()): {
  dueAt: string;
  reminderFrequency: TodoReminderFrequency;
  nextReminderAt: string | null;
} {
  const days = { urgent: 1, high: 3, normal: 7, low: 14 }[priority];
  const dueAt = new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
  const reminderFrequency = recommendedTodoReminder(priority, dueAt, now);
  return { dueAt, reminderFrequency, nextReminderAt: nextTodoReminder(reminderFrequency, now) };
}

function defaultMetadata(todoId: number, createdAt: string, updatedAt: string): TodoWorkflowMetadata {
  return {
    todo_id: todoId,
    priority: "normal",
    tags: "[]",
    due_at: null,
    reminder_frequency: "none",
    next_reminder_at: null,
    source_lark_message_id: null,
    source_chat_id: null,
    source_chat_type: null,
    source_sender_id: null,
    completion_result: null,
    completed_at: null,
    notify_on_completion: 1,
    notified_at: null,
    notification_error: null,
    owner_notified_at: null,
    owner_notification_error: null,
    last_reminded_at: null,
    created_at: createdAt,
    updated_at: updatedAt
  };
}

export function listTodoWorkflowViews(): TodoWorkflowView[] {
  const metadata = loadMetadata();
  return listCodexTodos().map((todo) => {
    const row = metadata[String(todo.id)] ?? defaultMetadata(todo.id, todo.created_at, todo.updated_at);
    return { ...todo, ...row, tags: parsedTags(row.tags) };
  });
}

export function todoWorkflowView(todoId: number): TodoWorkflowView | null {
  return listTodoWorkflowViews().find((todo) => todo.id === todoId) ?? null;
}

function insertMetadata(todoId: number, patch: TodoWorkflowPatch, context?: LarkTodoContext): void {
  const now = new Date();
  const priority = patch.priority ?? "normal";
  const schedule = defaultTodoSchedule(priority, now);
  const dueAt = patch.dueAt === undefined ? context ? schedule.dueAt : null : normalizedDueAt(patch.dueAt);
  const frequency = patch.reminderFrequency ?? (context ? recommendedTodoReminder(priority, dueAt, now) : "none");
  const timestamp = now.toISOString();
  const metadata = loadMetadata();
  metadata[String(todoId)] = {
    ...defaultMetadata(todoId, timestamp, timestamp),
    priority,
    tags: JSON.stringify(normalizedTags(patch.tags)),
    due_at: dueAt,
    reminder_frequency: frequency,
    next_reminder_at: nextTodoReminder(frequency, now),
    source_lark_message_id: context?.larkMessageId ?? null,
    source_chat_id: context?.chatId ?? null,
    source_chat_type: context?.chatType ?? null,
    source_sender_id: context?.senderId ?? null,
    completion_result: compactText(patch.completionResult, 4_000) || null,
    notify_on_completion: patch.notifyOnCompletion === false ? 0 : 1
  };
  saveMetadata(metadata);
}

export function createTodoWithWorkflow(
  input: { title: string; description?: string | null; codexSessionId?: string | null } & TodoWorkflowPatch,
  context?: LarkTodoContext
): { todo: TodoWorkflowView; created: boolean } {
  if (context) {
    const existing = Object.values(loadMetadata()).find((row) => row.source_lark_message_id === context.larkMessageId);
    if (existing) {
      const todo = todoWorkflowView(existing.todo_id);
      if (todo) return { todo, created: false };
    }
  }
  const todo = createManualCodexTodo(input);
  insertMetadata(todo.id, input, context);
  return { todo: todoWorkflowView(todo.id)!, created: true };
}

export function updateTodoWorkflow(todoId: number, patch: TodoWorkflowPatch): TodoWorkflowView | null {
  const todo = listCodexTodos().find((entry) => entry.id === todoId);
  if (!todo) return null;
  const metadata = loadMetadata();
  const existing = metadata[String(todoId)];
  if (!existing) insertMetadata(todoId, patch);
  else {
    const frequency = patch.reminderFrequency ?? existing.reminder_frequency;
    const scheduleChanged = patch.reminderFrequency !== undefined || patch.dueAt !== undefined || patch.priority !== undefined;
    metadata[String(todoId)] = {
      ...existing,
      priority: patch.priority ?? existing.priority,
      tags: patch.tags === undefined ? existing.tags : JSON.stringify(normalizedTags(patch.tags)),
      due_at: patch.dueAt === undefined ? existing.due_at : normalizedDueAt(patch.dueAt),
      reminder_frequency: frequency,
      next_reminder_at: scheduleChanged ? nextTodoReminder(frequency) : existing.next_reminder_at,
      completion_result: patch.completionResult === undefined ? existing.completion_result : compactText(patch.completionResult, 4_000) || null,
      notify_on_completion: patch.notifyOnCompletion === undefined ? existing.notify_on_completion : patch.notifyOnCompletion ? 1 : 0,
      updated_at: nowIso()
    };
    saveMetadata(metadata);
  }
  return todoWorkflowView(todoId);
}

export function updateTodoDelivery(todoId: number, patch: Partial<TodoWorkflowMetadata>): TodoWorkflowView | null {
  const todo = todoWorkflowView(todoId);
  if (!todo) return null;
  const metadata = loadMetadata();
  const existing = metadata[String(todoId)] ?? defaultMetadata(todo.id, todo.created_at, todo.updated_at);
  metadata[String(todoId)] = { ...existing, ...patch, todo_id: todoId, updated_at: nowIso() };
  saveMetadata(metadata);
  return todoWorkflowView(todoId);
}

export function markTodoCompleted(todoId: number, result: string | null): TodoWorkflowView | null {
  if (!updateCodexTodo(todoId, { status: "done" })) return null;
  const todo = updateTodoWorkflow(todoId, { completionResult: result });
  if (!todo) return null;
  return updateTodoDelivery(todoId, {
    completed_at: nowIso(),
    notified_at: null,
    notification_error: null,
    next_reminder_at: null
  });
}

export function deleteTodoWorkflow(todoId: number): void {
  const metadata = loadMetadata();
  delete metadata[String(todoId)];
  saveMetadata(metadata);
}

export function activeTodoWorkflowViews(): TodoWorkflowView[] {
  return listTodoWorkflowViews().filter((todo) => activeStatuses.includes(todo.status));
}

export function notificationState(key: string): string | null {
  return appSettingValue(`${notificationSettingPrefix}${key}`);
}

export function setNotificationState(key: string, value: string): void {
  setAppSettingValue(`${notificationSettingPrefix}${key}`, value);
}
