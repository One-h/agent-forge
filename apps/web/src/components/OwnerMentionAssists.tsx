import { useEffect, useRef, useState } from "react";
import { Check, RefreshCw, Send } from "lucide-react";
import { api, type OwnerMentionAssist } from "../api";

const labels: Record<OwnerMentionAssist["status"], string> = {
  pending: "等待分析", handling: "处理中", reconsidering: "结合新回复重新判断", ready: "已确认待投递",
  needs_owner: "需要本人确认", ignored: "无需处理", sent: "机器人已发送", dismissed: "已忽略"
};

export function OwnerMentionAssistMessage({ item, onRefresh }: { item: OwnerMentionAssist; onRefresh: () => Promise<void> }) {
  const [draft, setDraft] = useState(item.draft);
  const [version] = useState(item.version);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const stale = conflict || item.version !== version;
  const editable = item.enabled === true && item.status === "needs_owner";
  const decide = async (action: "send" | "dismiss") => {
    if (!editable || busy || stale) return;
    setBusy(true); setError("");
    try {
      const { item: saved } = await api.decideOwnerMentionAssist(item.id, { action, ...(action === "send" ? { text: draft } : {}), version });
      if (saved.id !== item.id || !(action === "send" ? ["ready", "sent"].includes(saved.status) : saved.status === "dismissed")) {
        throw new Error("处理结果未确认，请刷新记录核对。");
      }
      setConflict(true);
      await onRefresh();
    } catch (err) {
      if (err && typeof err === "object" && "statusCode" in err && err.statusCode === 409) {
        setConflict(true); setError("消息已有更新，请刷新记录后重新确认。");
      } else { setError(String(err)); }
    } finally { setBusy(false); }
  };
  return <article className="personalInboxMessage ownerMentionAssistMessage">
    <div className="personalInboxMessageHeader"><strong>群聊协同</strong><span className="inboxState">{labels[item.status] ?? item.status}</span></div>
    <div className="subtle personalInboxContent">{item.chat_id} · {item.sender_id} · #{item.id} · v{item.version}</div>
    <p className="personalInboxContent">{item.content}</p>
    {item.ownerResponses.length > 0 && <div className="ownerMentionResponses"><strong>本人群内回复</strong>{item.ownerResponses.map(response => <div key={response.id}>
      <small className="subtle personalInboxContent">{response.message_at}{response.reply_to_message_id ? ` · 回复 ${response.reply_to_message_id}` : ""}</small>
      <p className="personalInboxContent">{response.content}</p>
    </div>)}</div>}
    {item.reason && <p className="personalInboxContent subtle">原因：{item.reason}</p>}
    {item.question && <p className="inboxQuestion personalInboxContent">{item.question}</p>}
    {!item.enabled && <p className="subtle">此记录当前不可审核或发送。</p>}
    {error && <p className="inboxWarning" role="alert">{error}</p>}
    {stale && editable && <p className="inboxWarning" role="status">记录已有变化，请刷新后重新检查草稿。</p>}
    {editable ? <>
      <label className="inboxDraftLabel">机器人回复草稿<textarea disabled={busy || stale} maxLength={20_000} rows={4} value={draft} onChange={event => setDraft(event.target.value)} /></label>
      <div className="actionGroup"><button disabled={busy || stale || !draft.trim()} onClick={() => void decide("send")}><Send size={15} />确认机器人发送</button>
        <button className="ghostButton" disabled={busy || stale} onClick={() => void decide("dismiss")}><Check size={15} />忽略</button></div>
    </> : item.draft && <p className="personalInboxContent">机器人草稿：{item.draft}</p>}
  </article>;
}

export function OwnerMentionAssists() {
  const [items, setItems] = useState<OwnerMentionAssist[] | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [all, setAll] = useState(false);
  const [revision, setRevision] = useState(0);
  const active = useRef(true);
  const requestSequence = useRef(0);
  const load = async () => {
    const sequence = ++requestSequence.current;
    const result = await api.ownerMentionAssists();
    if (!Array.isArray(result.items)) throw new Error("群聊协同 API 返回了未知格式。");
    if (active.current && sequence === requestSequence.current) { setItems(result.items); setError(""); }
  };
  const refresh = async () => {
    setLoading(true);
    try { await load(); setRevision(value => value + 1); }
    catch (err) { setError(`群聊协同暂不可用：${String(err)}`); }
    finally { setLoading(false); }
  };
  useEffect(() => {
    active.current = true;
    void refresh();
    const timer = window.setInterval(() => {
      if (!document.hidden) void load().catch(err => { if (active.current) setError(`群聊协同暂不可用：${String(err)}`); });
    }, 10_000);
    return () => { active.current = false; ++requestSequence.current; window.clearInterval(timer); };
  }, []);
  const visible = items?.filter(item => all || !["sent", "dismissed", "ignored"].includes(item.status)) ?? [];
  return <section className="ownerMentionAssists" aria-label="群聊协同待确认">
    <div className="ownerMentionAssistsHeader"><h3>群聊协同待确认</h3><button className="ghostButton" disabled={loading} onClick={() => void refresh()} title="刷新群聊协同" aria-label="刷新群聊协同"><RefreshCw size={16} /></button></div>
    {error && <p className="inboxWarning" role="alert">{error}</p>}
    <label className="ownerMentionAssistsFilter"><input type="checkbox" checked={all} onChange={event => setAll(event.target.checked)} />包含已处理记录</label>
    {!items && !error && <p role="status">正在加载群聊协同…</p>}
    {items && visible.length === 0 && <p className="subtle">暂无{all ? "协同" : "待确认"}记录。</p>}
    {visible.map(item => <OwnerMentionAssistMessage key={`${item.id}:${revision}`} item={item} onRefresh={load} />)}
  </section>;
}
