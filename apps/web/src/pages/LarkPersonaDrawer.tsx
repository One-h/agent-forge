import { useEffect, useState } from "react";
import { Eye, RotateCcw, Save } from "lucide-react";
import { api, type ConversationSettings, type ConversationSpontaneousReply, type ConversationStickerUsage, type ConversationStyle, type LarkCodexSession, type LarkCodexSessions, type PersonaInput } from "../api";
import { DetailDrawer } from "../components/DetailDrawer";

export function LarkPersonaDrawer({ chatId, chatType, title, onClose, onSessionReset }: { chatId: string; chatType: "group" | "p2p"; title: string; onClose: () => void; onSessionReset?: () => void }) {
  const [saved, setSaved] = useState<ConversationStyle | null>(null);
  const [conversationSettings, setConversationSettings] = useState<ConversationSettings | null>(null);
  const [draft, setDraft] = useState<PersonaInput>({ mode: "default", name: "", instructions: "" });
  const [preview, setPreview] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [sessions, setSessions] = useState<LarkCodexSessions | null>(null);
  const [sessionsError, setSessionsError] = useState("");
  const [confirmSession, setConfirmSession] = useState("");
  const [spontaneousMode, setSpontaneousMode] = useState<ConversationSpontaneousReply["mode"]>("global");
  const [spontaneousPercent, setSpontaneousPercent] = useState("8");
  const [spontaneousCooldownMinutes, setSpontaneousCooldownMinutes] = useState("10");
  const syncSpontaneousDraft = (settings: ConversationSettings) => {
    const spontaneous = settings.spontaneousReply;
    setSpontaneousMode(spontaneous.mode);
    setSpontaneousPercent(String(Number(((spontaneous.mode === "global" ? spontaneous.globalReplyRate : spontaneous.replyRate) * 100).toFixed(2))));
    setSpontaneousCooldownMinutes(String(Number(((spontaneous.mode === "global" ? spontaneous.globalCooldownMs : spontaneous.cooldownMs) / 60_000).toFixed(2))));
  };
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    void Promise.all([api.larkPersona(chatId), api.larkConversationSettings(chatId)]).then(([result, settings]) => {
      if (cancelled) return;
      setSaved(result);
      setConversationSettings(settings);
      syncSpontaneousDraft(settings);
      setDraft(result.persona);
      setPreview("");
    }).catch((err) => { if (!cancelled) setError(String(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [chatId, reload]);
  useEffect(() => {
    let cancelled = false;
    setSessions(null);
    setSessionsError("");
    void api.larkCodexSessions(chatId).then((result) => { if (!cancelled) setSessions(result); })
      .catch((err) => { if (!cancelled) setSessionsError(String(err)); });
    return () => { cancelled = true; };
  }, [chatId, reload]);
  const resetSession = async (session: LarkCodexSession) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api.resetLarkCodexSession(chatId, session.sessionKey, session.codexSessionId);
      setSessions(await api.larkCodexSessions(chatId));
      setConfirmSession("");
      setNotice("会话已重置。历史消息和旧 Codex 会话仍保留；下一条消息将开启新会话。");
      onSessionReset?.();
    } catch (err) { setError(String(err)); }
    finally { setBusy(false); }
  };
  const sessionLabel = (session: LarkCodexSession) => {
    const location = session.sessionKey.includes("::topic:") ? "话题" : session.sessionKey.includes("::main-v2::") ? "主群聊" : "单聊/旧会话";
    return `${location} · ${session.trustScope === "trusted" ? "可信" : "非可信"}`;
  };
  const edit = (patch: Partial<PersonaInput>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setPreview("");
    setNotice("");
  };
  const invalid = draft.mode === "custom" && (!draft.name.trim() || !draft.instructions.trim());
  const dirty = saved && (draft.mode !== saved.persona.mode || (draft.mode === "custom" &&
    (draft.name !== saved.persona.name || draft.instructions !== saved.persona.instructions)));
  const act = async (kind: "save" | "preview" | "reset") => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const input: PersonaInput = kind === "reset" ? { mode: "default", name: "", instructions: "" } : draft;
      const result = kind === "preview" ? await api.previewLarkPersona(chatId, input) : await api.saveLarkPersona(chatId, input);
      setPreview(kind === "preview" ? result.effectiveInstructions : "");
      if (kind !== "preview") {
        setSaved(result);
        setDraft(result.persona);
        setNotice("已保存；当前轮次（含追加消息）保持原人设，下轮对话使用新配置。");
      }
    } catch (err) { setError(String(err)); }
    finally { setBusy(false); }
  };
  const updateStickerUsage = async (mode: ConversationStickerUsage["mode"]) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await api.updateLarkConversationSettings(chatId, mode);
      setConversationSettings(result);
      setNotice("表情包策略已保存，将在下一轮对话生效。");
    } catch (err) { setError(String(err)); }
    finally { setBusy(false); }
  };
  const rate = Number(spontaneousPercent) / 100;
  const cooldownMs = Math.round(Number(spontaneousCooldownMinutes) * 60_000);
  const spontaneousInvalid = spontaneousMode === "on" && (!spontaneousPercent.trim() || !Number.isFinite(rate) || rate < 0 || rate > 1
    || !spontaneousCooldownMinutes.trim() || !Number.isFinite(cooldownMs) || cooldownMs < 0 || cooldownMs > 604_800_000);
  const currentSpontaneous = conversationSettings?.spontaneousReply;
  const spontaneousDirty = currentSpontaneous && (spontaneousMode !== currentSpontaneous.mode || spontaneousMode === "on" &&
    (Math.abs(rate - currentSpontaneous.replyRate) > 0.00001 || cooldownMs !== currentSpontaneous.cooldownMs));
  const updateSpontaneousReply = async () => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await api.updateLarkSpontaneousReply(chatId, {
        spontaneousMode,
        ...(spontaneousMode === "on" ? { spontaneousReplyRate: rate, spontaneousReplyCooldownMs: cooldownMs } : {})
      });
      setConversationSettings(result);
      syncSpontaneousDraft(result);
      setNotice("群聊随机插话设置已保存，下一条消息起生效。");
    } catch (err) { setError(String(err)); }
    finally { setBusy(false); }
  };
  const stickerModeLabels: Record<ConversationStickerUsage["effectiveMode"], string> = { off: "关闭", explicit: "明确请求", natural: "自然使用", always: "每次回复" };
  return <DetailDrawer title="会话设置" kicker={title} onClose={onClose} className="personaDrawer"
    footer={!loading && saved && conversationSettings ? <>
      <div className="personaSaveState">{dirty ? "有未保存的修改" : `已保存 · 版本 ${saved.persona.version}`}</div>
      <div className="personaFooterActions">
        <button type="button" className="ghostButton" disabled={busy || saved.persona.mode === "default"} onClick={() => void act("reset")}><RotateCcw size={15} /> 默认人设</button>
        <button type="button" className="primaryButton" disabled={busy || invalid || !dirty} onClick={() => void act("save")}><Save size={15} /> 保存</button>
      </div>
    </> : undefined}>
    <div className="personaEditor">
      {error && <div className="error" role="alert">{error}</div>}
      {notice && <div className="notice" role="status">{notice}</div>}
      {loading ? <p role="status">正在加载会话设置…</p> : !saved || !conversationSettings ? <button onClick={() => setReload((value) => value + 1)}>重试</button> : <>
        <section className="conversationSettingSection">
          <div><strong>会话人设</strong><p>覆盖全局飞书助手的表达风格。当前轮次（含追加消息）保持原人设，下轮对话使用新配置。</p></div>
        <div className="segmentedControl personaMode" aria-label="人设模式">
          <button type="button" disabled={busy} aria-pressed={draft.mode === "default"} className={draft.mode === "default" ? "active" : ""} onClick={() => edit({ mode: "default" })}>使用默认</button>
          <button type="button" disabled={busy} aria-pressed={draft.mode === "custom"} className={draft.mode === "custom" ? "active" : ""} onClick={() => edit({ mode: "custom" })}>自定义</button>
        </div>
        {draft.mode === "custom" && <>
          <label className="personaField"><span>人设名称</span><input disabled={busy} maxLength={80} value={draft.name} onChange={(event) => edit({ name: event.target.value })} /></label>
          <label className="personaField"><span>人设描述</span><textarea disabled={busy} rows={12} maxLength={4000} value={draft.instructions} onChange={(event) => edit({ instructions: event.target.value })} /><small className="personaCharacterCount">{draft.instructions.length} / 4000</small></label>
        </>}
        {draft.mode === "default" && <p className="personaDefaultState">当前使用全局飞书助手人设。</p>}
        </section>
        <section className="conversationSettingSection">
          <div><strong>表情包使用</strong><p>当前生效：{stickerModeLabels[conversationSettings.stickerUsage.effectiveMode]}。选择“跟随全局”时使用全局策略。</p></div>
          <div className="segmentedControl conversationStickerMode" aria-label="本会话表情包使用策略" role="radiogroup">
            {([
              ["global", "跟随全局"],
              ["off", "关闭"],
              ["explicit", "明确请求"],
              ["natural", "自然使用"],
              ["always", "每次回复"]
            ] as const).map(([value, label]) => <button aria-checked={conversationSettings.stickerUsage.mode === value} className={conversationSettings.stickerUsage.mode === value ? "active" : ""} disabled={busy} key={value} onClick={() => void updateStickerUsage(value)} role="radio" type="button">{label}</button>)}
          </div>
          <small>全局当前为：{stickerModeLabels[conversationSettings.stickerUsage.globalMode]}</small>
        </section>
        {chatType === "group" && <section className="conversationSettingSection">
          <div><strong>随机加入群聊</strong><p>{conversationSettings.spontaneousReply.effectiveEnabled
            ? `当前概率 ${Number((conversationSettings.spontaneousReply.effectiveReplyRate * 100).toFixed(2))}%，冷却 ${Number((conversationSettings.spontaneousReply.effectiveCooldownMs / 60_000).toFixed(2))} 分钟。`
            : conversationSettings.spontaneousReply.mode === "global" && !conversationSettings.spontaneousReply.globallyAllowed ? "当前未在全局白名单中。" : "当前关闭。"}</p></div>
          <div className="segmentedControl spontaneousMode" aria-label="群聊随机插话模式" role="radiogroup">
            {([ ["global", "跟随全局"], ["on", "开启"], ["off", "关闭"] ] as const).map(([value, label]) => <button aria-checked={spontaneousMode === value} className={spontaneousMode === value ? "active" : ""} disabled={busy} key={value} onClick={() => { setSpontaneousMode(value); setNotice(""); }} role="radio" type="button">{label}</button>)}
          </div>
          {spontaneousMode === "on" && <div className="conversationSpontaneousFields">
            <label><span>回复概率（%）</span><input disabled={busy} max={100} min={0} onChange={(event) => setSpontaneousPercent(event.target.value)} step={0.1} type="number" value={spontaneousPercent} /></label>
            <label><span>冷却（分钟）</span><input disabled={busy} max={10080} min={0} onChange={(event) => setSpontaneousCooldownMinutes(event.target.value)} step={0.1} type="number" value={spontaneousCooldownMinutes} /></label>
          </div>}
          <button className="primaryButton spontaneousSaveButton" disabled={busy || spontaneousInvalid || !spontaneousDirty} onClick={() => void updateSpontaneousReply()} type="button"><Save size={15} /> 保存随机插话</button>
        </section>}
        <section className="conversationSettingSection">
          <div><strong>Codex 会话</strong><p>重置指定会话后，下一条消息会开启新线程。聊天记录及旧线程不受影响。</p></div>
          {sessionsError && <div className="error" role="alert">{sessionsError} <button type="button" onClick={() => setReload((value) => value + 1)}>重试</button></div>}
          {!sessions && !sessionsError && <p role="status">正在加载会话…</p>}
          {sessions?.active.length === 0 && <p className="personaDefaultState">当前没有活动的 Codex 会话。</p>}
          {sessions?.active.map((session) => <div className="larkSessionRow" key={session.sessionKey}>
            <div><strong>{sessionLabel(session)}</strong><a href={`codex://threads/${encodeURIComponent(session.codexSessionId)}`}>{session.codexSessionId}</a></div>
            {confirmSession === session.sessionKey ? <div className="larkSessionActions">
              <button type="button" className="ghostButton" disabled={busy} onClick={() => setConfirmSession("")}>取消</button>
              <button type="button" className="primaryButton" disabled={busy} onClick={() => void resetSession(session)}>确认重置</button>
            </div> : <button type="button" className="ghostButton" disabled={busy} onClick={() => setConfirmSession(session.sessionKey)}><RotateCcw size={15} /> 重置</button>}
          </div>)}
          {Boolean(sessions?.previous.length) && <div className="larkSessionHistory"><strong>历史线程</strong>{sessions?.previous.map((session) => <div key={`${session.sessionKey}-${session.codexSessionId}-${session.resetAt}`}><span>{sessionLabel(session)}</span><a href={`codex://threads/${encodeURIComponent(session.codexSessionId)}`}>{session.codexSessionId}</a></div>)}</div>}
        </section>
        <section className="personaPreview">
          <button type="button" className="ghostButton" aria-expanded={Boolean(preview)} aria-controls="persona-preview" disabled={busy || invalid} onClick={() => preview ? setPreview("") : void act("preview")}><Eye size={15} /> {preview ? "收起预览" : "预览完整指令"}</button>
          {preview && <pre id="persona-preview">{preview}</pre>}
        </section>
      </>}
    </div>
  </DetailDrawer>;
}
