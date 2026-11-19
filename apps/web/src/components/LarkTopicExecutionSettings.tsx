import { useEffect, useId, useState } from "react";
import { RefreshCw, Save } from "lucide-react";
import { api, type LarkCodexModel, type LarkTopicEngineSelection, type LarkTopicExecutionSettings as Settings } from "../api";

function errorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  try {
    const body = JSON.parse(error.message) as { message?: unknown };
    if (typeof body.message === "string") return body.message;
  } catch { /* Non-proxy errors use the local message. */ }
  return fallback;
}

function codexOnly(codexModel: NonNullable<Settings["codexModel"]>): Settings {
  const { override, effectiveModel } = codexModel;
  return { override: override ? { engineId: "codex", model: override } : null,
    effective: { engineId: "codex", model: effectiveModel }, available: true, engines: [], codexModel };
}

export function LarkTopicExecutionSettings({ chatId, threadId }: { chatId: string; threadId?: string }) {
  const engineLabelId = useId(), modelLabelId = useId(), catalogId = useId();
  const scope = threadId ? "话题" : "会话";
  const [settings, setSettings] = useState<Settings | null>(null);
  const [legacy, setLegacy] = useState(false);
  const [catalog, setCatalog] = useState<LarkCodexModel[]>([]);
  const [engineId, setEngineId] = useState("");
  const [model, setModel] = useState("");
  const [reload, setReload] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  function show(next: Settings) {
    setSettings(next);
    setEngineId(next.override?.engineId ?? (threadId ? "" : "codex"));
    setModel(next.override?.model ?? "");
  }

  useEffect(() => {
    const controller = new AbortController();
    setSettings(null);
    setLegacy(false);
    setError("");
    setNotice("");
    void (async () => {
      try {
        const next = await api.larkExecution(chatId, threadId, controller.signal);
        if (!controller.signal.aborted) show(next);
      } catch (err) {
        if (controller.signal.aborted) return;
        if (!threadId && err instanceof Error && (err as Error & { statusCode?: number }).statusCode === 404) {
          const old = await api.larkConversationSettings(chatId).catch(() => null);
          if (controller.signal.aborted) return;
          if (old?.codexModel) {
            setLegacy(true);
            show(codexOnly(old.codexModel));
            return;
          }
        }
        setError(errorMessage(err, `未能读取${scope}设置。`));
      }
    })();
    return () => controller.abort();
  }, [chatId, threadId, reload]);

  useEffect(() => {
    if (threadId || engineId !== "codex") return;
    let current = true;
    void api.larkModels().then(({ models }) => { if (current) setCatalog(models); })
      .catch(() => { if (current) setCatalog([]); });
    return () => { current = false; };
  }, [engineId, threadId, reload]);
  const engine = settings?.engines.find(entry => entry.id === engineId);
  const selectedModel = model.trim();
  const override: LarkTopicEngineSelection | null = !engineId || !threadId && engineId === "codex" && !selectedModel
    ? null : { engineId, model: selectedModel || null };
  const dirty = Boolean(settings && (override?.engineId !== settings.override?.engineId || override?.model !== settings.override?.model));
  const valid = !engineId || (engineId === "codex" ? !selectedModel || /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/.test(selectedModel)
    : Boolean(engine && (!model || engine.models.includes(model))));
  const label = (id: string) => id === "codex" ? "Codex" : settings?.engines.find(entry => entry.id === id)?.label ?? id;

  async function save() {
    if (!settings || saving || !dirty || !valid) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      if (legacy) {
        const value = override?.model ?? null;
        const { codexModel } = await api.updateLarkConversationModel(chatId, value);
        if (!codexModel || codexModel.override !== value) throw new Error("Codex model write not confirmed");
        show(codexOnly(codexModel));
      } else show(await api.updateLarkExecution(chatId, threadId, override));
      setNotice(`${scope}设置已保存。`);
    } catch (err) {
      setError(errorMessage(err, `未能保存${scope}设置，请刷新后核对。`));
    } finally { setSaving(false); }
  }

  return <section className={threadId ? "panel conversationSettingSection" : "conversationSettingSection"} aria-label={`${scope}执行设置`}>
    <div className="sectionHeader compact topicExecutionHeader">
      <h3>{scope}执行设置</h3>
      <button type="button" className="ghostButton" title={`刷新${scope}设置`} aria-label={`刷新${scope}设置`} disabled={saving} onClick={() => setReload(value => value + 1)}><RefreshCw size={16} /></button>
    </div>
    {error && <div className="error" role="alert">{error}</div>}
    {notice && <div className="notice" role="status">{notice}</div>}
    {!settings ? !error && <span className="muted" role="status">正在读取{scope}设置…</span> : <>
      <dl className="meta topicExecutionMeta">
        {threadId && <><dt>话题 ID</dt><dd className="mono">{threadId}</dd></>}
        <dt>当前生效</dt><dd>{label(settings.effective.engineId)} · {settings.effective.model ?? "默认模型"}</dd>
      </dl>
      {!settings.available && <div className="notice" role="status">当前{scope}的引擎或模型不可用。</div>}
      {!settings.engines.length && settings.available && <span className="muted">Lark Agent 尚未注册外部引擎。</span>}
      <label className="personaField topicExecutionField"><span id={engineLabelId}>执行引擎</span>
        <select aria-labelledby={engineLabelId} value={engineId} disabled={saving} onChange={event => {
          const id = event.target.value;
          setEngineId(id);
          setModel(!threadId && id === "codex" ? settings.codexModel?.override ?? "" : "");
          setNotice("");
        }}>
          {threadId && <option value="">继承群聊 · {label(settings.inherited?.engineId ?? "codex")}</option>}
          <option value="codex">Codex</option>
          {engineId && engineId !== "codex" && !engine && <option value={engineId} disabled>{engineId}（不可用）</option>}
          {settings.engines.map(entry => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
        </select>
      </label>
      {!threadId && engineId === "codex" && <>
        <label className="personaField topicExecutionField"><span id={modelLabelId}>模型</span>
          <input aria-labelledby={modelLabelId} list={catalogId} maxLength={120} value={model} disabled={saving} aria-invalid={!valid}
            placeholder={settings.codexModel?.globalModel ?? "默认模型"} onChange={event => { setModel(event.target.value); setNotice(""); }} />
        </label>
        <datalist id={catalogId}>{catalog.map(entry => <option key={entry.id} value={entry.id}>{entry.displayName}</option>)}</datalist>
      </>}
      {engineId && engineId !== "codex" && <label className="personaField topicExecutionField"><span id={modelLabelId}>模型</span>
        <select aria-labelledby={modelLabelId} value={model} disabled={saving || !engine} onChange={event => { setModel(event.target.value); setNotice(""); }}>
          <option value="">引擎默认模型</option>
          {model && !engine?.models.includes(model) && <option value={model} disabled>{model}（不可用）</option>}
          {engine?.models.map(id => <option key={id} value={id}>{id}</option>)}
        </select>
      </label>}
      <div className="inlineActions">
        <button type="button" className="primaryButton" disabled={saving || !dirty || !valid} onClick={() => void save()}><Save size={16} /> 保存{scope === "话题" ? "话题设置" : "执行设置"}</button>
      </div>
    </>}
  </section>;
}
