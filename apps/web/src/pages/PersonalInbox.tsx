import { useEffect, useState } from "react";
import { Inbox, RefreshCw, Send, Pause, Play, Check } from "lucide-react";
import "./personalInbox.css";

type Message = { id: number; chatType: string; chatName: string; senderName: string; content: string; sourceTime: string;
  status: string; draft: string; summary: string; question: string; error: string | null; version: number };
type Snapshot = { status: { enabled: boolean; autoReply: boolean; busy: boolean; activatedAt: string; lastSyncAt: string;
  canSend: boolean; lastError: string | null }; messages: Message[] };
const labels: Record<string, string> = { pending: "等待分析", reviewing: "分析中", needs_owner: "需要你确认", ready: "待发送",
  awaiting_auth: "待本人发送授权", sending: "发送中", sent: "已代为回复", send_unknown: "请核对发送结果", dismissed: "已处理",
  owner_replied: "你已亲自回复" };
async function request<T>(url: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(`/api/personal-inbox${url}`, { method, headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? "请求失败");
  return value;
}
function InboxMessage({ message, onAction, busy }: { message: Message; onAction: (message: Message, action: string, text: string) => void; busy: boolean }) {
  const [draft, setDraft] = useState(message.draft);
  useEffect(() => setDraft(message.draft), [message.id, message.draft]);
  const editable = ["needs_owner", "ready", "awaiting_auth"].includes(message.status);
  return <article className="personalInboxMessage">
    <div className="personalInboxMessageHeader"><strong>{message.senderName}</strong><span className="subtle">{message.chatType === "group" ? `群里 @你 · ${message.chatName}` : "个人私聊"}</span>
      <span className={`inboxState ${message.status}`}>{labels[message.status] ?? message.status}</span></div>
    <div className="subtle">#{message.id} · {message.sourceTime}</div>
    <p className="personalInboxContent">{message.content}</p>
    {message.summary && <p className="subtle">{message.summary}</p>}
    {message.question && <p className="inboxQuestion">{message.question}</p>}
    {message.error && <p role="status" className="inboxWarning">{message.error}</p>}
    {editable ? <><label className="inboxDraftLabel">回复草稿<textarea value={draft} onChange={event => setDraft(event.target.value)} maxLength={2000} rows={3} /></label>
      <div className="actionGroup"><button disabled={busy || !draft.trim()} onClick={() => onAction(message, "send", draft)}><Send size={15} />确认以我身份回复</button>
        <button className="ghostButton" disabled={busy} onClick={() => onAction(message, "dismiss", "")}><Check size={15} />标记已处理</button></div>
      <p className="subtle">发送会注明“小龙的助手龙小祝代为回复”，并先检查你是否已经亲自回复。</p></>
      : message.draft && <p className="personalInboxContent">回复：{message.draft}</p>}
  </article>;
}
export function PersonalInboxPage() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("attention");
  const load = async () => setSnapshot(await request<Snapshot>(""));
  useEffect(() => {
    void load().catch(error => setError(String(error)));
    const timer = window.setInterval(() => { if (!document.hidden) void load().catch(error => setError(String(error))); }, 10_000);
    return () => window.clearInterval(timer);
  }, []);
  const perform = async (action: () => Promise<unknown>) => {
    setBusy(true); setError(""); try { await action(); await load(); } catch (error) { setError(String(error)); } finally { setBusy(false); }
  };
  const status = snapshot?.status;
  const messages = snapshot?.messages.filter(message => filter === "all" || !["sent", "dismissed", "owner_replied"].includes(message.status)) ?? [];
  return <section className="pageStack">
    <div className="heroBand"><div><p className="eyebrow">小龙的消息代理</p><h2><Inbox size={23} />个人收件箱</h2>
      <p className="subtle">接收别人私聊你、群里直接 @你的新消息。普通问候自动处理，其他消息先整理草稿并向你请示。</p></div>
      <div className="actionGroup"><button className="ghostButton" disabled={busy} onClick={() => void perform(() => request("/sync", "POST", {}))}><RefreshCw size={16} />立即同步</button>
        <button disabled={busy || !status} onClick={() => void perform(() => request("", "PATCH", { enabled: !status?.enabled }))}>{status?.enabled ? <Pause size={16} /> : <Play size={16} />}{status?.enabled ? "暂停接收" : "开启接收"}</button></div></div>
    {error && <p role="alert" className="inboxWarning">{error}</p>}
    <div className="personalInboxStatus"><span>{status?.enabled ? status.busy ? "同步处理中" : "已开启 · 每分钟同步" : "未开启"}</span>
      <span>{status?.canSend ? "本人发送授权已就绪" : "以本人身份发送尚待授权"}</span>
      <span>最近同步：{status?.lastSyncAt ? new Date(status.lastSyncAt).toLocaleString() : "暂无"}</span>
      <label><input type="checkbox" checked={status?.autoReply ?? true} disabled={busy || !status} onChange={event => void perform(() => request("", "PATCH", { autoReply: event.target.checked }))} />自动回复普通问候</label></div>
    {status?.lastError && <p role="alert" className="inboxWarning">同步异常：{status.lastError}</p>}
    <div className="actionGroup"><button className={filter === "attention" ? "" : "ghostButton"} onClick={() => setFilter("attention")}>待处理</button><button className={filter === "all" ? "" : "ghostButton"} onClick={() => setFilter("all")}>全部记录</button></div>
    {!messages.length && <div className="emptyState">{status?.enabled ? "还没有待处理的新消息。首次开启只采集之后的新消息，不自动处理历史记录。" : "开启后，将个人私聊和群里 @你的消息收进这里。"}</div>}
    {messages.map(message => <InboxMessage key={message.id} message={message} busy={busy} onAction={(message, action, text) => void perform(() => request(`/${message.id}/decision`, "POST", { action, text, version: message.version }))} />)}
  </section>;
}
