import fs from "node:fs";
import path from "node:path";
import { codexSessionRunStates, unreadCodexSessionIds, type CodexSessionRunState } from "./codexSessions.js";
import { db, type CodexTodoRow, type CodexTodoStatus, type IssueRow, type RepairJobRow } from "./db.js";
import { nowIso } from "./time.js";

export const codexTodoStatuses: CodexTodoStatus[] = ["todo", "running", "blocked", "review", "done", "archived", "monitoring", "longterm"];
const TODO_RUNTIME_SNAPSHOT_TTL_MS = 60_000;

type TodoRuntimeSnapshot = {
  expiresAt: number;
  sessionStates: Map<string, CodexSessionRunState>;
};

let todoRuntimeSnapshot: TodoRuntimeSnapshot | null = null;

export type CodexTodoInput = {
  title: string;
  description?: string | null;
  status?: CodexTodoStatus;
  codexSessionId?: string | null;
  codexTaskDir?: string | null;
};

export type CodexTodoView = CodexTodoRow & {
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

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function assertTodoStatus(status: string): asserts status is CodexTodoStatus {
  if (!codexTodoStatuses.includes(status as CodexTodoStatus)) {
    throw new Error(`Invalid todo status: ${status}`);
  }
}

function todoStatusFromJobStatus(status: string): CodexTodoStatus {
  if (status === "queued") return "todo";
  if (status === "running") return "running";
  if (status === "failed" || status === "blocked") return "blocked";
  if (status === "done" || status === "pr_created" || status === "triaged") return "review";
  return "todo";
}

function codexThreadUrl(sessionId: string | null): string | null {
  return sessionId ? `codex://threads/${encodeURIComponent(sessionId)}` : null;
}

function currentTodoRuntimeSnapshot(sessionIds: string[]): TodoRuntimeSnapshot {
  const now = Date.now();
  if (todoRuntimeSnapshot && todoRuntimeSnapshot.expiresAt > now) {
    return todoRuntimeSnapshot;
  }
  todoRuntimeSnapshot = {
    expiresAt: now + TODO_RUNTIME_SNAPSHOT_TTL_MS,
    sessionStates: codexSessionRunStates(sessionIds)
  };
  return todoRuntimeSnapshot;
}

function runnerState(
  jobStatus: string | null,
  taskDir: string | null,
  sessionId: string | null,
  runtime: TodoRuntimeSnapshot
): CodexTodoView["runner_state"] {
  if (jobStatus === "running") {
    return "running";
  }
  if (["done", "pr_created", "triaged"].includes(jobStatus ?? "")) {
    return "completed";
  }
  if (["failed", "blocked"].includes(jobStatus ?? "")) {
    return "stopped";
  }
  if (taskDir && path.isAbsolute(taskDir) && fs.existsSync(path.join(taskDir, "done"))) {
    return "completed";
  }
  if (sessionId) {
    const sessionState = runtime.sessionStates.get(sessionId);
    if (sessionState && sessionState !== "unknown") {
      return sessionState;
    }
  }
  if (taskDir) {
    return "stopped";
  }
  return sessionId ? runtime.sessionStates.get(sessionId) ?? "unknown" : "unknown";
}

function decorateTodo(
  row: Omit<CodexTodoView, "effective_codex_session_id" | "effective_codex_task_dir" | "codex_thread_url" | "runner_state" | "codex_unread">,
  unreadSessionIds: Set<string>,
  runtime: TodoRuntimeSnapshot
): CodexTodoView {
  const effectiveSessionId = row.codex_session_id ?? row.job_codex_session_id ?? null;
  const effectiveTaskDir = row.codex_task_dir ?? row.job_task_dir ?? null;
  const archived = row.status === "archived";
  return {
    ...row,
    effective_codex_session_id: effectiveSessionId,
    effective_codex_task_dir: effectiveTaskDir,
    codex_thread_url: codexThreadUrl(effectiveSessionId),
    runner_state: archived ? "unknown" : runnerState(row.job_status, effectiveTaskDir, effectiveSessionId, runtime),
    codex_unread: archived ? false : effectiveSessionId ? unreadSessionIds.has(effectiveSessionId) : false
  };
}

export function listCodexTodos(): CodexTodoView[] {
  const rows = db.prepare(`
    SELECT
      codex_todos.*,
      repair_jobs.status AS job_status,
      repair_jobs.mode AS job_mode,
      repair_jobs.phase AS job_phase,
      repair_jobs.task_dir AS job_task_dir,
      repair_jobs.codex_session_id AS job_codex_session_id,
      issues.title AS issue_title,
      issues.kind AS issue_kind,
      issues.external_id AS issue_external_id,
      issues.repo_owner AS issue_repo_owner,
      issues.repo_name AS issue_repo_name
    FROM codex_todos
    LEFT JOIN repair_jobs ON repair_jobs.id = codex_todos.job_id
    LEFT JOIN issues ON issues.id = COALESCE(codex_todos.issue_id, repair_jobs.issue_id)
    ORDER BY
      CASE codex_todos.status
        WHEN 'running' THEN 0
        WHEN 'blocked' THEN 1
        WHEN 'todo' THEN 2
        WHEN 'review' THEN 3
        WHEN 'done' THEN 4
        WHEN 'archived' THEN 5
        WHEN 'monitoring' THEN 6
        WHEN 'longterm' THEN 7
        ELSE 8
      END,
      codex_todos.updated_at DESC,
      codex_todos.id DESC
  `).all() as Array<Omit<CodexTodoView, "effective_codex_session_id" | "effective_codex_task_dir" | "codex_thread_url" | "runner_state" | "codex_unread">>;
  const activeRows = rows.filter((row) => row.status !== "archived");
  const unreadSessionIds = activeRows.length > 0 ? unreadCodexSessionIds() : new Set<string>();
  const sessionIds = activeRows.flatMap((row) => {
    const sessionId = row.codex_session_id ?? row.job_codex_session_id;
    return sessionId ? [sessionId] : [];
  });
  const runtime = activeRows.length > 0
    ? currentTodoRuntimeSnapshot(sessionIds)
    : { expiresAt: Date.now() + TODO_RUNTIME_SNAPSHOT_TTL_MS, sessionStates: new Map<string, CodexSessionRunState>() };
  return rows.map((row) => decorateTodo(row, unreadSessionIds, runtime));
}

export function createManualCodexTodo(input: CodexTodoInput): CodexTodoView {
  const title = normalizeText(input.title);
  if (!title) {
    throw new Error("Todo title is required");
  }
  const status = input.status ?? "todo";
  assertTodoStatus(status);
  const codexSessionId = input.codexSessionId?.trim() || null;
  if (codexSessionId) {
    const duplicate = db.prepare("SELECT id FROM codex_todos WHERE codex_session_id = ? LIMIT 1").get(codexSessionId) as { id: number } | undefined;
    if (duplicate) {
      throw new Error(`Codex session already has a todo: ${codexSessionId}`);
    }
  }
  const now = nowIso();
  const result = db.prepare(`
    INSERT INTO codex_todos (title, description, status, source_type, source_id, codex_session_id, codex_task_dir, created_at, updated_at)
    VALUES (?, ?, ?, 'manual', NULL, ?, ?, ?, ?)
  `).run(title, input.description?.trim() || null, status, codexSessionId, input.codexTaskDir?.trim() || null, now, now);
  return listCodexTodos().find((todo) => todo.id === Number(result.lastInsertRowid))!;
}

export function updateCodexTodo(
  id: number,
  patch: Partial<Pick<CodexTodoInput, "title" | "description" | "status" | "codexSessionId" | "codexTaskDir">>
): CodexTodoView | null {
  const existing = db.prepare("SELECT * FROM codex_todos WHERE id = ?").get(id) as CodexTodoRow | undefined;
  if (!existing) {
    return null;
  }
  const title = patch.title !== undefined ? normalizeText(patch.title) : existing.title;
  if (!title) {
    throw new Error("Todo title is required");
  }
  const status = patch.status ?? existing.status;
  assertTodoStatus(status);
  const nextCodexSessionId = patch.codexSessionId !== undefined ? patch.codexSessionId?.trim() || null : existing.codex_session_id;
  if (nextCodexSessionId) {
    const duplicate = db.prepare("SELECT id FROM codex_todos WHERE codex_session_id = ? AND id != ? LIMIT 1").get(nextCodexSessionId, id) as { id: number } | undefined;
    if (duplicate) {
      throw new Error(`Codex session already has a todo: ${nextCodexSessionId}`);
    }
  }
  db.prepare(`
    UPDATE codex_todos
    SET title = ?,
        description = ?,
        status = ?,
        codex_session_id = ?,
        codex_task_dir = ?,
        updated_at = ?
    WHERE id = ?
  `).run(
    title,
    patch.description !== undefined ? patch.description?.trim() || null : existing.description,
    status,
    nextCodexSessionId,
    patch.codexTaskDir !== undefined ? patch.codexTaskDir?.trim() || null : existing.codex_task_dir,
    nowIso(),
    id
  );
  return listCodexTodos().find((todo) => todo.id === id) ?? null;
}

export function deleteCodexTodo(id: number): boolean {
  const result = db.prepare("DELETE FROM codex_todos WHERE id = ?").run(id);
  return result.changes > 0;
}

export function ensureTodoForIssueRepairJob(job: RepairJobRow, issue: IssueRow): void {
  if (issue.kind !== "issue" || job.mode === "review_only") {
    return;
  }
  const now = nowIso();
  const sourceId = String(job.id);
  const title = `Issue #${issue.external_id} · ${issue.title}`;
  db.prepare(`
    INSERT INTO codex_todos (
      title, description, status, source_type, source_id, issue_id, job_id,
      codex_session_id, codex_task_dir, created_at, updated_at
    )
    VALUES (?, ?, ?, 'issue_repair', ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_type, source_id) DO NOTHING
  `).run(
    title,
    `${issue.repo_owner}/${issue.repo_name}`,
    todoStatusFromJobStatus(job.status),
    sourceId,
    issue.id,
    job.id,
    job.codex_session_id,
    job.task_dir,
    now,
    now
  );
}
