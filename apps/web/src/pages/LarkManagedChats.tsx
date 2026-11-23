import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { ExternalLink, RefreshCw, UsersRound } from "lucide-react";
import { api, type LarkManagedChat, type LarkManagedChatInput, type LarkManagedChats } from "../api";
import { managedLarkChatLink } from "../components/managedLarkChatLink";
import "./larkManagedChats.css";

const labels = {
  creating: { title: "创建中", badge: "queued" },
  ready: { title: "已就绪", badge: "done" },
  attention: { title: "待核对", badge: "blocked" }
} as const;

function errorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  try {
    const body = JSON.parse(error.message) as { code?: string; message?: string } | null;
    if (body?.code === "LARK_AGENT_NOT_CONFIGURED") return "Forge 尚未配置 Lark Agent 或运行时令牌。";
    if (body?.code === "LARK_AGENT_UNAVAILABLE") return fallback;
    if (typeof body?.message === "string") return body.message;
  } catch { /* Network and parsing failures use the local message. */ }
  return fallback;
}

function ChatRow({ item, engines }: { item: LarkManagedChat; engines: LarkManagedChats["engines"] }) {
  const link = managedLarkChatLink(item.chatId, item.openUrl);
  const date = new Date(item.createdAt);
  const execution = item.execution;
  const engineLabel = execution && (engines.find(engine => engine.id === execution.engineId)?.label ?? execution.engineId);
  const status = labels[item.status];
  return <li className="managedChatRow">
    <div className="managedChatSummary">
      <div className="managedChatTitle"><strong>{item.name}</strong><span className={`badge ${status.badge}`}>{status.title}</span></div>
      <div className="managedChatMeta subtle">
        {Number.isFinite(date.getTime()) && <time dateTime={item.createdAt}>{date.toLocaleString()}</time>}
        <span>{item.persona?.name ?? "默认人设"}</span>
        <span>{execution ? `${engineLabel} · ${execution.model ?? "默认模型"}` : "默认引擎与模型"}</span>
      </div>
      {item.error && <p className="managedChatWarning">{item.error}</p>}
    </div>
    {link && <a className="managedChatOpen" href={link} target="_blank" rel="noopener noreferrer" aria-label={`在飞书打开 ${item.name}`}>
      <ExternalLink size={15} aria-hidden="true" /> 在飞书打开
    </a>}
  </li>;
}

