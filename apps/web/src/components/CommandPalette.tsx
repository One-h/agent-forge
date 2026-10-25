import { useEffect, useMemo, useRef, useState, type ComponentType, type KeyboardEvent } from "react";
import { Activity, FileQuestion, GitPullRequestArrow, Inbox, ListTodo, LoaderCircle, MessageSquareText, Search, Settings2, X } from "lucide-react";
import { api, type CodexTodo, type Issue, type LarkMessageListItem, type RepairRun } from "../api";
import { itemKindText, modeText, statusText } from "../i18n";

type PaletteItem = {
  id: string;
  group: "导航" | "问题与 PR" | "运行记录" | "飞书消息" | "Codex 待办";
  title: string;
  subtitle: string;
  keywords: string;
  icon: ComponentType<{ size?: number }>;
  onSelect: () => void;
};

type CommandPaletteProps = {
  onClose: () => void;
  onNavigate: (path: string) => void;
  onOpenIssue: (issue: Issue) => void;
  onOpenTodo: (todoId: number) => void;
};

function senderName(message: LarkMessageListItem): string {
  if (message.direction === "outbound") {
    return message.recipientName || message.recipientId || "未知接收人";
  }
  return message.sender_name || message.sender_enterprise_email || message.sender_id || "未知发送人";
}

function makeIssueItem(issue: Issue, onOpenIssue: (issue: Issue) => void): PaletteItem {
  const isPull = issue.kind === "pr";
  return {
    id: `issue:${issue.id}`,
    group: "问题与 PR",
    title: `${isPull ? "PR" : "问题"} #${issue.external_id} ${issue.title}`,
    subtitle: `${issue.repo_owner}/${issue.repo_name} · ${statusText(issue.state || issue.status)}`,
    keywords: `${issue.repo_owner}/${issue.repo_name} ${issue.title} ${issue.external_id} ${issue.author ?? ""} ${issue.assignee ?? ""}`,
    icon: isPull ? GitPullRequestArrow : Inbox,
    onSelect: () => onOpenIssue(issue)
  };
}

function makeRunItem(run: RepairRun, onNavigate: (path: string) => void): PaletteItem {
  return {
    id: `run:${run.id}`,
    group: "运行记录",
    title: `任务 #${run.id} ${run.issue_title}`,
    subtitle: `${run.repo_owner}/${run.repo_name} · ${modeText(run.mode)} · ${statusText(run.status)}`,
    keywords: `${run.id} ${run.repo_owner}/${run.repo_name} ${run.issue_title} ${run.external_id} ${run.mode} ${run.status}`,
    icon: Activity,
    onSelect: () => onNavigate(`/runs/${run.id}`)
  };
}

function makeMessageItem(message: LarkMessageListItem, onNavigate: (path: string) => void): PaletteItem {
  return {
    id: `lark:${message.id}`,
    group: "飞书消息",
    title: `${message.direction === "outbound" ? "出站至" : "来自"} ${senderName(message)}：${message.content || `[${message.message_type || "消息"}]`}`,
    subtitle: message.direction === "outbound"
      ? `${message.chat_type === "group" ? "群聊" : "单聊"} · 已发送`
      : `${message.chat_type === "group" ? "群聊" : "单聊"} · Codex ${statusText(message.codex_status)}`,
    keywords: `${senderName(message)} ${message.content ?? ""} ${message.codex_reply ?? ""} ${message.sender_id ?? ""} ${message.recipientId ?? ""}`,
    icon: MessageSquareText,
    onSelect: () => onNavigate(`/lark-messages/${message.id}`)
  };
}

function makeTodoItem(todo: CodexTodo, onOpenTodo: (todoId: number) => void): PaletteItem {
  return {
    id: `todo:${todo.id}`,
    group: "Codex 待办",
    title: todo.title,
    subtitle: `${statusText(todo.status)} · ${todo.effective_codex_session_id || "未关联会话"}`,
    keywords: `${todo.title} ${todo.description ?? ""} ${todo.effective_codex_session_id ?? ""} ${todo.status}`,
    icon: ListTodo,
    onSelect: () => onOpenTodo(todo.id)
  };
}

