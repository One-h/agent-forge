import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Activity, RefreshCw, Search } from "lucide-react";
import { api, type RepairRun } from "../api";
import { itemKindText, modeText, statusText } from "../i18n";
import { JobDetailDrawer } from "./JobDetail";
import { usePersistentState } from "../usePersistentState";

function mergeRuns(current: RepairRun[], incoming: RepairRun[]): RepairRun[] {
  const byId = new Map(current.map((run) => [run.id, run]));
  for (const run of incoming) {
    byId.set(run.id, run);
  }
  return [...byId.values()]
    .sort((left, right) => right.updated_at.localeCompare(left.updated_at) || right.id - left.id)
    .slice(0, 200);
}

export function RunList() {
  const navigate = useNavigate();
  const { jobId: jobIdParam } = useParams();
  const selectedJobId = jobIdParam ? Number(jobIdParam) : null;
  const [runs, setRuns] = useState<RepairRun[]>([]);
  const [error, setError] = useState("");
  const [query, setQuery] = usePersistentState("autofix.runs.query", "");
  const [statusFilter, setStatusFilter] = usePersistentState<"active" | "completed" | "failed" | "all">("autofix.runs.status", "active");
  const runsRef = useRef<RepairRun[]>([]);

  const load = useCallback(async (incremental = false) => {
    const current = runsRef.current;
    const latestUpdatedAt = incremental && current.length > 0
      ? current.reduce((latest, run) => latest > run.updated_at ? latest : run.updated_at, current[0].updated_at)
      : undefined;
    const incoming = await api.jobs(latestUpdatedAt);
    const next = incremental ? mergeRuns(current, incoming) : incoming;
    runsRef.current = next;
    setRuns(next);
  }, []);

  const hasActiveRuns = useMemo(() => runs.some((run) => ["queued", "running"].includes(run.status)), [runs]);

  useEffect(() => {
    void load().catch((err) => setError(String(err)));
  }, [load]);

  useEffect(() => {
    if (!hasActiveRuns) {
      return;
    }
    const refreshWhenVisible = () => {
      if (!document.hidden) {
        void load(true).catch((err) => setError(String(err)));
      }
    };
    const timer = window.setInterval(refreshWhenVisible, 10_000);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [hasActiveRuns, load]);

  const counts = {
    total: runs.length,
    running: runs.filter((run) => run.status === "running").length,
    queued: runs.filter((run) => run.status === "queued").length,
    finished: runs.filter((run) => ["done", "pr_created", "failed", "blocked"].includes(run.status)).length
  };
  const filteredRuns = runs.filter((run) => {
    const text = `${run.id} ${run.repo_owner}/${run.repo_name} ${run.issue_title} ${run.external_id} ${run.mode} ${run.status}`.toLowerCase();
    const matchesQuery = text.includes(query.toLowerCase());
    const matchesStatus = statusFilter === "all"
      || (statusFilter === "active" && ["queued", "running"].includes(run.status))
      || (statusFilter === "failed" && ["failed", "blocked"].includes(run.status))
      || (statusFilter === "completed" && !["queued", "running", "failed", "blocked"].includes(run.status));
    return matchesQuery && matchesStatus;
  });

  return (
    <section className="pageStack">
      <div className="heroBand">
        <div>
          <p className="eyebrow">Codex 任务</p>
          <h2>运行记录</h2>
          <p className="subtle">问题与拉取请求的修复、分析和评审任务历史。</p>
        </div>
        <button className="ghostButton" onClick={() => void load()}><RefreshCw size={16} /> 刷新</button>
      </div>
      <div className="metricGrid">
        <div className="metric"><span>全部</span><strong>{counts.total}</strong></div>
        <div className="metric"><span>运行中</span><strong>{counts.running}</strong></div>
        <div className="metric"><span>排队中</span><strong>{counts.queued}</strong></div>
        <div className="metric"><span>已结束</span><strong>{counts.finished}</strong></div>
      </div>
      {error && <div className="error">{error}</div>}
      <div className="panel">
        <div className="toolbar">
          <label className="searchBox">
            <Search size={16} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索任务、仓库或标题..." />
          </label>
          <div className="segmentedControl" aria-label="任务状态筛选">
            <button className={statusFilter === "active" ? "active" : ""} onClick={() => setStatusFilter("active")}>进行中</button>
            <button className={statusFilter === "completed" ? "active" : ""} onClick={() => setStatusFilter("completed")}>已完成</button>
            <button className={statusFilter === "failed" ? "active" : ""} onClick={() => setStatusFilter("failed")}>异常</button>
            <button className={statusFilter === "all" ? "active" : ""} onClick={() => setStatusFilter("all")}>全部</button>
          </div>
          <span className="toolbarCount">{filteredRuns.length} 条</span>
        </div>
        <div className="dataTable">
          <div className="tableRow tableHead">
            <span>仓库</span>
            <span>任务</span>
            <span>目标</span>
            <span>模式</span>
            <span>状态</span>
          </div>
          {filteredRuns.map((run) => (
            <button className="tableRow clickable" key={run.id} onClick={() => navigate(`/runs/${run.id}`)}>
              <span className="repoCell">{run.repo_owner}/{run.repo_name}</span>
              <span className="muted"><Activity size={14} /> #{run.id}</span>
              <span className="titleCell">{itemKindText(run.issue_kind)} #{run.external_id}: {run.issue_title}</span>
              <span className="muted">{modeText(run.mode)}</span>
              <span><span className={`badge ${run.status}`}>{statusText(run.status)}</span></span>
            </button>
          ))}
          {filteredRuns.length === 0 && <div className="emptyState">没有符合当前条件的运行记录。</div>}
        </div>
      </div>
      {selectedJobId !== null && <JobDetailDrawer jobId={selectedJobId} onClose={() => navigate("/runs")} />}
    </section>
  );
}