export function LarkManagedChatsPage() {
  const engineLabelId = useId();
  const modelLabelId = useId();
  const [snapshot, setSnapshot] = useState<LarkManagedChats | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [name, setName] = useState("");
  const [customPersona, setCustomPersona] = useState(false);
  const [personaName, setPersonaName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [engineId, setEngineId] = useState("");
  const [model, setModel] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const [canEdit, setCanEdit] = useState(false);
  const attempt = useRef<LarkManagedChatInput | null>(null);
  const inFlight = useRef(false);

  function showResult(item: LarkManagedChat) {
    attempt.current = null;
    setName("");
    setCustomPersona(false);
    setPersonaName("");
    setInstructions("");
    setEngineId("");
    setModel("");
    setCreateError("");
    setCanEdit(false);
    setAnnouncement(`${item.name}：${labels[item.status].title}`);
  }

  useEffect(() => {
    const controller = new AbortController();
    void api.larkManagedChats(controller.signal).then(next => {
      if (controller.signal.aborted) return;
      setSnapshot(next);
      const item = next.items.find(row => row.requestId === attempt.current?.requestId);
      if (item) showResult(item);
    }).catch(error => {
      if (!controller.signal.aborted) setLoadError(errorMessage(error, "未能读取飞书群聊，请重试。"));
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [refresh]);

  function refreshList() {
    setLoadError("");
    setLoading(true);
    setRefresh(value => value + 1);
  }

  const engines = snapshot?.engines ?? [];
  const engine = engines.find(entry => entry.id === engineId);
  const validModel = !model || Boolean(engine?.models.includes(model));
  const valid = Boolean(name.trim() && [...name.trim()].length <= 60
    && (!customPersona || personaName.trim() && instructions.trim()) && (!engineId || engine && validModel));
  const retrying = Boolean(createError);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current || loading || !snapshot || (!attempt.current && !valid)) return;
    const input: LarkManagedChatInput = attempt.current ?? {
      requestId: crypto.randomUUID(), name: name.trim(),
      ...(customPersona ? { persona: { mode: "custom", name: personaName.trim(), instructions: instructions.trim() } } : {}),
      ...(engine ? { execution: { engineId: engine.id, model: model || null } } : {})
    };
    attempt.current = input;
    inFlight.current = true;
    setCreating(true);
    setCreateError("");
    setAnnouncement("");
    setCanEdit(false);
    try {
      const { item } = await api.createLarkManagedChat(input);
      setSnapshot(current => current && { ...current, items: [item, ...current.items.filter(row => row.requestId !== item.requestId)] });
      showResult(item);
    } catch (error) {
      const status = (error as { statusCode?: number } | null)?.statusCode;
      const rejected = status === 400 || status === 422;
      const message = errorMessage(error, rejected ? "创建请求未通过校验。" : "未能确认建群结果。");
      setCreateError(rejected ? message : `${message} 请重试原请求或刷新列表核对。`);
      setCanEdit(rejected);
    } finally {
      inFlight.current = false;
      setCreating(false);
    }
  }

  return <section className="pageStack managedChatsPage" aria-labelledby="managed-chats-heading">
    <header className="managedChatsHeader">
      <h2 id="managed-chats-heading">飞书群聊</h2>
    </header>
    <section className="conversationSettingSection managedChatComposer" aria-labelledby="create-managed-chat-heading">
      <div className="sectionHeader"><h3 id="create-managed-chat-heading">新建私有群</h3></div>
      <p className="subtle managedChatMembers">成员：你和已连接的飞书机器人</p>
      <form className="managedChatForm" onSubmit={event => void create(event)}>
        <fieldset disabled={creating || retrying || !snapshot}>
          <label className="personaField managedChatFullWidth"><span>群名称</span>
            <input required maxLength={60} value={name} onChange={event => setName(event.target.value)} />
          </label>
          <label className="personaField"><span id={engineLabelId}>运行引擎</span>
            <select aria-labelledby={engineLabelId} value={engineId} onChange={event => { setEngineId(event.target.value); setModel(""); }}>
              <option value="">使用默认引擎</option>
              {engineId && !engine && <option value={engineId} disabled>{engineId}（不可用）</option>}
              {engines.map(entry => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
            </select>
          </label>
          <label className="personaField"><span id={modelLabelId}>模型</span>
            <select aria-labelledby={modelLabelId} value={model} disabled={!engine?.models.length} onChange={event => setModel(event.target.value)}>
              <option value="">{engine ? "引擎默认模型" : "使用默认模型"}</option>
              {model && !validModel && <option value={model} disabled>{model}（不可用）</option>}
              {engine?.models.map(value => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <label className="managedChatPersonaToggle">
            <input type="checkbox" checked={customPersona} onChange={event => setCustomPersona(event.target.checked)} /> 自定义人设
          </label>
          {customPersona && <>
            <label className="personaField managedChatFullWidth"><span>人设名称</span>
              <input required maxLength={80} value={personaName} onChange={event => setPersonaName(event.target.value)} />
            </label>
            <label className="personaField managedChatFullWidth"><span>人设指令</span>
              <textarea required rows={4} maxLength={4000} value={instructions} onChange={event => setInstructions(event.target.value)} />
            </label>
          </>}
        </fieldset>
        {createError && <div className="error" role="alert">{createError}</div>}
        <div className="managedChatActions">
          <button className="primaryButton" type="submit" disabled={creating || loading || !snapshot || (!retrying && !valid)}>
            <UsersRound size={16} aria-hidden="true" /> {creating ? "创建中…" : retrying ? "重试原请求" : "创建私有群"}
          </button>
          {canEdit && <button className="ghostButton" type="button" onClick={() => {
            attempt.current = null;
            setCanEdit(false);
            setCreateError("");
          }}>修改表单</button>}
          {announcement && <span className="subtle" role="status">{announcement}</span>}
        </div>
      </form>
    </section>
    <section className="conversationSettingSection managedChatHistory" aria-labelledby="managed-chat-history-heading">
      <div className="sectionHeader">
        <h3 id="managed-chat-history-heading">应用创建的群</h3>
        <button type="button" className="iconButton" title="刷新群聊列表" aria-label="刷新群聊列表" disabled={loading || creating} onClick={refreshList}>
          <RefreshCw size={16} aria-hidden="true" />
        </button>
      </div>
      {loading && <p className="subtle" role="status">正在读取飞书群聊…</p>}
      {loadError && <div className="error" role="alert">{loadError}</div>}
      {!loading && !loadError && snapshot?.items.length === 0 && <div className="emptyState">暂无应用创建的群聊。</div>}
      {!!snapshot?.items.length && <ul className="managedChatList" aria-label="应用创建的群">
        {snapshot.items.map(item => <ChatRow key={item.requestId} item={item} engines={engines} />)}
      </ul>}
    </section>
  </section>;
}
