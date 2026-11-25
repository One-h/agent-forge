import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ArrowUpRight, ChevronLeft, ChevronRight, Download, GitCommitHorizontal, Workflow } from "lucide-react";
import { api, type LarkTaskDetail, type LarkTaskEngine } from "../api";
import { DetailDrawer } from "../components/DetailDrawer";
import { LarkRefreshButton, LarkWorkspaceHeader } from "../components/LarkWorkspaceHeader";
import { formatTime } from "../i18n";

const taskStatus: Record<string, string> = {
  authorizing: "派工审批中", queued: "待执行", running: "执行中", awaiting_review: "待验收",
  awaiting_worker_clarification: "待 Worker 确认", finished: "已结束", accepted: "验收通过",
  changes_requested: "待修改", blocked: "受阻", failed: "失败", uncertain: "状态待确认",
  rejected: "派工未批准", expired: "派工审批超时"
};
const executionStatus: Record<string, string> = {
  queued: "排队中", submitted: "已提交引擎", completed: "执行完成", failed: "执行失败",
  cancelled: "已结束", interrupted: "执行中断", steering: "正在追加输入", uncertain: "执行未确认"
};
const deliveryStatus: Record<string, string> = {
  queued: "待投递", uploading: "文件上传未确认", sending: "投递未确认", sent: "已发回飞书", invalid_artifact: "文件校验失败"
};
const verdicts: Record<string, string> = { pass: "验收通过", "changes requested": "待修改", inconclusive: "未得出结论" };
const engines: Record<string, string> = { codex: "Codex", claude: "Claude", dsh: "DSH", opencode: "OpenCode", agy: "AGY", requester: "请求人" };
const attentionStates = new Set(["authorizing", "awaiting_worker_clarification", "blocked", "failed", "uncertain", "rejected", "expired"]);
const pageSize = 50;

function engineText(value: LarkTaskEngine) { return engines[value.engine] ?? value.engine; }
function stateBadge(value: string) {
  if (["completed", "accepted", "sent", "pass"].includes(value)) return "done";
  if (["failed", "rejected", "blocked", "invalid_artifact"].includes(value)) return "failed";
  if (["running", "submitted", "queued", "authorizing", "steering"].includes(value)) return "running";
  return "neutral";
}

function Badge({ value, labels }: { value: string; labels: Record<string, string> }) {
  return <span className={`badge ${stateBadge(value)}`}>{Object.hasOwn(labels, value) ? labels[value] : value}</span>;
}

function TaskDetail({ task }: { task: LarkTaskDetail }) {
  const { execution, result, review, delivery } = task;
  const reviewText = !review.required ? "未设置验收" : review.pending ? "待验收" : "尚无验收结论";
  return <div className="drawerStack larkTaskDetail">
    <section>
      <h3>任务目标</h3>
      <p className="larkTaskText">{task.goal}</p>
      <div className="larkTaskSource">
        <Link className="inlineLink" to={`/lark-messages/${task.messageId}`}>查看原消息 #{task.messageId}<ArrowUpRight size={14} /></Link>
        {attentionStates.has(task.status) && <Badge value={task.status} labels={taskStatus} />}
      </div>
    </section>
    <section className="larkTaskStages" aria-label="任务状态">
      <div><span className="muted">Worker 执行</span>
        {execution ? <Badge value={execution.state} labels={executionStatus} /> : <span>尚未提交</span>}
        <small>{engineText(execution ?? task.worker)}{(execution ?? task.worker).model ? ` · ${(execution ?? task.worker).model}` : ""}</small>
      </div>
      <div><span className="muted">结果验收</span>
        {review.decision && !review.pending ? <Badge value={review.decision.verdict} labels={verdicts} /> : <span>{reviewText}</span>}
        {review.reviewer && <small>{engineText(review.reviewer)}</small>}
      </div>
      <div><span className="muted">飞书投递</span>
        <span>{delivery.length ? `已确认 ${delivery.filter(item => item.state === "sent" && item.receipt).length} / ${delivery.length}` : "无结果投递记录"}</span>
        {delivery.length === 50 && <small>最近 50 条记录</small>}
      </div>
    </section>
    {result && <section>
      <h3>已保存的结果</h3>
      {result.text && <p className="larkTaskText">{result.text}</p>}
      {result.artifacts.length > 0 && <ul className="larkTaskRecords" aria-label="冻结产物">
        {result.artifacts.map(file => <li key={file.id}>
          {file.commitId ? <span><GitCommitHorizontal size={16} /><code>{file.commitId}</code></span>
            : file.size !== null ? <a className="inlineLink" href={api.larkTaskFile(task.id, result.id, file.id)} download>
              <Download size={16} />{file.name}<small className="muted">{file.size.toLocaleString("zh-CN")} B</small></a>
              : <span>{file.name}</span>}
        </li>)}
      </ul>}
    </section>}
    {review.decision && !review.pending && <section>
      <h3>验收结论</h3>
      <p className="larkTaskText">{review.decision.reason || verdicts[review.decision.verdict]}</p>
    </section>}
    {delivery.length > 0 && <section>
      <h3>投递回执</h3>
      <ul className="larkTaskRecords">{delivery.map(item => <li key={item.id}>
        <span><Badge value={item.state === "sent" && !item.receipt ? "sending" : item.state} labels={deliveryStatus} />{item.artifactName ?? "结果消息"}</span>
        {(item.attemptedAt || item.receipt) && <small className="muted">
          {[item.attemptedAt ? formatTime(item.attemptedAt) : null, item.receipt].filter(Boolean).join(" · ")}
        </small>}
      </li>)}</ul>
    </section>}
  </div>;
}

