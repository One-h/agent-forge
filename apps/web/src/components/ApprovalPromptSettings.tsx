import { useEffect, useState } from "react";
import { RefreshCw, RotateCcw, Save } from "lucide-react";
import { api, type PromptSetting } from "../api";

function promptError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  try {
    const body = JSON.parse(error.message) as { error?: unknown; message?: unknown } | null;
    if (typeof body?.error === "string") return body.error;
    if (typeof body?.message === "string") return body.message;
  } catch { /* Network errors need not contain JSON. */ }
  return error.message;
}

export function ApprovalPromptSettings() {
  const [saved, setSaved] = useState<PromptSetting | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [loadVersion, setLoadVersion] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    void api.approvalPrompt(controller.signal).then(setting => {
      if (controller.signal.aborted) return;
      setSaved(setting);
      setDraft(setting.value);
    }).catch(err => {
      if (!controller.signal.aborted) setError(promptError(err));
    });
    return () => controller.abort();
  }, [loadVersion]);

  const save = async (value: string | null) => {
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const setting = await api.updateApprovalPrompt(value);
      setSaved(setting);
      setDraft(setting.value);
      setNotice(value === null ? "已还原默认规则" : "已保存审核规则");
    } catch (err) { setError(promptError(err)); }
    finally { setSaving(false); }
  };

  return <div className="settingsField">
    <label htmlFor="turnApprovalPrompt">自动审批提示词</label>
    {!saved && !error && <span className="subtle" role="status">正在加载…</span>}
    {error && <div className="error" role="alert">{error}</div>}
    {!saved && error && <div className="inlineActions">
      <button type="button" className="ghostButton" onClick={() => { setError(""); setLoadVersion(version => version + 1); }}>
        <RefreshCw size={15} /> 重试
      </button>
    </div>}
    {saved && <>
      <textarea id="turnApprovalPrompt" rows={9} value={draft} disabled={saving} maxLength={50_000}
        spellCheck={false} onChange={event => { setDraft(event.target.value); setNotice(""); }} />
      <div className="inlineActions">
        <button type="button" disabled={saving || !draft.trim() || draft.trim() === saved.value} onClick={() => void save(draft)}>
          <Save size={15} /> 保存
        </button>
        <button type="button" className="ghostButton" disabled={saving || (!saved.customized && draft === saved.defaultValue)}
          onClick={() => {
            if (saved.customized) void save(null);
            else { setDraft(saved.defaultValue); setNotice(""); setError(""); }
          }}>
          <RotateCcw size={15} /> 还原默认
        </button>
        {notice && <span className="subtle" role="status">{notice}</span>}
      </div>
    </>}
  </div>;
}