export function CommandPalette({ onClose, onNavigate, onOpenIssue, onOpenTodo }: CommandPaletteProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [issues, setIssues] = useState<Issue[]>([]);
  const [runs, setRuns] = useState<RepairRun[]>([]);
  const [messages, setMessages] = useState<LarkMessageListItem[]>([]);
  const [todos, setTodos] = useState<CodexTodo[]>([]);

  useEffect(() => {
    inputRef.current?.focus();
    void Promise.all([api.issues(), api.pulls("all"), api.jobs(), api.larkMessages(), api.todos()])
      .then(([nextIssues, nextPulls, nextRuns, nextMessages, nextTodos]) => {
        setIssues([...nextIssues, ...nextPulls]);
        setRuns(nextRuns);
        setMessages(nextMessages);
        setTodos(nextTodos);
      })
      .catch((reason) => setError(String(reason)))
      .finally(() => setLoading(false));
  }, []);

  const items = useMemo<PaletteItem[]>(() => {
    const navigation: PaletteItem[] = [
      { id: "nav:dashboard", group: "导航", title: "概览", subtitle: "打开工作台总览", keywords: "概览 dashboard", icon: FileQuestion, onSelect: () => onNavigate("/dashboard") },
      { id: "nav:issues", group: "导航", title: "问题队列", subtitle: "查看 Gitea 问题", keywords: "问题 issue gitea", icon: Inbox, onSelect: () => onNavigate("/issues") },
      { id: "nav:pulls", group: "导航", title: "拉取请求", subtitle: "查看待评审 PR", keywords: "pr pull request 拉取请求 评审", icon: GitPullRequestArrow, onSelect: () => onNavigate("/pulls") },
      { id: "nav:todos", group: "导航", title: "Codex 待办", subtitle: "查看会话看板", keywords: "待办 todo codex", icon: ListTodo, onSelect: () => onNavigate("/todos") },
      { id: "nav:lark", group: "导航", title: "飞书消息", subtitle: "查看机器人会话", keywords: "飞书 lark 消息", icon: MessageSquareText, onSelect: () => onNavigate("/lark-messages") },
      { id: "nav:runs", group: "导航", title: "运行记录", subtitle: "查看 Codex 任务", keywords: "运行 run job codex", icon: Activity, onSelect: () => onNavigate("/runs") },
      { id: "nav:settings", group: "导航", title: "设置", subtitle: "配置本机运行时", keywords: "设置 settings 配置", icon: Settings2, onSelect: () => onNavigate("/settings") }
    ];
    const records = [
      ...issues.map((issue) => makeIssueItem(issue, onOpenIssue)),
      ...runs.map((run) => makeRunItem(run, onNavigate)),
      ...messages.map((message) => makeMessageItem(message, onNavigate)),
      ...todos.map((todo) => makeTodoItem(todo, onOpenTodo))
    ];
    const normalized = query.trim().toLowerCase();
    const matches = normalized
      ? [...navigation, ...records].filter((item) => `${item.title} ${item.subtitle} ${item.keywords}`.toLowerCase().includes(normalized))
      : [...navigation, ...records];
    return matches.slice(0, 80);
  }, [issues, messages, onNavigate, onOpenIssue, onOpenTodo, query, runs, todos]);

  useEffect(() => {
    setSelectedIndex((current) => Math.min(current, Math.max(0, items.length - 1)));
  }, [items.length]);

  const selectItem = (item: PaletteItem | undefined) => {
    if (!item) return;
    item.onSelect();
    onClose();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelectedIndex((current) => Math.min(current + 1, Math.max(0, items.length - 1)));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelectedIndex((current) => Math.max(0, current - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      selectItem(items[selectedIndex]);
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  };

  let previousGroup = "";
  return (
    <div className="commandPaletteLayer" role="presentation">
      <button className="commandPaletteBackdrop" aria-label="关闭全局搜索" onClick={onClose} />
      <section className="commandPalette" aria-modal="true" aria-labelledby="command-palette-title" role="dialog">
        <header className="commandPaletteSearch">
          {loading ? <LoaderCircle className="spin" size={18} /> : <Search size={18} />}
          <input ref={inputRef} aria-label="全局搜索" onChange={(event) => { setQuery(event.target.value); setSelectedIndex(0); }} onKeyDown={onKeyDown} placeholder="搜索问题、PR、任务、飞书消息或 Codex 会话..." value={query} />
          <button className="iconButton" onClick={onClose} title="关闭"><X size={16} /></button>
        </header>
        <h2 className="visuallyHidden" id="command-palette-title">全局搜索</h2>
        <div className="commandPaletteResults" role="listbox" aria-label="搜索结果">
          {items.map((item, index) => {
            const showGroup = item.group !== previousGroup;
            previousGroup = item.group;
            const Icon = item.icon;
            return (
              <div key={item.id}>
                {showGroup && <p className="commandPaletteGroup">{item.group}</p>}
                <button className={index === selectedIndex ? "selected" : ""} onClick={() => selectItem(item)} onMouseMove={() => setSelectedIndex(index)} role="option" aria-selected={index === selectedIndex} type="button">
                  <span className="commandPaletteIcon"><Icon size={16} /></span>
                  <span className="commandPaletteContent"><strong>{item.title}</strong><small>{item.subtitle}</small></span>
                </button>
              </div>
            );
          })}
          {!loading && items.length === 0 && <div className="emptyState compact">没有找到匹配内容。</div>}
          {error && <div className="error">搜索数据加载失败：{error}</div>}
        </div>
        <footer className="commandPaletteFooter"><span><kbd>↑</kbd><kbd>↓</kbd> 选择</span><span><kbd>Enter</kbd> 打开</span><span><kbd>Esc</kbd> 关闭</span></footer>
      </section>
    </div>
  );
}