export function LarkTasksPage() {
  const { taskId } = useParams();
  const [params, setParams] = useSearchParams();
  const messageId = Number(params.get("messageId"));
  const filterMessage = Number.isSafeInteger(messageId) && messageId > 0 ? messageId : undefined;
  const status = params.get("status") ?? "";
  const offsetValue = Number(params.get("offset"));
  const offset = Number.isSafeInteger(offsetValue) && offsetValue >= 0 ? offsetValue : 0;
  const [version, refresh] = useState(0);
  const [page, setPage] = useState<Awaited<ReturnType<typeof api.larkTasks>> | null>(null);
  const [detail, setDetail] = useState<LarkTaskDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [detailError, setDetailError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(""); setPage(null);
    void api.larkTasks({ messageId: filterMessage, status: status || undefined, offset }, controller.signal)
      .then(next => { if (!controller.signal.aborted) setPage(next); })
      .catch((err: { statusCode?: number }) => {
        if (!controller.signal.aborted) setError(err.statusCode === 503 ? "派工查询不可用。请检查 Lark Agent 连接和派工模块。" : "派工记录加载失败。");
      }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [filterMessage, status, offset, version]);
  useEffect(() => {
    const controller = new AbortController();
    setDetail(null); setDetailError("");
    if (taskId) void api.larkTask(taskId, controller.signal).then(next => {
      if (!controller.signal.aborted) setDetail(next);
    }).catch((err: { statusCode?: number }) => {
      if (!controller.signal.aborted) setDetailError(err.statusCode === 404 ? "未找到派工任务，或当前运行时不支持查询。" : "派工详情加载失败。");
    });
    return () => controller.abort();
  }, [taskId, version]);
  const update = (values: Record<string, string>) => setParams(current => {
    const next = new URLSearchParams(current);
    for (const [key, value] of Object.entries(values)) value ? next.set(key, value) : next.delete(key);
    return next;
  });
  const search = params.size ? `?${params}` : "";
  const rerun = () => refresh(current => current + 1);

  return <section className="pageStack">
    <LarkWorkspaceHeader title="派工任务" icon={<Workflow size={18} />} actions={<LarkRefreshButton label="刷新派工任务" onClick={rerun} disabled={loading} />} />
    <div className="toolbar larkTaskToolbar">
      <select aria-label="任务状态" value={status} onChange={event => update({ status: event.target.value, offset: "" })}>
        <option value="">全部状态</option>
        {Object.entries(taskStatus).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
      {filterMessage && <button className="ghostButton" onClick={() => update({ messageId: "", offset: "" })}>消息 #{filterMessage} · 清除筛选</button>}
    </div>
    {error && <div className="error" role="alert">{error}</div>}
    {loading && <div className="emptyState" role="status">正在加载派工任务…</div>}
    {!loading && !error && !page?.items.length && <div className="emptyState">暂无符合条件的派工任务</div>}
    {!!page?.items.length && <div className="larkTaskTableWrap">
      <table className="larkTaskTable"><thead><tr><th scope="col">任务</th><th scope="col">Worker</th><th scope="col">状态</th><th scope="col">请求时间</th></tr></thead>
        <tbody>{page.items.map(task => <tr key={task.id}>
          <td><Link className="larkTaskLink" to={`/lark-tasks/${encodeURIComponent(task.id)}${search}`}>{task.goal}</Link>
            <small className="muted">{[task.requesterName, task.chatType === "group" ? "群聊" : task.chatType === "p2p" ? "私聊" : null, `消息 #${task.messageId}`].filter(Boolean).join(" · ")}</small></td>
          <td>{engineText(task.worker)}{task.worker.model && <small className="muted">{task.worker.model}</small>}</td>
          <td><Badge value={task.status} labels={taskStatus} /></td><td>{task.requestedAt ? formatTime(task.requestedAt) : "—"}</td>
        </tr>)}</tbody>
      </table>
    </div>}
    {(offset > 0 || page?.hasMore) && <nav className="approvalPagination" aria-label="派工任务分页">
      <button className="iconButton" title="上一页" aria-label="上一页" disabled={loading || offset === 0} onClick={() => update({ offset: offset > pageSize ? String(offset - pageSize) : "" })}><ChevronLeft size={16} /></button>
      <button className="iconButton" title="下一页" aria-label="下一页" disabled={loading || !page?.hasMore} onClick={() => update({ offset: String(offset + pageSize) })}><ChevronRight size={16} /></button>
    </nav>}
    {taskId && <TaskDrawer detail={detail?.id === taskId ? detail : null} error={detailError} search={search} refresh={rerun} />}
  </section>;
}

function TaskDrawer({ detail, error, search, refresh }: { detail: LarkTaskDetail | null; error: string; search: string; refresh: () => void }) {
  const navigate = useNavigate();
  const destination = `/lark-tasks${search}`;
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") navigate(destination); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [destination, navigate]);
  return <DetailDrawer kicker="派工任务" title="任务详情" onClose={() => navigate(destination)}
    actions={<LarkRefreshButton label="刷新派工详情" onClick={refresh} />}>
    {error ? <div className="error" role="alert">{error}</div> : detail ? <TaskDetail task={detail} /> : <div className="emptyState" role="status">正在加载派工详情…</div>}
  </DetailDrawer>;
}
