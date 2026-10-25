import { db, prReviewKey, type IssueRow, type PrReviewRunRow, type RepairJobRow } from "./db.js";
import { nowIso } from "./time.js";

export type CreateReviewJobResult =
  | { ok: true; job: RepairJobRow }
  | { ok: false; reason: "not_pr" | "missing_head_sha" | "duplicate" | "active_review"; job?: RepairJobRow | null; reviewKey?: string | null };

type CreateReviewJobOptions = {
  retryFailed?: boolean;
};

function activeReviewForPull(issueId: number): RepairJobRow | undefined {
  return db.prepare(`
    SELECT repair_jobs.*
    FROM pr_review_runs
    LEFT JOIN repair_jobs ON repair_jobs.id = pr_review_runs.job_id
    WHERE pr_review_runs.issue_id = ?
      AND pr_review_runs.status IN ('pending', 'running')
    ORDER BY pr_review_runs.id DESC
    LIMIT 1
  `).get(issueId) as RepairJobRow | undefined;
}

function insertReviewJob(issue: IssueRow, repoHint: string, createdAt: string): RepairJobRow {
  const result = db.prepare(`
    INSERT INTO repair_jobs (issue_id, status, phase, mode, repo_hint, created_at, updated_at)
    VALUES (?, 'queued', 'review', 'review_only', ?, ?, ?)
  `).run(issue.id, repoHint, createdAt, createdAt);
  return db.prepare("SELECT * FROM repair_jobs WHERE id = ?").get(result.lastInsertRowid) as RepairJobRow;
}

export function createReviewOnlyJobForPull(
  issue: IssueRow,
  repoHint = issue.repo_name,
  options: CreateReviewJobOptions = {}
): CreateReviewJobResult {
  if (issue.kind !== "pr") {
    return { ok: false, reason: "not_pr" };
  }
  if (!issue.head_sha) {
    return { ok: false, reason: "missing_head_sha" };
  }

  const active = activeReviewForPull(issue.id);
  if (active) {
    return { ok: false, reason: "active_review", job: active, reviewKey: prReviewKey(issue) };
  }

  const reviewKey = prReviewKey(issue);
  const existingRun = db.prepare("SELECT * FROM pr_review_runs WHERE review_key = ? ORDER BY id DESC LIMIT 1")
    .get(reviewKey) as PrReviewRunRow | undefined;
  const existingJob = existingRun?.job_id
    ? db.prepare("SELECT * FROM repair_jobs WHERE id = ?").get(existingRun.job_id) as RepairJobRow | undefined
    : undefined;
  if (existingRun && (!options.retryFailed || !["failed", "cancelled"].includes(existingRun.status))) {
    return { ok: false, reason: "duplicate", reviewKey, job: existingJob };
  }

  const createdAt = nowIso();
  return db.transaction(() => {
    const job = insertReviewJob(issue, repoHint, createdAt);
    if (existingRun) {
      db.prepare(`
        UPDATE pr_review_runs
        SET job_id = ?, status = 'pending', runtime = 'codex', verdict = 'unknown', posted = 0,
            posted_comment_url = NULL, task_package_path = NULL, error_message = NULL,
            started_at = NULL, finished_at = NULL, posted_at = NULL
        WHERE id = ?
      `).run(job.id, existingRun.id);
    } else {
      db.prepare(`
        INSERT INTO pr_review_runs (
          issue_id, job_id, repo, pr_number, head_sha, review_key, status, runtime, verdict,
          posted, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 'codex', 'unknown', 0, ?)
      `).run(
        issue.id,
        job.id,
        `${issue.repo_owner}/${issue.repo_name}`,
        issue.external_id,
        issue.head_sha,
        reviewKey,
        createdAt
      );
    }
    db.prepare("UPDATE issues SET updated_at = ? WHERE id = ?").run(createdAt, issue.id);
    return { ok: true, job } as CreateReviewJobResult;
  })();
}
