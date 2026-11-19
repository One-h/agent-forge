import { useEffect, useId, useState } from "react";
import { RefreshCw, Save } from "lucide-react";
import { api, type LarkTopicEngineSelection, type LarkTopicExecutionSettings as Settings } from "../api";

function errorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  try {
    const body = JSON.parse(error.message) as { message?: unknown };
    if (typeof body.message === "string") return body.message;
  } catch { /* Non-proxy errors use the local message. */ }
  return fallback;
}

export function LarkTopicExecutionSettings({ chatId, threadId }: { chatId: string; threadId: string }) {
  const engineLabelId = useId(), modelLabelId = useId();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [engineId, setEngineId] = useState("");
  const [model, setModel] = useState("");
  const [reload, setReload] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  function show(next: Settings) {
    setSettings(next);
    setEngineId(next.override?.engineId ?? "");
    setModel(next.override?.model ?? "");
  }

  useEffect(() => {
    const controller = new AbortController();
    setSettings(null);
    setError("");
    setNotice("");
    void api.larkTopicExecution(chatId, threadId, controller.signal).then(next => {
      if (!controller.signal.aborted) show(next);
    }).catch(err => {
      if (!controller.signal.aborted) setError(errorMessage(err, "未能读取话题设置。"));
    });
    return () => controller.abort();
  }, [chatId, threadId, reload]);

  const engine = settings?.engines.find(entry => entry.id === engineId);
  const dirty = Boolean(settings && (engineId !== (settings.override?.engineId ?? "") || model !== (settings.override?.model ?? "")));
  const valid = !engineId || Boolean(engine && (!model || engine.models.includes(model)));
  const effectiveLabel = settings?.effective.engineId === "codex" ? "Codex"
    : settings?.engines.find(entry => entry.id === settings.effective.engineId)?.label ?? settings?.effective.engineId;

  async function save() {
    if (!settings || saving || !dirty || !valid) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const override: LarkTopicEngineSelection | null = engineId ? { engineId, model: model || null } : null;
      show(await api.updateLarkTopicExecution(chatId, threadId, override));
      setNotice("话题设置已保存。");
    } catch (err) {
      setError(errorMessage(err, "未能保存话题设置，请刷新后核对。"));
    } finally { setSaving(false); }
  }

  return <section className="panel conversationSettingSection" aria-label="话题执行设置">
    <div className="sectionHeader compact topicExecutionHeader">
      <h3>话题执行设置</h3>
      <button type="button" className="ghostButton" title="刷新话题设置" aria-label="刷新话题设置" disabled={saving} onClick={() => setReload(value => value + 1)}><RefreshCw size={16} /></button>
    </div>
    {error && <div className="error" role="alert">{error}</div>}
    {notice && <div className="notice" role="status">{notice}</div>}
    {!settings ? !error && <span className="muted" role="status">正在读取话题设置…</span> : <>
      <dl className="meta topicExecutionMeta">
        <dt>话题 ID</dt><dd className="mono">{threadId}</dd>
        <dt>当前生效</dt><dd>{effectiveLabel} · {settings.effective.model ?? "默认模型"}</dd>
      </dl>
      {!settings.available && <div className="notice" role="status">当前话题的引擎或模型不可用。</div>}
      {!settings.engines.length && settings.available && <span className="muted">Lark Agent 尚未注册外部引擎。</span>}
      <label className="personaField topicExecutionField"><span id={engineLabelId}>执行引擎</span>
        <select aria-labelledby={engineLabelId} value={engineId} disabled={saving} onChange={event => { setEngineId(event.target.value); setModel(""); setNotice(""); }}>
          <option value="">继承群聊 · Codex</option>
          {engineId && !engine && <option value={engineId} disabled>{engineId}（不可用）</option>}
          {settings.engines.map(entry => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
        </select>
      </label>
      {engineId && <label className="personaField topicExecutionField"><span id={modelLabelId}>模型</span>
        <select aria-labelledby={modelLabelId} value={model} disabled={saving || !engine} onChange={event => { setModel(event.target.value); setNotice(""); }}>
          <option value="">引擎默认模型</option>
          {model && !engine?.models.includes(model) && <option value={model} disabled>{model}（不可用）</option>}
          {engine?.models.map(id => <option key={id} value={id}>{id}</option>)}
        </select>
      </label>}
      <div className="inlineActions">
        <button type="button" className="primaryButton" disabled={saving || !dirty || !valid} onClick={() => void save()}><Save size={16} /> 保存话题设置</button>
      </div>
    </>}
  </section>;
}
