import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { RefreshCw, Search } from "lucide-react";
import { api, type Issue } from "../api";
import { itemKindText, statusText } from "../i18n";
import { usePersistentState } from "../usePersistentState";

export function IssueList({ onOpenIssue }: { onOpenIssue: (issueId: number) => void }) {
  const navigate = useNavigate();
  const { issueId: issueIdParam } = useParams();
  const selectedIssueId = issueIdParam ? Number(issueIdParam) : null;
  const [issues, setIssues] = useState<Issue[]>([]);
  const [error, setError] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [query, setQuery] = usePersistentState("autofix.issues.query", "");
  const [stateFilter, setStateFilter] = usePersistentState<"open" | "closed" | "all">("autofix.issues.state", "open");
  const [lastSync, setLastSync] = useState<{ scanned: number; upserted: number; filtered: number } | null>(null);

  const load = async () => {
    setIssues(await api.issues());
  };

  useEffect(() => {
    void load().catch((err) => setError(String(err)));
  }, []);

  useEffect(() => {
    if (selectedIssueId !== null && Number.isFinite(selectedIssueId)) {
      onOpenIssue(selectedIssueId);
      navigate("/issues", { replace: true });
    }
  }, [navigate, onOpenIssue, selectedIssueId]);

  const sync = async () => {
    setSyncing(true);
    setError("");
    try {
      const result = await api.sync();
      setLastSync(result);
      await load();
    } catch (err) {
      setError(String(err));
    } finally {
      setSyncing(false);
    }
  };

  const visibleIssues = issues.filter((issue) => stateFilter === "all" || issue.state === stateFilter);
  const filteredIssues = visibleIssues.filter((issue) => {
    const text = `${issue.repo_owner}/${issue.repo_name} ${issue.kind} ${issue.external_id} ${issue.title} ${issue.state} ${issue.status}`.toLowerCase();
    return text.includes(query.toLowerCase());
  });

  const counts = {
    total: issues.length,
    open: issues.filter((issue) => issue.state === "open").length,
    closed: issues.filter((issue) => issue.state === "closed").length,
    activeJobs: issues.filter((issue) => ["queued", "running"].includes(issue.status)).length
  };

  return (
    <section className="pageStack">
      <div className="heroBand">
        <div>
          <p className="eyebrow">Gitea 同步</p>
          <h2>问题队列</h2>
          <p className="subtle">展示指派给你的问题与带有自动化标签的任务。</p>
        </div>
        <button className="primaryButton" onClick={sync} disabled={syncing}>
          <RefreshCw size={16} className={syncing ? "spin" : ""} />
          {syncing ? "同步中" : "同步 Gitea"}
        </button>
      </div>

      <div className="metricGrid">
        <div className="metric"><span>全部</span><strong>{counts.total}</strong></div>
        <div className="metric"><span>开放</span><strong>{counts.open}</strong></div>
        <div className="metric"><span>已关闭</span><strong>{counts.closed}</strong></div>
        <div className="metric"><span>执行中的任务</span><strong>{counts.activeJobs}</strong></div>
      </div>

      {error && <div className="error">{error}</div>}
      {lastSync && (
        <div className="notice">最近同步：扫描 {lastSync.scanned} 条，导入 {lastSync.upserted} 条，过滤 {lastSync.filtered} 条。</div>
      )}

      <div className="panel">
        <div className="toolbar">
          <label className="searchBox">
            <Search size={16} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索仓库、标题或状态..." />
          </label>
          <div className="segmentedControl" aria-label="问题状态筛选">
            <button className={stateFilter === "open" ? "active" : ""} onClick={() => setStateFilter("open")}>开放</button>
            <button className={stateFilter === "closed" ? "active" : ""} onClick={() => setStateFilter("closed")}>已关闭</button>
            <button className={stateFilter === "all" ? "active" : ""} onClick={() => setStateFilter("all")}>全部</button>
          </div>
          <span className="toolbarCount">{filteredIssues.length} 条</span>
        </div>

        <div className="dataTable">
          <div className="tableRow tableHead">
            <span>仓库</span>
            <span>类型</span>
            <span>标题</span>
            <span>负责人</span>
            <span>Gitea</span>
          </div>
          {filteredIssues.map((issue) => (
            <button className="tableRow clickable" key={issue.id} onClick={() => onOpenIssue(issue.id)}>
              <span className="repoCell">{issue.repo_owner}/{issue.repo_name}</span>
              <span className="muted">{itemKindText(issue.kind)} #{issue.external_id}</span>
              <span className="titleCell">{issue.title}</span>
              <span className="muted">{issue.assignee || "-"}</span>
              <span><StatusBadge status={issue.state || issue.status} /></span>
            </button>
          ))}
          {filteredIssues.length === 0 && <div className="emptyState">没有符合当前条件的问题。</div>}
        </div>
      </div>
    </section>
  );
}

function StatusBadge({ status }: { status: string }) {
  return <span className={`badge ${status}`}>{statusText(status)}</span>;
}
