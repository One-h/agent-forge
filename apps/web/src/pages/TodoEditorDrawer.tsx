import { useState } from "react";
import { ExternalLink, Trash2, X } from "lucide-react";
import type { CodexTodoStatus } from "../api";
import type { TodoPriority, TodoReminderFrequency, TodoWorkflowPatch, TodoWorkflowTodo } from "../todoWorkflowApi";
import { formatTime, statusText } from "../i18n";

const priorities: Array<{ value: TodoPriority; label: string }> = [
  { value: "urgent", label: "紧急" },
  { value: "high", label: "高" },
  { value: "normal", label: "普通" },
  { value: "low", label: "低" }
];
const frequencies: Array<{ value: TodoReminderFrequency; label: string }> = [
  { value: "none", label: "不提醒" },
  { value: "every_2_hours", label: "每 2 小时" },
  { value: "daily", label: "每天" },
  { value: "weekly", label: "每周" }
];

function localDateTime(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function sourceLabel(todo: TodoWorkflowTodo): string {
  if (todo.source_lark_message_id) return todo.source_chat_type === "group" ? "飞书群聊" : "飞书联系人";
  if (todo.source_type === "issue_repair") return "Issue 修复";
  return "手动创建";
}

export function TodoEditorDrawer(props: {
  todo: TodoWorkflowTodo;
  statuses: CodexTodoStatus[];
  onClose: () => void;
  onSave: (patch: TodoWorkflowPatch) => Promise<void>;
  onDelete: () => Promise<void>;
  onOpenCodex: () => void;
  onOpenRun: () => void;
}) {
  const { todo } = props;
  const [title, setTitle] = useState(todo.title);
  const [description, setDescription] = useState(todo.description ?? "");
  const [status, setStatus] = useState(todo.status);
  const [priority, setPriority] = useState(todo.priority);
  const [tags, setTags] = useState(todo.tags.join("、"));
  const [dueAt, setDueAt] = useState(localDateTime(todo.due_at));
  const [frequency, setFrequency] = useState(todo.reminder_frequency);
  const [completionResult, setCompletionResult] = useState(todo.completion_result ?? "");
  const [notifyOnCompletion, setNotifyOnCompletion] = useState(Boolean(todo.notify_on_completion));
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!title.trim()) return;
    setSaving(true);
    try {
      await props.onSave({
        title: title.trim(),
        description: description.trim() || null,
        status,
        priority,
        tags: tags.split(/[,，、;；\n]+/).map((tag) => tag.trim()).filter(Boolean),
        dueAt: dueAt ? new Date(dueAt).toISOString() : null,
        reminderFrequency: frequency,
        completionResult: completionResult.trim() || null,
        notifyOnCompletion
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="drawerLayer">
      <button className="drawerBackdrop" aria-label="关闭待办编辑器" onClick={props.onClose} />
      <aside className="detailDrawer todoEditorDrawer">
        <header className="todoEditorHeader">
          <div className="todoEditorTitle">
            <p className="eyebrow">待办详情</p>
            <h2>{todo.title}</h2>
            <div className="todoEditorBadges">
              <span className={`statusPill ${todo.status}`}>{statusText(todo.status)}</span>
              <span className={`todoPriorityBadge priority-${todo.priority}`}>{priorities.find((item) => item.value === todo.priority)?.label}</span>
            </div>
          </div>
          <button className="iconButton" onClick={props.onClose} title="关闭"><X size={16} /></button>
        </header>
        <div className="drawerBody todoEditorBody">
          <section className="todoEditorSection todoWorkflowGrid">
            <label className="todoWorkflowWide"><span>标题</span><input value={title} onChange={(event) => setTitle(event.target.value)} /></label>
            <label className="todoWorkflowWide"><span>描述</span><textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="添加备注、下一步或验收说明。" /></label>
            <label><span>状态</span><select value={status} onChange={(event) => setStatus(event.target.value as CodexTodoStatus)}>{props.statuses.map((item) => <option key={item} value={item}>{statusText(item)}</option>)}</select></label>
            <label><span>优先级</span><select value={priority} onChange={(event) => setPriority(event.target.value as TodoPriority)}>{priorities.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
            <label><span>截止时间</span><input type="datetime-local" value={dueAt} onChange={(event) => setDueAt(event.target.value)} /></label>
            <label><span>提醒频率</span><select value={frequency} onChange={(event) => setFrequency(event.target.value as TodoReminderFrequency)}>{frequencies.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
            <label className="todoWorkflowWide"><span>标签</span><input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="产品、数据、紧急" /></label>
            <label className="todoWorkflowWide"><span>完成结果</span><textarea value={completionResult} onChange={(event) => setCompletionResult(event.target.value)} placeholder="完成后填写；保存为已完成时可回告原联系人或群。" /></label>
            <label className="todoNotifyToggle todoWorkflowWide"><input type="checkbox" checked={notifyOnCompletion} onChange={(event) => setNotifyOnCompletion(event.target.checked)} /><span>完成后回复原飞书会话</span></label>
          </section>
          <section className="todoEditorSection">
            <div className="todoEditorSectionHeader"><h3>关联信息</h3></div>
            <dl className="todoEditorMeta">
              <dt>来源</dt><dd>{sourceLabel(todo)}</dd>
              <dt>会话</dt><dd className="mono">{todo.effective_codex_session_id ?? "-"}</dd>
              <dt>飞书会话</dt><dd className="mono">{todo.source_chat_id ?? "-"}</dd>
              <dt>提醒</dt><dd>{todo.next_reminder_at ? formatTime(todo.next_reminder_at) : "未安排"}</dd>
              <dt>更新</dt><dd>{formatTime(todo.updated_at)}</dd>
            </dl>
          </section>
          <div className="todoEditorFooter">
            <div className="todoEditorActions">
              <button className="primaryButton" disabled={saving || !title.trim()} onClick={() => void save()}>{saving ? "保存中…" : "保存"}</button>
              <button className="ghostButton" disabled={!todo.codex_thread_url} onClick={props.onOpenCodex}><ExternalLink size={14} /> Codex</button>
              {todo.job_id && <button className="ghostButton" onClick={props.onOpenRun}>运行记录</button>}
            </div>
            <button className="ghostButton dangerButton" onClick={() => void props.onDelete()}><Trash2 size={14} /> 删除待办</button>
          </div>
        </div>
      </aside>
    </div>
  );
}
