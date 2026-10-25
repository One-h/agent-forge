import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type CodexSessionSummary = {
  id: string;
  title: string;
  updated_at: string;
};

export type CodexSessionRunState = "running" | "completed" | "stopped" | "unknown";

type SessionIndexLine = {
  id?: unknown;
  thread_name?: unknown;
  updated_at?: unknown;
};

type CodexGlobalState = {
  "electron-persisted-atom-state"?: {
    "unread-thread-ids-by-host-v1"?: {
      local?: unknown;
    };
  };
};

type CodexJsonlLine = {
  timestamp?: unknown;
  type?: unknown;
  payload?: {
    id?: unknown;
    message?: unknown;
    timestamp?: unknown;
    type?: unknown;
    turn_id?: unknown;
  };
};

function sessionsRoot(): string {
  return path.join(os.homedir(), ".codex", "sessions");
}

function globalStatePath(): string {
  return path.join(os.homedir(), ".codex", ".codex-global-state.json");
}

function looksLikeSessionId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export function codexSessionIdFromInput(value: string): string | null {
  const input = value.trim();
  if (looksLikeSessionId(input)) return input;
  try {
    const parsed = new URL(input);
    if (parsed.protocol !== "codex:" || parsed.hostname !== "threads") return null;
    const sessionId = decodeURIComponent(parsed.pathname).replace(/^\/+|\/+$/g, "");
    return looksLikeSessionId(sessionId) ? sessionId : null;
  } catch {
    return null;
  }
}

function compactTitle(value: string): string {
  const title = value.replace(/\s+/g, " ").trim();
  return title.length > 80 ? `${title.slice(0, 77)}...` : title;
}

function sessionSummaryFromFile(sessionId: string, filePath: string): CodexSessionSummary {
  let timestamp = "";
  let title = "Untitled session";
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as CodexJsonlLine;
      if (!timestamp && typeof parsed.timestamp === "string") {
        timestamp = parsed.timestamp;
      }
      if (parsed.type === "session_meta" && typeof parsed.payload?.timestamp === "string") {
        timestamp = parsed.payload.timestamp;
      }
      if (parsed.type === "event_msg" && parsed.payload?.type === "user_message" && typeof parsed.payload.message === "string") {
        title = compactTitle(parsed.payload.message) || title;
        break;
      }
    } catch {
      continue;
    }
  }
  return { id: sessionId, title, updated_at: timestamp };
}

export function listCodexSessions(options: { limit?: number; query?: string } = {}): CodexSessionSummary[] {
  const limit = options.limit ?? 300;
  const rawQuery = options.query?.trim() ?? "";
  const query = (codexSessionIdFromInput(rawQuery) ?? rawQuery).toLowerCase();
  const indexPath = path.join(os.homedir(), ".codex", "session_index.jsonl");
  const latest = new Map<string, CodexSessionSummary>();
  if (fs.existsSync(indexPath)) {
    for (const line of fs.readFileSync(indexPath, "utf8").split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      try {
        const parsed = JSON.parse(line) as SessionIndexLine;
        if (typeof parsed.id !== "string" || !parsed.id) {
          continue;
        }
        const title = typeof parsed.thread_name === "string" && parsed.thread_name.trim() ? parsed.thread_name.trim() : "Untitled session";
        const updatedAt = typeof parsed.updated_at === "string" ? parsed.updated_at : "";
        const existing = latest.get(parsed.id);
        if (!existing || updatedAt > existing.updated_at) {
          latest.set(parsed.id, { id: parsed.id, title, updated_at: updatedAt });
        }
      } catch {
        continue;
      }
    }
  }
  if (query && looksLikeSessionId(query) && !latest.has(query)) {
    const filePath = findCodexSessionFile(query);
    if (filePath) {
      latest.set(query, sessionSummaryFromFile(query, filePath));
    }
  }
  const sessions = [...latest.values()]
    .filter((session) => !query || `${session.id} ${session.title}`.toLowerCase().includes(query))
    .sort((left, right) => {
      if (query) {
        const leftExact = left.id.toLowerCase() === query ? 1 : 0;
        const rightExact = right.id.toLowerCase() === query ? 1 : 0;
        if (leftExact !== rightExact) {
          return rightExact - leftExact;
        }
      }
      return right.updated_at.localeCompare(left.updated_at);
    });
  return sessions
    .slice(0, limit);
}

