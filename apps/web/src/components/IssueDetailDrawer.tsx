import { useEffect, useState } from "react";
import { ExternalLink, FolderOpen, Play, RefreshCw } from "lucide-react";
import { api, type DevelopmentPlanSummary, type Issue, type RepairJob, type TriageSummary } from "../api";
import { DetailDrawer } from "./DetailDrawer";
import { itemKindText, statusText } from "../i18n";

export function IssueDetailDrawer({
  issueId,
  onClose,
  onOpenJob
}: {
  issueId: number;
  onClose: () => void;
  onOpenJob: (jobId: number) => void;
}) {
  const [issue, setIssue] = useState<Issue | null>(null);
  const [jobs, setJobs] = useState<RepairJob[]>([]);
  const [error, setError] = useState("");

  const load = async () => {
    if (!Number.isFinite(issueId)) {
      return;
    }
    const [nextIssue, nextJobs] = await Promise.all([api.issue(issueId), api.issueJobs(issueId)]);
    setIssue(nextIssue);
    setJobs(nextJobs);
  };

  useEffect(() => {
    setIssue(null);
    setJobs([]);
    setError("");
    void load().catch((err) => setError(String(err)));
  }, [issueId]);

  const hasActiveJobs = jobs.some((job) => ["queued", "running"].includes(job.status));
  useEffect(() => {
    if (!hasActiveJobs) {
      return;
    }
    const refreshWhenVisible = () => {
      if (!document.hidden) {
        void load().catch((err) => setError(String(err)));
      }
    };
    const timer = window.setInterval(refreshWhenVisible, 10_000);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [hasActiveJobs, issueId]);

  const startJob = async (mode: "review_only" | "issue_triage" | "issue_implementation", approveTriagePlan = false) => {
    setError("");
    try {
      const job = await api.repair(issueId, issue?.repo_name, mode, approveTriagePlan);
      await load();
      onOpenJob(job.id);
    } catch (err) {
      setError(String(err));
    }
  };

  const startImplementation = async () => {
    const decision = issue?.triage?.decision;
    const needsApproval = decision === "mid-human-review";
    const approveTriagePlan = needsApproval
      ? window.confirm("该分析计划需要人工复核。确认批准此开发计划并启动实现吗？")
      : false;
    if (needsApproval && !approveTriagePlan) {
      return;
    }
    await startJob("issue_implementation", approveTriagePlan);
  };

  if (!Number.isFinite(issueId)) {
    return (
      <DetailDrawer title="无效问题" onClose={onClose}>
        <div className="emptyState">问题 ID 无效。</div>
      </DetailDrawer>
    );
  }

  if (!issue) {
    return (
      <DetailDrawer title="加载中" onClose={onClose}>
        <div className="emptyState">正在加载问题详情。</div>
      </DetailDrawer>
    );
  }

  const isPullRequest = issue.kind === "pr";
  const itemType = isPullRequest ? "PR" : "问题";
  const hasTriage = !isPullRequest && Boolean(issue.triage_task_package?.path);

  return (
    <DetailDrawer
      kicker={`${issue.repo_owner}/${issue.repo_name} · ${itemKindText(issue.kind)} #${issue.external_id}`}
      title={issue.title}
      onClose={onClose}
      actions={
        <div className="inlineActions">
          <button className="primaryButton" onClick={() => void startJob(isPullRequest ? "review_only" : "issue_triage")}>
            <Play size={16} /> {isPullRequest ? "评审 PR" : "开始分析"}
          </button>
          {!isPullRequest && (
            <button className="ghostButton" onClick={() => void startImplementation()} disabled={!hasTriage || issue.triage?.decision === "hard-human-handoff"}>
              <Play size={16} /> {issue.triage?.decision === "mid-human-review" ? "批准并实现" : "开始实现"}
            </button>
          )}
        </div>
      }
    >
      {error && <div className="error">{error}</div>}

      <div className="drawerStack">
        <section className="panel">
          <div className="sectionHeader compact">
            <h3>Codex 任务</h3>
            <button className="ghostButton" onClick={() => void load()}><RefreshCw size={15} /> 刷新</button>
          </div>
          <div className="jobList">
            {jobs.map((job) => (
              <button className="jobCard" key={job.id} onClick={() => onOpenJob(job.id)}>
                <span>任务 #{job.id}</span>
                <strong>{statusText(job.status)}</strong>
                <small>{job.pr_url || job.branch_name || (job.task_package?.triage.decision ? statusText(job.task_package.triage.decision) : job.task_dir || "排队中")}</small>
              </button>
            ))}
            {jobs.length === 0 && <div className="emptyState small">暂无 Codex 任务。</div>}
          </div>
        </section>

        {!isPullRequest && (
          <section className="panel">
            <div className="sectionHeader compact">
              <h3>问题分析</h3>
              <span className={`badge ${triageBadgeClass(issue.triage?.decision)}`}>{statusText(issue.triage?.decision ?? "unknown")}</span>
            </div>
            <TriageScores triage={issue.triage} />
            <p className="subtle">{issue.triage?.summary || "尚未记录分析结论。"}</p>
            <dl className="meta wide">
              <dt>任务包</dt><dd>{issue.triage_task_package?.path || "-"}</dd>
            </dl>
          </section>
        )}

        {!isPullRequest && (
          <section className="panel">
            <div className="sectionHeader compact">
              <h3>开发计划</h3>
              <span className="muted">{issue.development_plan?.steps.length ?? 0} 步</span>
            </div>
            <DevelopmentPlan plan={issue.development_plan} />
          </section>
        )}

        <section className="panel">
          <div className="sectionHeader compact">
            <h3><FolderOpen size={16} /> 任务包</h3>
            <span className="muted">{jobs.filter((job) => job.task_package?.path).length} 个已保存</span>
          </div>
          <div className="taskPackageList">
            {jobs.map((job) => (
              <button className="taskPackageCard" key={job.id} onClick={() => onOpenJob(job.id)}>
                <span>任务 #{job.id}</span>
                <strong>{job.task_package?.path || "暂无任务包"}</strong>
                <small>{job.task_package?.files.filter((file) => file.exists).length ?? 0} 个文件 · {statusText(job.task_package?.triage.decision ?? "unknown")}</small>
              </button>
            ))}
            {jobs.length === 0 && <div className="emptyState small">任务启动后将在这里显示任务包。</div>}
          </div>
        </section>

        <article className="panel">
          <div className="sectionHeader compact">
            <h3>{itemType} 正文</h3>
            {issue.url && (
              <a className="linkButton" href={issue.url} target="_blank" rel="noreferrer">
                <ExternalLink size={15} /> Gitea
              </a>
            )}
          </div>
          <pre className="body">{issue.body || "暂无正文"}</pre>
        </article>
      </div>
    </DetailDrawer>
  );
}

function TriageScores({ triage }: { triage?: TriageSummary }) {
  const scores = [
    ["难度", triage?.difficulty],
    ["工作量", triage?.workload],
    ["重要性", triage?.importance],
    ["复杂度", triage?.complexity]
  ];
  return (
    <div className="scoreGrid">
      {scores.map(([label, value]) => (
        <div className="scoreCell" key={label}>
          <span>{label}</span>
          <strong>{typeof value === "number" ? `${value}/5` : "-"}</strong>
        </div>
      ))}
    </div>
  );
}

function triageBadgeClass(value?: TriageSummary["decision"]): string {
  if (value === "easy-direct") return "done";
  if (value === "mid-human-review") return "queued";
  if (value === "hard-human-handoff") return "blocked";
  return "neutral";
}

function DevelopmentPlan({ plan }: { plan?: DevelopmentPlanSummary | null }) {
  if (!plan?.summary && !plan?.steps.length) {
    return <div className="emptyState small">尚未记录开发计划。</div>;
  }
  return (
    <div className="planStack">
      {plan.summary && <p className="subtle">{plan.summary}</p>}
      <PlanList title="步骤" items={plan.steps} />
      <PlanList title="目标文件" items={plan.targetFiles} />
      <PlanList title="验证" items={plan.verification} />
      <PlanList title="风险" items={plan.risks} />
    </div>
  );
}

function PlanList({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) {
    return null;
  }
  return (
    <div className="planSection">
      <strong>{title}</strong>
      <ul>
        {items.map((item) => <li key={item}>{item}</li>)}
      </ul>
    </div>
  );
}
