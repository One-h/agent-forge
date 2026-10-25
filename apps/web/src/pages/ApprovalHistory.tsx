import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ChevronLeft, ChevronRight, ExternalLink, RefreshCw, Search } from "lucide-react";
import { api, type ApprovalHistoryDetail, type ApprovalHistoryItem, type ApprovalHistoryPage } from "../api";
import { DetailDrawer } from "../components/DetailDrawer";

const sources = { history: "历史匹配", model: "模型判断", manual: "人工审批" };
const statuses: Record<string, string> = { approved: "已通过", manual: "转人工", reviewing: "审核中", pending: "待审批", rejected: "已拒绝", expired: "已过期", failed: "失败" };
function time(value: string | null) { return value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "—"; }
function resultText(item: ApprovalHistoryItem) {
  return item.kind === "auto" && item.status === "approved" ? item.appliedAt ? "已授权" : "通过，未生效" : statuses[item.status] ?? item.status;
}
function sourceText(item: ApprovalHistoryItem) { return item.kind === "auto" && item.source === "manual" ? item.model ? "失败转人工" : "规则转人工" : sources[item.source]; }
function resultClass(status: string) { return status === "approved" ? "done" : ["pending", "reviewing"].includes(status) ? "running" : ["failed", "rejected"].includes(status) ? "failed" : "blocked"; }

