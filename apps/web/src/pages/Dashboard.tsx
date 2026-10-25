import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { GitPullRequestArrow, Inbox, RefreshCw } from "lucide-react";
import { api, type Issue } from "../api";
import { formatRelativeTime, statusText } from "../i18n";

export function Dashboard({ onOpenIssue }: { onOpenIssue: (issueId: number) => void }) {
  const navigate = useNavigate();
  const [issues, setIssues] = useState<Issue[]>([]);
  const [pulls, setPulls] = useState<Issue[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const [issueRows, pullRows] = await Promise.all([
        api.issues(),
        api.pulls("review")
      ]);
      setIssues(issueRows.filter((issue) => issue.state !== "closed"));
      setPulls(pullRows);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load().catch((err) => setError(String(err)));
  }, []);

  const counts = {
    issues: issues.length,
    pulls: pulls.length,
    activeIssues: issues.filter((issue) => ["queued", "running"].includes(issue.status)).length,
    activeReviews: pulls.filter((pull) => pull.review_state === "running").length,
    reviewAlerts: pulls.filter((pull) => pull.review_state === "failed" || pull.review_state === "stale").length
  };
  const importantIssues = prioritizeIssues(issues).slice(0, 8);
  const importantPulls = prioritizePulls(pulls).slice(0, 8);

  return (
    <section className="pageStack">
      <div className="heroBand">
        <div>
          <p className="eyebrow">工作概览</p>
          <h2>关注队列</h2>
          <p className="subtle">仅展示当前需要处理的问题和 PR。</p>
        </div>
        <button className="ghostButton" onClick={() => void load()} disabled={loading}>
          <RefreshCw size={16} className={loading ? "spin" : ""} />
          刷新
        </button>
      </div>

      <div className="metricGrid">
        <div className="metric"><span>开放问题</span><strong>{counts.issues}</strong></div>
        <div className="metric"><span>待评审 PR</span><strong>{counts.pulls}</strong></div>
        <div className="metric"><span>执行中的任务</span><strong>{counts.activeIssues}</strong></div>
        <div className="metric"><span>评审提醒</span><strong>{counts.reviewAlerts}</strong></div>
      </div>

      {error && <div className="error">{error}</div>}

      <div className="dashboardGrid">
        <section className="panel">
          <div className="sectionHeader compact">
            <h3><Inbox size={16} /> 问题</h3>
            <button className="ghostButton" onClick={() => navigate("/issues")}>查看问题</button>
          </div>
          <div className="dashboardList">
            {importantIssues.map((issue) => (
              <button className="dashboardItem compact" key={issue.id} onClick={() => onOpenIssue(issue.id)}>
                <span className="dashboardMeta">
                  <span className="repoCell">{issue.repo_owner}/{issue.repo_name}</span>
                  <span className="muted">问题 #{issue.external_id}</span>
                  <span className={`badge ${issue.state || issue.status}`}>{statusText(issue.state || issue.status)}</span>
                  {issue.status !== "idle" && <span className={`badge ${issue.status}`}>{statusText(issue.status)}</span>}
                </span>
                <strong>{issue.title}</strong>
                <span className="dashboardMeta">
                  <span>{issue.assignee ? `负责人：${issue.assignee}` : "未分配负责人"}</span>
                  <span>更新于 {formatRelativeTime(issue.updated_at)}</span>
                </span>
              </button>
            ))}
            {importantIssues.length === 0 && <div className="emptyState small">暂无开放问题。</div>}
          </div>
        </section>

        <section className="panel">
          <div className="sectionHeader compact">
            <h3><GitPullRequestArrow size={16} /> 拉取请求</h3>
            <button className="ghostButton" onClick={() => navigate("/pulls")}>查看 PR</button>
          </div>
          <div className="dashboardList">
            {importantPulls.map((pull) => (
              <button className="dashboardItem compact" key={pull.id} onClick={() => onOpenIssue(pull.id)}>
                <span className="dashboardMeta">
                  <span className="repoCell">{pull.repo_owner}/{pull.repo_name}</span>
                  <span className="muted">PR #{pull.external_id}</span>
                  <span className={`badge ${reviewBadgeClass(pull.review_state)}`}>{statusText(pull.review_state ?? "none")}</span>
                </span>
                <strong>{pull.title}</strong>
                <span className="dashboardMeta">
                  <span>{pull.author ? `作者：${pull.author}` : "未知作者"}</span>
                  <span>提交：{shortSha(pull.head_sha)}</span>
                  <span>更新于 {formatRelativeTime(pull.updated_at)}</span>
                </span>
              </button>
            ))}
            {importantPulls.length === 0 && <div className="emptyState small">暂无待评审的 PR。</div>}
          </div>
        </section>
      </div>
    </section>
  );
}

function prioritizeIssues(rows: Issue[]): Issue[] {
  return [...rows].sort((left, right) => scoreIssue(right) - scoreIssue(left));
}

function prioritizePulls(rows: Issue[]): Issue[] {
  return [...rows].sort((left, right) => scorePull(right) - scorePull(left));
}

function scoreIssue(issue: Issue): number {
  let score = new Date(issue.updated_at).getTime() / 100000000;
  if (issue.status === "running") score += 80;
  if (issue.status === "queued") score += 60;
  if (issue.status === "failed" || issue.status === "blocked") score += 100;
  if (!issue.assignee) score += 10;
  return score;
}

function scorePull(pull: Issue): number {
  let score = new Date(pull.updated_at).getTime() / 100000000;
  if (pull.review_state === "failed") score += 100;
  if (pull.review_state === "running") score += 80;
  if (pull.review_state === "stale") score += 70;
  if (pull.review_state === "none") score += 40;
  return score;
}

function reviewBadgeClass(value: Issue["review_state"]): string {
  if (value === "posted" || value === "reviewed") return "done";
  if (value === "running") return "running";
  if (value === "failed") return "failed";
  if (value === "stale") return "stale";
  return "neutral";
}

function shortSha(value: string | null): string {
  return value ? value.slice(0, 8) : "-";
}