export function findCodexSessionFile(sessionId: string): string | null {
  const root = sessionsRoot();
  if (!sessionId || !fs.existsSync(root)) {
    return null;
  }
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(`${sessionId}.jsonl`)) {
        return fullPath;
      }
    }
  }
  return null;
}

export function unreadCodexSessionIds(): Set<string> {
  const statePath = globalStatePath();
  if (!fs.existsSync(statePath)) {
    return new Set();
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf8")) as CodexGlobalState;
    const localIds = parsed["electron-persisted-atom-state"]?.["unread-thread-ids-by-host-v1"]?.local;
    if (!Array.isArray(localIds)) {
      return new Set();
    }
    return new Set(localIds.filter((id): id is string => typeof id === "string" && looksLikeSessionId(id)));
  } catch {
    return new Set();
  }
}

function readRecentSessionJsonl(filePath: string, maxBytes = 64 * 1024): string {
  const size = fs.statSync(filePath).size;
  const start = Math.max(0, size - maxBytes);
  const length = size - start;
  const buffer = Buffer.alloc(length);
  const descriptor = fs.openSync(filePath, "r");
  try {
    fs.readSync(descriptor, buffer, 0, length, start);
  } finally {
    fs.closeSync(descriptor);
  }
  const text = buffer.toString("utf8");
  if (start === 0) {
    return text;
  }
  const firstNewline = text.indexOf("\n");
  return firstNewline === -1 ? "" : text.slice(firstNewline + 1);
}

function codexSessionRunStateFromFile(filePath: string): CodexSessionRunState {
  let latestTaskState: CodexSessionRunState | null = null;
  let latestTaskTimestamp = "";
  for (const line of readRecentSessionJsonl(filePath).split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as CodexJsonlLine;
      if (parsed.type !== "event_msg") {
        continue;
      }
      const payloadType = parsed.payload?.type;
      if (payloadType !== "task_started" && payloadType !== "task_complete") {
        continue;
      }
      const eventTimestamp = typeof parsed.timestamp === "string" ? parsed.timestamp : "";
      if (latestTaskTimestamp && eventTimestamp && eventTimestamp < latestTaskTimestamp) {
        continue;
      }
      latestTaskTimestamp = eventTimestamp || latestTaskTimestamp;
      latestTaskState = payloadType === "task_started" ? "running" : "completed";
    } catch {
      continue;
    }
  }
  return latestTaskState ?? "unknown";
}

export function codexSessionRunStates(sessionIds: Iterable<string>): Map<string, CodexSessionRunState> {
  const wanted = new Set([...sessionIds].filter(Boolean));
  const states = new Map<string, CodexSessionRunState>();
  if (wanted.size === 0) {
    return states;
  }
  const root = sessionsRoot();
  if (!fs.existsSync(root)) {
    return states;
  }

  const stack = [root];
  while (stack.length > 0 && states.size < wanted.size) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
        continue;
      }
      const sessionId = [...wanted].find((id) => !states.has(id) && entry.name.endsWith(`${id}.jsonl`));
      if (!sessionId) {
        continue;
      }
      try {
        states.set(sessionId, codexSessionRunStateFromFile(fullPath));
      } catch {
        states.set(sessionId, "unknown");
      }
    }
  }
  return states;
}

export function codexSessionRunState(sessionId: string | null): CodexSessionRunState {
  if (!sessionId) {
    return "unknown";
  }
  return codexSessionRunStates([sessionId]).get(sessionId) ?? "unknown";
}
