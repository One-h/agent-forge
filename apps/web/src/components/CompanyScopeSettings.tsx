import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

type Scope = { policy: { enabled?: boolean; companyRoots: string[] } };
async function scopeRequest(patch?: { enabled?: boolean; companyRoots?: string[] }): Promise<Scope> {
  const response = await fetch("/api/group-privacy", patch === undefined ? undefined : {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(patch)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "无法连接 Lark Agent，尚未更改资料范围。");
  return data;
}

export function CompanyScopeSettings({ suggestedRoot }: { suggestedRoot: string }) {
  const [roots, setRoots] = useState("");
  const [saved, setSaved] = useState<string[] | null>(null);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const load = async () => {
    setBusy(true); setError("");
    try { const data = await scopeRequest(); setRoots(data.policy.companyRoots.join("\n")); setSaved(data.policy.companyRoots); setEnabled(typeof data.policy.enabled === "boolean" ? data.policy.enabled : null); setConfirmed(false); }
    catch (failure) { setError(String(failure)); }
    finally { setBusy(false); }
  };
  useEffect(() => { void load(); }, []);
  const edit = (value: string) => { setRoots(value); setConfirmed(false); setNotice(""); };
  const selected = roots.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  const save = async () => {
    if (busy || saved === null || (selected.length > 0 && !confirmed)) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const data = await scopeRequest({ companyRoots: selected }); setSaved(data.policy.companyRoots); setRoots(data.policy.companyRoots.join("\n")); setConfirmed(false); setEnabled(typeof data.policy.enabled === "boolean" ? data.policy.enabled : null);
      setNotice("已保存隐私保护模式的公司资料范围；不影响普通会话的工作区和工具权限。");
    } catch (failure) { setError(String(failure)); }
    finally { setBusy(false); }
  };
  const toggle = async (value: boolean) => {
    if (busy || enabled === null) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const data = await scopeRequest({ enabled: value });
      if (data.policy.enabled !== value) throw new Error("Lark Agent 未确认开关状态，请更新服务后重试。");
      setEnabled(data.policy.enabled);
      setNotice(value ? "已开启，后续群聊请求进入隐私审核。" : "已关闭，后续群聊使用普通助手；历史审核记录保留，不会自动重跑。");
    } catch (failure) { setError(String(failure)); }
    finally { setBusy(false); }
  };
  return <div className="settingsField">
    <h3>群聊隐私保护</h3>
    <label><input type="checkbox" role="switch" checked={enabled === true} disabled={busy || enabled === null} onChange={event => void toggle(event.target.checked)} />启用群聊隐私保护</label>
    <p className="subtle">默认关闭。开启后，群聊回复和操作先由你审核；关闭时使用普通助手，工具执行审批保持不变。正在执行任务时暂不能切换。</p>
    {saved !== null && enabled === null && <p role="alert">当前 Lark Agent 不支持隐私保护开关，请先更新服务。</p>}
    <details><summary>隐私保护模式的公司资料范围</summary>
    <h3>飞书助手可研究哪些公司资料？</h3>
    <p className="subtle">仅选择你确认可以提供给助手的公司项目或业务资料文件夹，可填写多个目录。接入飞书和设置 Forge 工作区都不会自动授权读取这些目录。模型分析使用当前配置的模型服务。</p>
    <p className="subtle">不要选择整个硬盘、个人主目录或混合个人资料的上级目录。macOS 可在 Finder 选中文件夹，按 ⌥⌘C 复制完整路径后粘贴；个人资料请放在允许范围外。</p>
    <p role="status">{saved === null ? "尚未读取到资料范围；请先连接 Lark Agent。" : saved.length ? `当前已允许 ${saved.length} 个公司目录：${saved.join("、")}` : "当前没有授权任何本机目录。可以保持为空，稍后再配置。"}</p>
    {saved !== null && <>
      <label>公司资料目录（每行一个绝对路径）<textarea rows={3} disabled={busy} value={roots} onChange={event => edit(event.target.value)} placeholder="/absolute/path/to/company-project" /></label>
      <div className="inlineActions"><button className="ghostButton" type="button" disabled={busy || !suggestedRoot.trim()} onClick={() => edit(suggestedRoot.trim())}>填入当前工作区作为候选（尚未授权）</button></div>
      <small>候选路径仅填入表单，请先检查或改为更小的公司子目录；不会扫描电脑、自动保存或扩大权限。清空并保存可撤销全部目录授权；配置只保存在这台电脑，不写入 Git 或随安装复制。</small>
      <label><input type="checkbox" disabled={busy} checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />我已检查上述目录，确认允许助手研究其中的公司资料</label>
      <div className="inlineActions"><button type="button" disabled={busy || (selected.length > 0 && !confirmed)} onClick={() => void save()}>保存公司资料范围</button></div>
    </>}
    </details>
    {error && <p role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    <div className="inlineActions"><button className="ghostButton" type="button" disabled={busy} onClick={() => void load()}>重新检查连接与范围</button><Link to="/group-privacy">查看隐私审批与详细范围</Link></div>
  </div>;
}
