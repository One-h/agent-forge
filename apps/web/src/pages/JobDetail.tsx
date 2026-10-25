import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ExternalLink, FileText, RefreshCw } from "lucide-react";
import { api, type JobEvent, type RepairJob } from "../api";
import { DetailDrawer } from "../components/DetailDrawer";
import { statusText } from "../i18n";

export function JobDetail() {
  const navigate = useNavigate();
  const { jobId: jobIdParam } = useParams();
  const jobId = Number(jobIdParam);

  return <JobDetailDrawer jobId={jobId} onClose={() => navigate(-1)} />;
}

export function JobDetailDrawer({ jobId, onClose }: { jobId: number; onClose: () => void }) {
  const [job, setJob] = useState<RepairJob | null>(null);
  const [events, setEvents] = useState<JobEvent[]>([]);
  const [error, setError] = useState("");

  const load = async () => {
    const [nextJob, nextEvents] = await Promise.all([api.job(jobId), api.jobEvents(jobId)]);
    setJob(nextJob);
    setEvents(nextEvents);
  };

  useEffect(() => {
    if (!Number.isFinite(jobId)) {
      return;
    }
    void load().catch((err) => setError(String(err)));
  }, [jobId]);

  const shouldPoll = Boolean(job && ["queued", "running"].includes(job.status));
  useEffect(() => {
    if (!shouldPoll) {
      return;
    }
    const refreshWhenVisible = () => {
      if (!document.hidden) {
        void load().catch((err) => setError(String(err)));
      }
    };
    const timer = window.setInterval(refreshWhenVisible, 5_000);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [shouldPoll, jobId]);

  if (!Number.isFinite(jobId)) {
    return (
      <DetailDrawer title="无效任务" onClose={onClose}>
        <div className="emptyState">任务 ID 无效。</div>
      </DetailDrawer>
    );
  }

  if (!job) {
    return (
      <DetailDrawer title="加载中" onClose={onClose}>
        <div className="emptyState">正在加载任务详情。</div>
      </DetailDrawer>
    );
  }
  const tmuxSession = `autofix-codex-${job.id}`;

  return (
    <DetailDrawer
      kicker="Codex 运行器"
      title={`任务 #${job.id}`}
      onClose={onClose}
      actions={
        <button className="ghostButton" onClick={() => void load()}><RefreshCw size={16} /> 刷新</button>
      }
    >
      {error && <div className="error">{error}</div>}

      <div className="drawerStack">
        <section className="panel">
          <h3>运行信息</h3>
          <dl className="meta">
            <dt>状态</dt><dd><span className={`badge ${job.status}`}>{statusText(job.status)}</span></dd>
            <dt>tmux</dt><dd>{tmuxSession}</dd>
            <dt>任务目录</dt><dd>{job.task_dir || "-"}</dd>
            <dt>分析结论</dt><dd><span className={`badge ${triageBadgeClass(job.task_package?.triage.decision)}`}>{statusText(job.task_package?.triage.decision ?? "unknown")}</span></dd>
            <dt>工作树</dt><dd>{job.worktree_path || "-"}</dd>
            <dt>分支</dt><dd>{job.branch_name || "-"}</dd>
            <dt>PR</dt><dd>{job.pr_url ? <a className="inlineLink" href={job.pr_url} target="_blank" rel="noreferrer"><ExternalLink size={14} /> {job.pr_url}</a> : "-"}</dd>
            <dt>错误</dt><dd>{job.error || "-"}</dd>
          </dl>
          <div className="scoreGrid spacious">
            <Score label="难度" value={job.task_package?.triage.difficulty} />
            <Score label="工作量" value={job.task_package?.triage.workload} />
            <Score label="重要性" value={job.task_package?.triage.importance} />
            <Score label="复杂度" value={job.task_package?.triage.complexity} />
          </div>
          {job.task_package?.triage.summary && <p className="subtle">{job.task_package.triage.summary}</p>}
        </section>

        <section className="panel">
          <div className="sectionHeader compact">
            <h3>开发计划</h3>
            <span className="muted">{job.task_package?.developmentPlan.steps.length ?? 0} 步</span>
          </div>
          <PlanList title="步骤" items={job.task_package?.developmentPlan.steps ?? []} />
          <PlanList title="目标文件" items={job.task_package?.developmentPlan.targetFiles ?? []} />
          <PlanList title="验证" items={job.task_package?.developmentPlan.verification ?? []} />
          <PlanList title="风险" items={job.task_package?.developmentPlan.risks ?? []} />
          {!job.task_package?.developmentPlan.summary && !job.task_package?.developmentPlan.steps.length && (
            <div className="emptyState small">暂无开发计划。</div>
          )}
          {job.task_package?.developmentPlan.summary && <p className="subtle">{job.task_package.developmentPlan.summary}</p>}
        </section>

        <section className="panel">
          <div className="sectionHeader compact">
            <h3><FileText size={16} /> 任务包</h3>
            <span className="muted">{job.task_package?.files.filter((file) => file.exists).length ?? 0} 个文件</span>
          </div>
          <dl className="meta wide">
            <dt>路径</dt><dd>{job.task_package?.path || "-"}</dd>
          </dl>
          <div className="artifactList">
            {job.task_package?.files.map((file) => (
              <div className={`artifactRow ${file.exists ? "present" : "missing"}`} key={file.name}>
                <span>{file.name}</span>
                <code>{file.exists ? file.path : "未写入"}</code>
                <small>{file.bytes == null ? "-" : `${file.bytes} 字节`}</small>
              </div>
            ))}
          </div>
        </section>

        <article className="panel">
          <div className="sectionHeader compact">
            <h3>事件流</h3>
            <span className="muted">{events.length} 条</span>
          </div>
          <div className="log">
            {events.map((event) => (
              <div key={event.id} className={`logLine ${event.level}`}>
                <span>{event.created_at}</span>
                <strong>{statusText(event.level)}</strong>
                <code>{event.message}</code>
              </div>
            ))}
            {events.length === 0 && <div className="emptyLog">等待运行器输出。</div>}
          </div>
        </article>
      </div>
    </DetailDrawer>
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

function Score({ label, value }: { label: string; value: number | null | undefined }) {
  return (
    <div className="scoreCell">
      <span>{label}</span>
      <strong>{typeof value === "number" ? `${value}/5` : "-"}</strong>
    </div>
  );
}

function triageBadgeClass(value?: string): string {
  if (value === "easy-direct") return "done";
  if (value === "mid-human-review") return "queued";
  if (value === "hard-human-handoff") return "blocked";
  return "neutral";
}
