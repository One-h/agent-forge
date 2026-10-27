import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

type Scope = { policy: { companyRoots: string[] } };
async function scopeRequest(roots?: string[]): Promise<Scope> {
  const response = await fetch("/api/group-privacy", roots === undefined ? undefined : {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ companyRoots: roots })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "无法连接 Lark Agent，尚未更改资料范围。");
  return data;
}

export function CompanyScopeSettings({ suggestedRoot }: { suggestedRoot: string }) {
  const [roots, setRoots] = useState("");
  const [saved, setSaved] = useState<string[] | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const load = async () => {
    setBusy(true); setError("");
    try { const data = await scopeRequest(); setRoots(data.policy.companyRoots.join("\n")); setSaved(data.policy.companyRoots); setConfirmed(false); }
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
      const data = await scopeRequest(selected); setSaved(data.policy.companyRoots); setRoots(data.policy.companyRoots.join("\n")); setConfirmed(false);
      setNotice(data.policy.companyRoots.length ? "已保存到本机 Lark Agent。群回复和执行操作仍需审批。" : "已关闭本机资料读取；仍可处理本群内容和公开常识。");
    } catch (failure) { setError(String(failure)); }
    finally { setBusy(false); }
  };
  return <div className="settingsField">
    <h3>飞书助手可研究哪些公司资料？</h3>
    <p className="subtle">仅选择你确认可以提供给助手的公司项目或业务资料文件夹，可填写多个目录。接入飞书和设置 Forge 工作区都不会自动授权读取这些目录。模型分析使用当前配置的模型服务。</p>
    <p className="subtle">不要选择整个硬盘、个人主目录或混合个人资料的上级目录。macOS 可在 Finder 选中文件夹，按 ⌥⌘C 复制完整路径后粘贴；个人资料请放在允许范围外。</p>
    <p role="status">{saved === null ? "尚未读取到资料范围；请先连接 Lark Agent。" : saved.length ? `当前已允许 ${saved.length} 个公司目录：${saved.join("、")}` : "当前没有授权任何本机目录。可以保持为空，稍后再配置。"}</p>
    {error && <p role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {saved !== null && <>
      <label>公司资料目录（每行一个绝对路径）<textarea rows={3} disabled={busy} value={roots} onChange={event => edit(event.target.value)} placeholder="/absolute/path/to/company-project" /></label>
      <div className="inlineActions"><button className="ghostButton" type="button" disabled={busy || !suggestedRoot.trim()} onClick={() => edit(suggestedRoot.trim())}>填入当前工作区作为候选（尚未授权）</button></div>
      <small>候选路径仅填入表单，请先检查或改为更小的公司子目录；不会扫描电脑、自动保存或扩大权限。清空并保存可撤销全部目录授权；配置只保存在这台电脑，不写入 Git 或随安装复制。</small>
      <label><input type="checkbox" disabled={busy} checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />我已检查上述目录，确认允许助手研究其中的公司资料</label>
      <div className="inlineActions"><button type="button" disabled={busy || (selected.length > 0 && !confirmed)} onClick={() => void save()}>保存公司资料范围</button></div>
    </>}
    <div className="inlineActions"><button className="ghostButton" type="button" disabled={busy} onClick={() => void load()}>重新检查连接与范围</button><Link to="/group-privacy">查看隐私审批与详细范围</Link></div>
  </div>;
}
