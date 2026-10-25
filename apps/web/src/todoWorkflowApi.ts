import type { CodexTodo, CodexTodoStatus } from "./api";

export type TodoPriority = "urgent" | "high" | "normal" | "low";
export type TodoReminderFrequency = "none" | "every_2_hours" | "daily" | "weekly";

export type TodoWorkflowTodo = CodexTodo & {
  priority: TodoPriority;
  tags: string[];
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
};

export type TodoWorkflowPatch = Partial<{
  title: string;
  description: string | null;
  status: CodexTodoStatus;
  codexSessionId: string | null;
  codexTaskDir: string | null;
  priority: TodoPriority;
  tags: string[];
  dueAt: string | null;
  reminderFrequency: TodoReminderFrequency;
  completionResult: string | null;
  notifyOnCompletion: boolean;
}>;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers }
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText })) as { error?: string };
    throw new Error(body.error || `Request failed with HTTP ${response.status}`);
  }
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}

export const todoWorkflowApi = {
  list: () => request<TodoWorkflowTodo[]>("/api/todos"),
  create: (input: { title: string; description?: string | null; codexSessionId?: string | null } & TodoWorkflowPatch) =>
    request<TodoWorkflowTodo>("/api/todos", { method: "POST", body: JSON.stringify(input) }),
  update: (id: number, patch: TodoWorkflowPatch) =>
    request<TodoWorkflowTodo>(`/api/todos/${id}`, { method: "PATCH", body: JSON.stringify(patch) })
};
