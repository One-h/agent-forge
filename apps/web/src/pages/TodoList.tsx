import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Archive, ExternalLink, ListTodo, Plus, RefreshCw, Search, X } from "lucide-react";
import { api, type CodexSessionSummary, type CodexTodoStatus } from "../api";
import { openCodexThread } from "../codexNavigation";
import { DetailDrawer } from "../components/DetailDrawer";
import { formatTime, modeText, statusText } from "../i18n";
import { todoWorkflowApi, type TodoWorkflowPatch, type TodoWorkflowTodo } from "../todoWorkflowApi";
import { TodoEditorDrawer } from "./TodoEditorDrawer";
import "../todoWorkflow.css";

const statuses: CodexTodoStatus[] = ["todo", "running", "blocked", "review", "done", "archived", "monitoring", "longterm"];
const boardStatuses = statuses.filter((status) => status !== "archived");

function sourceLabel(todo: TodoWorkflowTodo): string {
  if (todo.source_lark_message_id) {
    return todo.source_chat_type === "group" ? "飞书群聊" : "飞书联系人";
  }
  if (todo.source_type === "issue_repair") {
    const repo = todo.issue_repo_owner && todo.issue_repo_name ? `${todo.issue_repo_owner}/${todo.issue_repo_name}` : "问题";
    return `${repo}${todo.issue_external_id ? ` #${todo.issue_external_id}` : ""}`;
  }
  return "手动创建";
}

function compactSession(sessionId: string | null): string {
  if (!sessionId) return "-";
  return sessionId.length > 18 ? `${sessionId.slice(0, 8)}…${sessionId.slice(-6)}` : sessionId;
}

function openCodex(todo: TodoWorkflowTodo): void {
  if (!todo.codex_thread_url) {
    return;
  }
  openCodexThread(todo.codex_thread_url);
}

