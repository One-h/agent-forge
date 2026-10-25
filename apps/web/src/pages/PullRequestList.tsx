import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { GitPullRequestArrow, RefreshCw, Search } from "lucide-react";
import { api, type Issue, type PullScope } from "../api";
import { statusText } from "../i18n";
import { usePersistentState } from "../usePersistentState";

const scopeOptions: Array<{ value: PullScope; label: string }> = [
  { value: "relevant", label: "与我相关" },
  { value: "authored", label: "我创建的" },
  { value: "review", label: "待我评审" },
  { value: "all", label: "全部" }
];

export function PullRequestList({ onOpenIssue }: { onOpenIssue: (issueId: number) => void }) {
  const navigate = useNavigate();
  const { issueId: issueIdParam } = useParams();
  const selectedIssueId = issueIdParam ? Number(issueIdParam) : null;
  const [pulls, setPulls] = useState<Issue[]>([]);
  const [error, setError] = useState("");
  const [query, setQuery] = usePersistentState("autofix.pulls.query", "");
  const [scope, setScope] = usePersistentState<PullScope>("autofix.pulls.scope", "review");
  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState<{ scanned: number; upserted: number; filtered: number; pullsScanned?: number } | null>(null);

  const load = async () => {
    setPulls(await api.pulls(scope));
  };

  useEffect(() => {
    void load().catch((err) => setError(String(err)));
  }, [scope]);

  useEffect(() => {
    if (selectedIssueId !== null && Number.isFinite(selectedIssueId)) {
      onOpenIssue(selectedIssueId);
      navigate("/pulls", { replace: true });
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

  const filteredPulls = pulls.filter((pull) => {
    const text = `${pull.repo_owner}/${pull.repo_name} ${pull.external_id} ${pull.title} ${pull.author ?? ""} ${pull.reviewers ?? ""}`.toLowerCase();
    return text.includes(query.toLowerCase());
  });

  return (
    <section className="pageStack">
      <div className="heroBand">
        <div>
          <p className="eyebrow">评审队列</p>
          <h2>拉取请求</h2>
          <p className="subtle">白名单仓库中需要评审或后续处理的开放 PR。</p>
        </div>
        <button className="primaryButton" onClick={sync} disabled={syncing}>
          <RefreshCw size={16} className={syncing ? "spin" : ""} />
          {syncing ? "同步中" : "同步 Gitea"}
        </button>
      </div>

      {error && <div className="error">{error}</div>}
      {lastSync && (
        <div className="notice">
          最近同步：扫描 {lastSync.scanned} 条，其中 PR {lastSync.pullsScanned ?? 0} 条；导入 {lastSync.upserted} 条，过滤 {lastSync.filtered} 条。
        </div>
      )}

      <div className="panel">
        <div className="toolbar">
          <div className="segmentedControl" aria-label="拉取请求范围">
            {scopeOptions.map((option) => (
              <button
                key={option.value}
                className={scope === option.value ? "active" : ""}
                onClick={() => setScope(option.value)}
                type="button"
              >
                {option.label}
              </button>
            ))}
          </div>
          <label className="searchBox">
            <Search size={16} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索 PR 仓库、标题、作者或评审人..." />
          </label>
          <span className="toolbarCount">{filteredPulls.length} 条</span>
        </div>

        <div className="dataTable">
          <div className="tableRow prQueue tableHead">
            <span>仓库</span>
            <span>PR</span>
            <span>标题</span>
            <span>作者</span>
            <span>评审人</span>
            <span>提交</span>
            <span>评审</span>
            <span>状态</span>
          </div>
          {filteredPulls.map((pull) => (
            <button className="tableRow prQueue clickable" key={pull.id} onClick={() => onOpenIssue(pull.id)}>
              <span className="repoCell">{pull.repo_owner}/{pull.repo_name}</span>
              <span className="muted"><GitPullRequestArrow size={14} /> #{pull.external_id}</span>
              <span className="titleCell">{pull.title}</span>
              <span className="muted">{pull.author || "-"}</span>
              <span className="muted">{formatReviewers(pull.reviewers)}</span>
              <span className="muted mono">{shortSha(pull.head_sha)}</span>
              <span><span className={`badge ${reviewBadgeClass(pull.review_state)}`}>{statusText(pull.review_state ?? "none")}</span></span>
              <span><span className={`badge ${pull.status}`}>{statusText(pull.status)}</span></span>
            </button>
          ))}
          {filteredPulls.length === 0 && <div className="emptyState">尚未同步到拉取请求。</div>}
        </div>
      </div>
    </section>
  );
}

function shortSha(value: string | null): string {
  return value ? value.slice(0, 8) : "-";
}

function reviewBadgeClass(value: Issue["review_state"]): string {
  if (value === "posted" || value === "reviewed") return "done";
  if (value === "running") return "running";
  if (value === "failed") return "failed";
  if (value === "stale") return "stale";
  return "neutral";
}

function formatReviewers(value: string | null): string {
  if (!value) return "-";
  try {
    const reviewers = JSON.parse(value) as string[];
    return reviewers.length > 0 ? reviewers.join(", ") : "-";
  } catch {
    return value;
  }
}