export function ApprovalHistory() {
  const navigate = useNavigate();
  const params = useParams();
  const [kind, setKind] = useState<"auto" | "manual">("auto");
  const [source, setSource] = useState("");
  const [status, setStatus] = useState("");
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<ApprovalHistoryPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const requestId = useRef(0);
  const [detail, setDetail] = useState<ApprovalHistoryDetail | null>(null);
  const [detailError, setDetailError] = useState("");
  const [detailLoading, setDetailLoading] = useState(false);
  const detailRequestId = useRef(0);
  const selectedKind = ["auto", "execution", "capability"].includes(params.kind ?? "") ? params.kind as ApprovalHistoryItem["kind"] : null;
  const selectedId = Number(params.approvalId);
  const hasSelection = Boolean(params.approvalId);

  useEffect(() => {
    const timer = window.setTimeout(() => { setSearch(query.trim()); setOffset(0); },300);
    return () => window.clearTimeout(timer);
  },[query]);
  const load = useCallback(async () => {
    const id = ++requestId.current;
    setLoading(true); setError("");
    try {
      const next = await api.approvalHistory({ kind, source: source || undefined, status: status || undefined, q: search || undefined, offset });
      if (id === requestId.current) setPage(next);
    } catch (err) { if (id === requestId.current) setError(String(err)); }
    finally { if (id === requestId.current) setLoading(false); }
  },[kind, source, status, search, offset]);
  useEffect(() => { void load(); return () => { requestId.current++; }; },[load]);
  const active = page?.items.some(item => ["reviewing", "pending"].includes(item.status));
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => { if (!document.hidden) void load(); },10_000);
    return () => window.clearInterval(timer);
  },[active, load]);
  const loadDetail = useCallback(async () => {
    const id = ++detailRequestId.current;
    setDetail(null); setDetailError("");
    if (!hasSelection) return;
    if (!selectedKind || !Number.isSafeInteger(selectedId) || selectedId < 1) { setDetailError("审批记录 ID 无效"); setDetailLoading(false); return; }
    setDetailLoading(true);
    try { const next = await api.approvalHistoryDetail(selectedKind, selectedId); if (id === detailRequestId.current) setDetail(next); }
    catch (err) { if (id === detailRequestId.current) setDetailError(String(err)); }
    finally { if (id === detailRequestId.current) setDetailLoading(false); }
  },[selectedKind, selectedId, hasSelection]);
  useEffect(() => { void loadDetail(); return () => { detailRequestId.current++; }; },[loadDetail]);
  useEffect(() => {
    if (!hasSelection) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") navigate("/approvals"); };
    window.addEventListener("keydown",close);
    return () => window.removeEventListener("keydown",close);
  },[hasSelection,navigate]);
  const summary = page?.summary;
  const resetTab = (value: "auto" | "manual") => { setKind(value); setSource(""); setStatus(""); setOffset(0); setPage(null); };

  return <section className="pageStack approvalHistory">
    <div className="heroBand"><div><p className="eyebrow">飞书执行授权</p><h2>审批记录</h2></div>
      <button className="ghostButton" disabled={loading} onClick={() => { void load(); if (hasSelection) void loadDetail(); }}><RefreshCw size={16} />刷新</button></div>
    <div className="metricGrid">
      <div className="metric"><span>历史匹配通过</span><strong>{summary?.historyApproved ?? "—"}</strong></div>
      <div className="metric"><span>模型判断通过</span><strong>{summary?.modelApproved ?? "—"}</strong></div>
      <div className="metric"><span>自动审核转人工</span><strong>{summary?.manualRequired ?? "—"}</strong></div>
      <div className="metric"><span>待人工审批</span><strong>{summary?.pendingHuman ?? "—"}</strong></div>
    </div>
    <div className="toolbar approvalToolbar">
      <div className="segmentedControl" aria-label="审批类型">
        <button className={kind === "auto" ? "active" : ""} aria-pressed={kind === "auto"} onClick={() => resetTab("auto")}>自动审批</button>
        <button className={kind === "manual" ? "active" : ""} aria-pressed={kind === "manual"} onClick={() => resetTab("manual")}>人工审批</button>
      </div>
      <label className="searchBox"><Search size={16} /><input aria-label="搜索审批记录" maxLength={200} value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索请求、人员或仓库" /></label>
      {kind === "auto" && <select aria-label="审批来源" value={source} onChange={event => { setSource(event.target.value); setOffset(0); }}>
        <option value="">全部来源</option><option value="history">历史匹配</option><option value="model">模型判断</option><option value="manual">规则 / 失败转人工</option></select>}
      <select aria-label="审批结果" value={status} onChange={event => { setStatus(event.target.value); setOffset(0); }}>
        <option value="">全部结果</option>
        {(kind === "auto" ? ["approved","manual","reviewing"] : ["approved","pending","rejected","expired","failed"]).map(value => <option key={value} value={value}>{statuses[value]}</option>)}
      </select>
      <span className="toolbarCount">{page?.total ?? "—"} 条</span>
    </div>
    {error && <div className="error" role="alert">审批记录加载失败：{error}<button className="ghostButton" onClick={() => void load()}><RefreshCw size={14} />重试</button></div>}
    <div className="approvalTableWrap" aria-busy={loading}>
      <div className="approvalTable">
        <div className="approvalRow approvalTableHead"><span>时间</span><span>请求人</span><span>请求</span><span>来源</span><span>结果</span><span>依据 / 模型</span></div>
        {page?.items.map(item => <button className="approvalRow" key={`${item.kind}-${item.id}`} onClick={() => navigate(`/approvals/${item.kind}/${item.id}`)}>
          <span className="muted approvalTime">{time(item.createdAt)}</span><span className="approvalPerson" title={item.requesterId ?? undefined}>{item.requesterName || item.requesterId || "未知发送人"}</span>
          <span className="approvalRequest"><strong>{item.requestPreview || "无消息内容"}</strong><small className="muted">消息 #{item.messageId}{item.target ? ` · ${item.target.replace(/^https?:\/\//, "")}` : ""}</small></span>
          <span>{sourceText(item)}</span><span><span className={`badge ${resultClass(item.status)}`}>{resultText(item)}</span></span>
          <span className="muted approvalBasis">{item.matchedApprovalId ? `历史审批 #${item.matchedApprovalId}` : item.model || item.reason || (item.scope === "turn" ? "当前 turn" : "本次操作")}</span>
        </button>)}
      </div>
      {loading && !page && <div className="emptyState" role="status">正在加载审批记录…</div>}
      {!loading && !error && !page?.items.length && <div className="emptyState">暂无符合条件的审批记录</div>}
    </div>
    <div className="approvalPagination"><span className="muted">{page?.total ? `${offset + 1}–${offset + page.items.length} / ${page.total}` : "0 条"}</span>
      <button className="iconButton" title="上一页" aria-label="上一页" disabled={loading || offset === 0} onClick={() => setOffset(Math.max(0,offset-50))}><ChevronLeft size={16} /></button>
      <button className="iconButton" title="下一页" aria-label="下一页" disabled={loading || !page || offset + page.items.length >= page.total} onClick={() => setOffset(offset+50)}><ChevronRight size={16} /></button></div>
    {hasSelection && <DetailDrawer kicker="审批记录" title={detail ? `${sourceText(detail)} #${detail.id}` : "审批详情"} onClose={() => navigate("/approvals")}
      actions={<button className="iconButton" title="刷新详情" aria-label="刷新详情" disabled={detailLoading} onClick={() => void loadDetail()}><RefreshCw size={16} /></button>}>
      {detailLoading && <div className="emptyState">正在加载审批详情…</div>}
      {detailError && <div className="error" role="alert">{detailError}</div>}
      {detail && <div className="drawerStack approvalDetail">
        <dl className="meta wide"><dt>审批结果</dt><dd><span className={`badge ${resultClass(detail.status)}`}>{resultText(detail)}</span></dd>
          <dt>来源</dt><dd>{sourceText(detail)}</dd><dt>请求人</dt><dd>{detail.requesterName || detail.requesterId || "—"}</dd>
          <dt>审批人</dt><dd>{detail.approverName || detail.approverId || "—"}</dd><dt>授权范围</dt><dd>{detail.status !== "approved" ? "未授权" : detail.scope === "turn" ? "当前 turn" : "本次操作"}</dd>
          <dt>模型</dt><dd>{detail.model || "未调用模型"}</dd><dt>创建时间</dt><dd>{time(detail.createdAt)}</dd><dt>完成时间</dt><dd>{time(detail.completedAt)}</dd>
          {detail.kind === "auto" && <><dt>实际授权时间</dt><dd>{time(detail.appliedAt)}</dd></>}
          <dt>对应消息</dt><dd><Link className="inlineLink" to={`/lark-messages/${detail.messageId}`}><ExternalLink size={14} />消息 #{detail.messageId}</Link></dd>
          <dt>工作目录</dt><dd>{detail.cwd || "—"}</dd><dt>Turn ID</dt><dd><code>{detail.turnId || "—"}</code></dd>
          {detail.sessionId && <><dt>Codex 会话</dt><dd><a className="inlineLink" href={`codex://threads/${detail.sessionId}`}><ExternalLink size={14} />{detail.sessionId}</a></dd></>}
        </dl>
        {detail.reason && <section><h3>审批依据</h3><p className="approvalText">{detail.reason}</p></section>}
        {detail.matchedApproval && <section><h3>命中的历史人工审批</h3><Link className="inlineLink" to={`/approvals/execution/${detail.matchedApproval.id}`}>审批 #{detail.matchedApproval.id}<ExternalLink size={14} /></Link>
          <p className="muted">{time(detail.matchedApproval.completedAt)} · {resultText(detail.matchedApproval)} · {detail.matchedApproval.scope === "turn" ? "当前 turn" : "本次操作"}</p><p className="approvalText">{detail.matchedApproval.request}</p></section>}
        <section><h3>原始请求</h3><p className="approvalText">{detail.request || "—"}</p></section>
        <section><h3>待执行操作</h3><pre>{detail.operation || "无操作记录"}</pre></section>
        {detail.error && <div className="error">{detail.error}</div>}
        {detail.usage && <section><h3>模型用量</h3><pre>{JSON.stringify(detail.usage,null,2)}</pre></section>}
      </div>}
    </DetailDrawer>}
  </section>;
}