export function TodoList() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [todos, setTodos] = useState<TodoWorkflowTodo[]>([]);
  const [sessions, setSessions] = useState<CodexSessionSummary[]>([]);
  const [error, setError] = useState("");
  const [sessionQuery, setSessionQuery] = useState("");
  const [sessionModalOpen, setSessionModalOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [editingTodoId, setEditingTodoId] = useState<number | null>(null);
  const [draggingTodoId, setDraggingTodoId] = useState<number | null>(null);

  const load = async () => {
    const nextTodos = await todoWorkflowApi.list();
    setTodos(nextTodos);
  };

  useEffect(() => {
    void load().catch((err) => setError(String(err)));
    const timer = window.setInterval(() => void load().catch((err) => setError(String(err))), 5000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!sessionModalOpen) {
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void api.codexSessions(sessionQuery)
        .then((nextSessions) => {
          if (!cancelled) setSessions(nextSessions);
        })
        .catch((err) => {
          if (!cancelled) setError(String(err));
        });
    }, 180);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [sessionModalOpen, sessionQuery]);

  const resetSessionPicker = () => {
    setSessionQuery("");
    setSessionModalOpen(false);
  };

  const createFromSession = async (sessionId: string, title: string) => {
    setError("");
    await todoWorkflowApi.create({
      title,
      description: null,
      codexSessionId: sessionId
    });
    resetSessionPicker();
    await load();
  };

  const createFromExistingSession = async (session: CodexSessionSummary) => {
    if (todos.some((todo) => todo.effective_codex_session_id === session.id)) {
      setError("该 Codex 会话已在待办列表中。");
      return;
    }
    await createFromSession(session.id, session.title);
  };

  const updateStatus = async (todo: TodoWorkflowTodo, status: CodexTodoStatus) => {
    if (todo.status === status) {
      return;
    }
    setTodos((current) => current.map((item) => item.id === todo.id ? { ...item, status } : item));
    await todoWorkflowApi.update(todo.id, { status });
    await load();
  };

  const openEditor = (todo: TodoWorkflowTodo) => {
    setArchiveOpen(false);
    setEditingTodoId(todo.id);
  };

  const closeEditor = () => {
    setEditingTodoId(null);
  };

  const saveEditor = async (patch: TodoWorkflowPatch) => {
    if (editingTodoId === null) return;
    setError("");
    await todoWorkflowApi.update(editingTodoId, patch);
    closeEditor();
    await load();
  };

  const deleteTodo = async (todo: TodoWorkflowTodo) => {
    if (!window.confirm(`确定删除待办“${todo.title}”？`)) {
      return;
    }
    setError("");
    setTodos((current) => current.filter((item) => item.id !== todo.id));
    await api.deleteTodo(todo.id);
    closeEditor();
    await load();
  };

  const filteredSessions = sessionQuery.trim() ? sessions.slice(0, 50) : sessions.slice(0, 24);
  const usedSessionIds = new Set(todos.map((todo) => todo.effective_codex_session_id).filter(Boolean));
  const editingTodo = todos.find((todo) => todo.id === editingTodoId) ?? null;
  const archivedTodos = todos.filter((todo) => todo.status === "archived");
  const activeTodos = todos.filter((todo) => todo.status !== "archived");
  const priorityLabel = (todo: TodoWorkflowTodo) => ({ urgent: "紧急", high: "高", normal: "普通", low: "低" })[todo.priority];
  const dueLabel = (todo: TodoWorkflowTodo) => todo.due_at ? formatTime(todo.due_at) : "未设置截止";

  useEffect(() => {
    const todoId = Number(searchParams.get("todo"));
    if (!Number.isSafeInteger(todoId) || editingTodoId !== null) return;
    const todo = todos.find((item) => item.id === todoId);
    if (todo) {
      openEditor(todo);
      setSearchParams({}, { replace: true });
    }
  }, [editingTodoId, searchParams, setSearchParams, todos]);

  return (
    <section className="pageStack">
      <div className="heroBand">
        <div>
          <p className="eyebrow">Codex 任务</p>
          <h2>待办</h2>
          <p className="subtle">管理问题修复任务和需要持续跟进的 Codex 会话。</p>
        </div>
        <div className="heroActions">
          <button className="primaryButton" onClick={() => setSessionModalOpen(true)}><Plus size={16} /> 添加</button>
          <button
            aria-label={`查看归档，共 ${archivedTodos.length} 项`}
            className={`iconButton archiveTrigger ${draggingTodoId ? "dropReady" : ""}`}
            onClick={() => setArchiveOpen(true)}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              const todoId = Number(event.dataTransfer.getData("text/plain") || draggingTodoId);
              const todo = todos.find((item) => item.id === todoId);
              setDraggingTodoId(null);
              if (todo) {
                void updateStatus(todo, "archived").catch((err) => setError(String(err)));
              }
            }}
            title="查看归档；可将卡片拖到这里归档"
          >
            <Archive size={16} />
          </button>
          <button className="ghostButton" onClick={() => void load()}><RefreshCw size={16} /> 刷新</button>
        </div>
      </div>

      {error && <div className="error">{error}</div>}

      {sessionModalOpen && (
        <div className="sessionModalLayer" role="presentation">
          <button className="sessionModalBackdrop" aria-label="关闭会话选择器" onClick={() => setSessionModalOpen(false)} />
          <section className="sessionModal" role="dialog" aria-modal="true" aria-labelledby="session-picker-title">
            <header className="sessionModalHeader">
              <div>
                <p className="eyebrow">Codex 会话</p>
                <h3 id="session-picker-title">选择已有会话</h3>
              </div>
              <button className="iconButton" aria-label="关闭" onClick={() => setSessionModalOpen(false)}><X size={16} /></button>
            </header>
            <div className="sessionModalSearch">
              <Search size={16} />
              <input
                autoFocus
                value={sessionQuery}
                onChange={(event) => setSessionQuery(event.target.value)}
                placeholder="搜索标题、会话 ID 或粘贴 codex:// 链接"
              />
            </div>
            <div className="sessionModalResults">
              {filteredSessions.map((session) => (
                <button
                  disabled={usedSessionIds.has(session.id)}
                  key={session.id}
                  onClick={() => void createFromExistingSession(session).catch((err) => setError(String(err)))}
                >
                  <span>
                    <strong>{session.title}</strong>
                    <small className="mono">{session.id}</small>
                  </span>
                  <small>{usedSessionIds.has(session.id) ? "已添加" : formatTime(session.updated_at)}</small>
                </button>
              ))}
              {filteredSessions.length === 0 && <div className="emptyState compact">没有匹配的会话。</div>}
            </div>
            <footer className="sessionModalFooter">
              <span>{filteredSessions.length} 个会话</span>
              <button
                className="ghostButton"
                disabled={!sessionQuery}
                onClick={() => {
                  setSessionQuery("");
                }}
              >
                清空
              </button>
            </footer>
          </section>
        </div>
      )}

      {activeTodos.length === 0 && <div className="emptyState compact">暂无进行中的待办。</div>}
      <div className="todoBoard">
        {boardStatuses.map((status) => {
          const columnTodos = todos.filter((todo) => todo.status === status);
          return (
            <section
              className={`todoColumn ${draggingTodoId ? "dropReady" : ""}`}
              key={status}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                const todoId = Number(event.dataTransfer.getData("text/plain") || draggingTodoId);
                const todo = todos.find((item) => item.id === todoId);
                setDraggingTodoId(null);
                if (todo) {
                  void updateStatus(todo, status).catch((err) => setError(String(err)));
                }
              }}
            >
              <div className="todoColumnHeader">
                <strong>{statusText(status)}</strong>
                <span>{columnTodos.length}</span>
              </div>
              <div className="todoCardStack">
                {columnTodos.map((todo) => (
                  <article
                    className={`todoCard runner-${todo.runner_state}${todo.codex_unread ? " codexUnread" : ""}`}
                    draggable
                    key={todo.id}
                    onDoubleClick={() => openEditor(todo)}
                    onDragStart={(event) => {
                      setDraggingTodoId(todo.id);
                      event.dataTransfer.setData("text/plain", String(todo.id));
                    }}
                    onDragEnd={() => setDraggingTodoId(null)}
                  >
                    <div className="todoCardHeader">
                      <h3><ListTodo size={14} /> {todo.title}</h3>
                    </div>
                    {todo.description && <p>{todo.description}</p>}
                    <div className="todoCardWorkflowMeta">
                      <span className={`todoPriorityBadge priority-${todo.priority}`}>{priorityLabel(todo)}</span>
                      <span className={`todoDueDate ${todo.due_at && Date.parse(todo.due_at) < Date.now() ? "overdue" : ""}`}>{dueLabel(todo)}</span>
                      {todo.tags.slice(0, 3).map((tag) => <span className="todoTag" key={tag}>{tag}</span>)}
                    </div>
                    <dl className="todoCardMeta">
                      <dt>来源</dt><dd>{sourceLabel(todo)}</dd>
                      <dt>会话</dt><dd className="mono" title={todo.effective_codex_session_id || ""}>{compactSession(todo.effective_codex_session_id)}</dd>
                      <dt>更新</dt><dd>{formatTime(todo.updated_at)}</dd>
                    </dl>
                    {todo.job_status && <small className="blockHint">任务 {statusText(todo.job_status)}{todo.job_mode ? ` · ${modeText(todo.job_mode)}` : ""}</small>}
                    <div className="todoActions">
                      <button className="ghostButton" disabled={!todo.codex_thread_url} onClick={() => openCodex(todo)}>
                        <ExternalLink size={14} /> Codex
                      </button>
                      {todo.job_id && <button className="ghostButton" onClick={() => navigate(`/runs/${todo.job_id}`)}>运行记录</button>}
                    </div>
                  </article>
                ))}
              </div>
            </section>
          );
        })}
      </div>

      {archiveOpen && (
        <DetailDrawer kicker="历史任务" title={`归档 · ${archivedTodos.length}`} onClose={() => setArchiveOpen(false)}>
          <div className="archiveTodoList">
            {archivedTodos.map((todo) => (
              <article
                className="todoCard archivedTodoCard"
                key={todo.id}
                onDoubleClick={() => openEditor(todo)}
                title="双击编辑"
              >
                <div className="todoCardHeader">
                  <h3><Archive size={14} /> {todo.title}</h3>
                </div>
                {todo.description && <p>{todo.description}</p>}
                <dl className="todoCardMeta">
                  <dt>来源</dt><dd>{sourceLabel(todo)}</dd>
                  <dt>会话</dt><dd className="mono" title={todo.effective_codex_session_id || ""}>{compactSession(todo.effective_codex_session_id)}</dd>
                  <dt>更新</dt><dd>{formatTime(todo.updated_at)}</dd>
                </dl>
                <div className="todoActions">
                  <button className="ghostButton" disabled={!todo.codex_thread_url} onClick={() => openCodex(todo)}>
                    <ExternalLink size={14} /> Codex
                  </button>
                  {todo.job_id && <button className="ghostButton" onClick={() => navigate(`/runs/${todo.job_id}`)}>运行记录</button>}
                </div>
              </article>
            ))}
            {archivedTodos.length === 0 && <div className="emptyState compact">暂无归档任务。</div>}
          </div>
        </DetailDrawer>
      )}

      {editingTodo && (
        <TodoEditorDrawer
          key={editingTodo.id}
          todo={editingTodo}
          statuses={statuses}
          onClose={closeEditor}
          onSave={saveEditor}
          onDelete={() => deleteTodo(editingTodo)}
          onOpenCodex={() => openCodex(editingTodo)}
          onOpenRun={() => editingTodo.job_id && navigate(`/runs/${editingTodo.job_id}`)}
        />
      )}
    </section>
  );
}
