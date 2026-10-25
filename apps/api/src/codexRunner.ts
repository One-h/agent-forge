import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "./config.js";
import { type CodexAppServerNotification } from "./codexAppServer.js";
import { codexAppServer, isCodexAppServerTurnRegistered, registerCodexAppServerTurn, unregisterCodexAppServerTurn } from "./codexAppServerRuntime.js";
import { resolveCodexExecutable } from "./codexExecutable.js";
import { addJobEvent, db, updatePrReviewRunForJob, type IssueRow, type RepairJobRow } from "./db.js";
import { configurablePrompt, type ConfigurablePromptKey } from "./promptSettings.js";
import { localDateSlug, nowIso, slugify } from "./time.js";

// Prompt templates belong to Agent Forge itself, not to the user-configured workspace.
const rootDir = config.repoRoot;
const promptTemplatePaths = {
  issueTriage: path.join(rootDir, "prompts", "issue-triage-job.md"),
  issueImplementation: path.join(rootDir, "prompts", "issue-implementation-job.md"),
  prReview: path.join(rootDir, "prompts", "pr-review-job.md")
};
const finalSchemaSourcePath = path.join(rootDir, "prompts", "final-output.schema.json");
const activeTmuxSessions = new Map<number, string>();
const activeAppServerJobRuns = new Map<number, ActiveAppServerJobRun>();
const pendingAppServerJobNotifications = new Map<string, CodexAppServerNotification[]>();
const finalRequiredKeys = [
  "status",
  "target_repo",
  "task_dir",
  "worktree_path",
  "branch_name",
  "pr_url",
  "summary",
  "verification",
  "residual_risk",
  "triage",
  "development_plan"
];

type PreviousPrReviewContext = {
  jobId: number;
  headSha: string;
  taskDir: string | null;
  codexSessionId: string | null;
};

type PreparedReviewPackage = {
  ok: boolean;
  history_status?: string;
  incremental_available?: boolean;
  changed_files?: number;
  warnings?: string[];
  error?: string;
};

type AppServerThreadResponse = {
  thread: { id: string };
};

type AppServerTurnResponse = {
  turn: { id: string };
};

type ActiveAppServerJobRun = {
  job: RepairJobRow;
  taskDir: string;
  threadId: string;
  turnId: string;
  startedMs: number;
  autoContinueAttempts: number;
  settled: boolean;
  timer: NodeJS.Timeout;
  resolve: () => void;
  reject: (error: Error) => void;
};

function issueKey(issue: IssueRow): string {
  return `${issue.repo_name}-${issue.kind}-${issue.external_id}-${slugify(issue.title)}`;
}

function ensureTaskPackage(issue: IssueRow, job: RepairJobRow): string {
  if (job.task_dir) {
    return job.task_dir;
  }
  const taskDir = path.join(config.taskOutputDir, `${localDateSlug()}-${issueKey(issue)}-job-${job.id}`);
  fs.mkdirSync(taskDir, { recursive: true });
  db.prepare("UPDATE repair_jobs SET task_dir = ?, updated_at = ? WHERE id = ?").run(taskDir, nowIso(), job.id);
  return taskDir;
}

function writeCompletionHelper(taskDir: string): void {
  const helperPath = path.join(taskDir, "complete-job.mjs");
  fs.writeFileSync(
    helperPath,
    `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const requiredKeys = ${JSON.stringify(finalRequiredKeys)};
const input = process.argv[2] && process.argv[2] !== "-" ? process.argv[2] : fs.readFileSync(0, "utf8");
const payload = JSON.parse(input);
for (const key of requiredKeys) {
  if (!Object.prototype.hasOwnProperty.call(payload, key)) {
    throw new Error(\`Missing required final.json key: \${key}\`);
  }
}
const finalPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "final.json");
fs.writeFileSync(finalPath, \`\${JSON.stringify(payload, null, 2)}\\n\`);
console.log(\`Wrote \${finalPath}\`);
`
  );
  fs.chmodSync(helperPath, 0o755);
}

function tmuxSessionName(jobId: number): string {
  return `autofix-codex-${jobId}`;
}

function runTmux(args: string[], options: { input?: string; check?: boolean } = {}): string {
  const result = spawnSync("tmux", args, {
    cwd: config.workspaceRoot,
    encoding: "utf8",
    input: options.input
  });
  if ((options.check ?? true) && result.status !== 0) {
    throw new Error(`tmux ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout;
}

function sessionExists(sessionName: string): boolean {
  const result = spawnSync("tmux", ["has-session", "-t", sessionName], { encoding: "utf8" });
  return result.status === 0;
}

function tmuxSessionNames(): Set<string> {
  const result = spawnSync("tmux", ["list-sessions", "-F", "#{session_name}"], { encoding: "utf8" });
  if (result.status !== 0) {
    return new Set();
  }
  return new Set(result.stdout.split(/\r?\n/).map((name) => name.trim()).filter(Boolean));
}

function captureSession(sessionName: string): string {
  const result = spawnSync("tmux", ["capture-pane", "-pt", sessionName, "-S", "-300"], {
    cwd: config.workspaceRoot,
    encoding: "utf8"
  });
  return result.status === 0 ? result.stdout : "";
}

export function isCodexHookTrustPrompt(text: string): boolean {
  return text.includes("Hooks need review") && text.includes("hooks are new or changed");
}

export function promptTemplatePath(issue: Pick<IssueRow, "kind">, job: Pick<RepairJobRow, "mode">): string {
  if (issue.kind === "pr" || job.mode === "review_only") {
    return promptTemplatePaths.prReview;
  }
  if (job.mode === "issue_implementation" || job.mode === "reviewed_pr") {
    return promptTemplatePaths.issueImplementation;
  }
  return promptTemplatePaths.issueTriage;
}

function promptTemplateKey(issue: Pick<IssueRow, "kind">, job: Pick<RepairJobRow, "mode">): Exclude<ConfigurablePromptKey, "larkAssistant"> {
  if (issue.kind === "pr" || job.mode === "review_only") {
    return "prReview";
  }
  if (job.mode === "issue_implementation" || job.mode === "reviewed_pr") {
    return "issueImplementation";
  }
  return "issueTriage";
}

function readTextIfExists(filePath: string): string {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8").trim() : "";
}

function latestTriageJob(issueId: number, beforeJobId: number): RepairJobRow | null {
  return db.prepare(`
    SELECT * FROM repair_jobs
    WHERE issue_id = ?
      AND id != ?
      AND mode = 'issue_triage'
      AND final_json IS NOT NULL
    ORDER BY id DESC
    LIMIT 1
  `).get(issueId, beforeJobId) as RepairJobRow | undefined ?? null;
}

function hasHumanApprovedTriagePlan(jobId: number): boolean {
  const row = db.prepare(`
    SELECT 1 FROM job_events
    WHERE job_id = ?
      AND message = 'Human approved triage plan for implementation'
    LIMIT 1
  `).get(jobId) as { 1: number } | undefined;
  return Boolean(row);
}

export function buildTriageContext(issue: IssueRow, job: RepairJobRow): string {
  if (job.mode !== "issue_implementation" && job.mode !== "reviewed_pr") {
    return "";
  }
  const triageJob = latestTriageJob(issue.id, job.id);
  if (!triageJob?.task_dir) {
    return "No prior triage package was found. Stop with status blocked.";
  }
  return [
    `Triage job: #${triageJob.id}`,
    `Triage task package: ${triageJob.task_dir}`,
    hasHumanApprovedTriagePlan(job.id)
      ? "Human approval: the triage development plan has been explicitly approved for implementation. A `mid-human-review` triage decision is allowed to proceed within the approved plan."
      : "Human approval: not recorded. Only `easy-direct` triage may proceed automatically.",
    "",
    "### context-manifest.md",
    readTextIfExists(path.join(triageJob.task_dir, "context-manifest.md")) || "_missing_",
    "",
    "### development-plan.md",
    readTextIfExists(path.join(triageJob.task_dir, "development-plan.md")) || "_missing_",
    "",
    "### final.json",
    readTextIfExists(path.join(triageJob.task_dir, "final.json")) || "_missing_"
  ].join("\n");
}

function previousSuccessfulPrReview(issue: IssueRow, job: RepairJobRow): PreviousPrReviewContext | null {
  if (issue.kind !== "pr" || job.mode !== "review_only") {
    return null;
  }
  const row = db.prepare(`
    SELECT
      pr_review_runs.head_sha AS headSha,
      repair_jobs.id AS jobId,
      repair_jobs.task_dir AS taskDir,
      repair_jobs.codex_session_id AS codexSessionId
    FROM pr_review_runs
    JOIN repair_jobs ON repair_jobs.id = pr_review_runs.job_id
    WHERE pr_review_runs.issue_id = ?
      AND repair_jobs.id != ?
      AND pr_review_runs.status = 'succeeded'
      AND pr_review_runs.head_sha != ?
      AND repair_jobs.codex_session_id IS NOT NULL
    ORDER BY COALESCE(pr_review_runs.finished_at, pr_review_runs.started_at, pr_review_runs.created_at) DESC, pr_review_runs.id DESC
    LIMIT 1
  `).get(issue.id, job.id, issue.head_sha ?? "") as {
    headSha: string;
    jobId: number;
    taskDir: string | null;
    codexSessionId: string | null;
  } | undefined;
  if (!row?.codexSessionId) {
    return null;
  }
  return row;
}

export function buildPrReviewContext(issue: IssueRow, job: RepairJobRow): string {
  const previous = previousSuccessfulPrReview(issue, job);
  if (!previous) {
    return "";
  }
  return [
    "",
    "## Incremental Review Context",
    "",
    `This PR has already been reviewed in job #${previous.jobId}. Continue that Codex session and perform an incremental follow-up review.`,
    `Previous reviewed head SHA: \`${previous.headSha}\``,
    `Current head SHA: \`${issue.head_sha ?? "unknown"}\``,
    previous.taskDir ? `Previous task package: \`${previous.taskDir}\`` : "",
    "",
    "Review scope for this run:",
    `- Use \`${previous.headSha}..${issue.head_sha ?? "<current-head>"}\` as the primary diff range.`,
    "- Re-check prior blocking findings only when they touch the incremental changes or are needed to verify that the author fixed them.",
    "- Do not spend time re-reading unchanged files or re-reviewing the full base...head diff unless the incremental diff cannot be resolved safely.",
    "- Keep the posted review concise and focused on new or still-unresolved issues."
  ].filter(Boolean).join("\n");
}

function prepareReviewPackage(issue: IssueRow, job: RepairJobRow, taskDir: string): PreparedReviewPackage | null {
  if (issue.kind !== "pr" || job.mode !== "review_only") {
    return null;
  }
  const prepareReviewPackageScript = path.join(config.workspaceRoot, "skills", "tea-pr-review", "scripts", "prepare_review_package.py");
  if (!fs.existsSync(prepareReviewPackageScript)) return null;
  const previous = previousSuccessfulPrReview(issue, job);
  const args = [
    prepareReviewPackageScript,
    "--repo",
    `${issue.repo_owner}/${issue.repo_name}`,
    "--pr",
    issue.external_id,
    "--task-dir",
    taskDir,
    "--workspace-root",
    config.workspaceRoot,
    "--current-head",
    issue.head_sha ?? ""
  ];
  if (previous?.headSha) {
    args.push("--previous-head", previous.headSha);
  }
  try {
    const result = spawnSync("python3", args, {
      cwd: config.workspaceRoot,
      encoding: "utf8",
      timeout: 120_000
    });
    if (result.status !== 0) {
      const detail = (result.stderr || result.stdout || `prepare_review_package.py exited with ${result.status}`).trim();
      fs.writeFileSync(path.join(taskDir, "prepare-review-package-error.log"), `${detail}\n`);
      return { ok: false, error: detail };
    }
    return { ...(JSON.parse(result.stdout.trim()) as PreparedReviewPackage), ok: true };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fs.writeFileSync(path.join(taskDir, "prepare-review-package-error.log"), `${detail}\n`);
    return { ok: false, error: detail };
  }
}

export function preparedReviewPackageContext(taskDir: string): string {
  const contextPath = path.join(taskDir, "review-context.md");
  const summaryPath = path.join(taskDir, "prepare-review-package.json");
  const errorPath = path.join(taskDir, "prepare-review-package-error.log");
  if (fs.existsSync(contextPath)) {
    return [
      "",
      "## Prepared Review Package",
      "",
      `A deterministic review package has already been generated at \`${taskDir}\`. Read \`${contextPath}\` first.`,
      "Use the prepared `pr.json`, `review-comments.json`, `changed-files.json`, `diff-stat.txt`, `diff.patch`, `incremental-diff.patch`, and `record.seed.json` files before running broad tea/git/rg commands.",
      "Only run additional commands for targeted follow-up questions that the package cannot answer.",
      fs.existsSync(summaryPath) ? `Package summary: \`${summaryPath}\`` : ""
    ].filter(Boolean).join("\n");
  }
  if (fs.existsSync(errorPath)) {
    return [
      "",
      "## Prepared Review Package",
      "",
      `Package generation failed. Read \`${errorPath}\`, then fall back to the tea-pr-review workflow with bounded command output.`
    ].join("\n");
  }
  return "";
}

function writePrompt(issue: IssueRow, job: RepairJobRow, taskDir: string): void {
  const packageResult = prepareReviewPackage(issue, job, taskDir);
  if (packageResult && job.mode === "review_only") {
    addJobEvent(
      job.id,
      packageResult.ok ? "info" : "warn",
      packageResult.ok
        ? `Prepared PR review package (${packageResult.history_status ?? "unknown"}, changed files ${packageResult.changed_files ?? "unknown"})`
        : `PR review package preparation failed: ${packageResult.error ?? "unknown error"}`
    );
  }
  const template = configurablePrompt(promptTemplateKey(issue, job));
  const prContext = [buildPrReviewContext(issue, job), preparedReviewPackageContext(taskDir)].filter(Boolean).join("\n");
  const prompt = template
    .replaceAll("{{JOB_ID}}", String(job.id))
    .replaceAll("{{ISSUE_ID}}", String(issue.id))
    .replaceAll("{{ISSUE_EXTERNAL_ID}}", issue.external_id)
    .replaceAll("{{ISSUE_KIND}}", issue.kind)
    .replaceAll("{{ISSUE_TITLE}}", issue.title)
    .replaceAll("{{ISSUE_BODY}}", issue.body ?? "")
    .replaceAll("{{ISSUE_URL}}", issue.url ?? "")
    .replaceAll("{{ISSUE_AUTHOR}}", issue.author ?? "")
    .replaceAll("{{ISSUE_HEAD_SHA}}", issue.head_sha ?? "")
    .replaceAll("{{REPO_OWNER}}", issue.repo_owner)
    .replaceAll("{{REPO_NAME}}", issue.repo_name)
    .replaceAll("{{REPO_HINT}}", job.repo_hint ?? issue.repo_name)
    .replaceAll("{{TASK_DIR}}", taskDir)
    .replaceAll("{{MODE}}", job.mode)
    .replaceAll("{{WORKSPACE_ROOT}}", config.workspaceRoot)
    .replaceAll("{{AUTOFIX_REPO_ROOT}}", config.repoRoot)
    .replaceAll("{{TRIAGE_CONTEXT}}", buildTriageContext(issue, job))
    .replaceAll("{{PR_REVIEW_CONTEXT}}", prContext);

  fs.writeFileSync(path.join(taskDir, "prompt.md"), prompt);
  fs.copyFileSync(finalSchemaSourcePath, path.join(taskDir, "final-output.schema.json"));
  writeCompletionHelper(taskDir);
}

function readFinalJson(taskDir: string): Record<string, unknown> | null {
  const finalPath = path.join(taskDir, "final.json");
  if (!fs.existsSync(finalPath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(finalPath, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

type ReviewRunOutcome = {
  jobStatus: "done" | "blocked" | "failed";
  runStatus: "succeeded" | "cancelled" | "failed";
  posted: boolean;
  postedCommentUrl: string | null;
  verdict: "approve" | "comment" | "request_changes" | "unknown";
  error: string | null;
};

function reviewRecord(taskDir: string): Record<string, unknown> | null {
  const recordPath = path.join(taskDir, "record.json");
  if (!fs.existsSync(recordPath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(recordPath, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function reviewVerdict(value: unknown): ReviewRunOutcome["verdict"] {
  if (value === "request_changes") return "request_changes";
  if (value === "approve") return "approve";
  if (value === "comment" || value === "no_new_blockers" || value === "no_blocking_findings") return "comment";
  return "unknown";
}

function postedCommentMatchesIssue(commentUrl: string, issueUrl: string | null, baseUrls: string[]): boolean {
  if (!issueUrl) return false;
  try {
    const comment = new URL(commentUrl);
    const issue = new URL(issueUrl);
    const valid = (url: URL) => ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
    if (!valid(comment) || !valid(issue) || !/^#issuecomment-[1-9]\d*$/.test(comment.hash)) return false;
    const pathname = (url: URL) => url.pathname.replace(/\/+$/, "");
    const isPrPath = (value: string) => /\/[^/]+\/[^/]+\/pulls\/[1-9]\d*$/.test(value);
    if (comment.origin === issue.origin && pathname(comment) === pathname(issue)) return isPrPath(pathname(issue));

    // Configured entry points may include different reverse-proxy mount paths.
    const bases = baseUrls.flatMap((value) => {
      try {
        const base = new URL(value);
        return valid(base) && !base.search && !base.hash ? [base] : [];
      } catch { return []; }
    }).sort((a, b) => pathname(b).length - pathname(a).length);
    const relativePrPath = (url: URL): string | null => {
      const base = bases.find((candidate) => url.origin === candidate.origin && pathname(url).startsWith(`${pathname(candidate)}/`));
      if (!base) return null;
      const relative = pathname(url).slice(pathname(base).length);
      return /^\/[^/]+\/[^/]+\/pulls\/[1-9]\d*$/.test(relative) ? relative : null;
    };
    const expected = relativePrPath(issue);
    return expected !== null && relativePrPath(comment) === expected;
  } catch { return false; }
}

export function reviewRunOutcomeFromArtifacts(finalStatus: string, taskDir: string, issueUrl: string | null, baseUrls = config.giteaBaseUrls.length ? config.giteaBaseUrls : [config.giteaBaseUrl]): ReviewRunOutcome {
  if (finalStatus === "blocked") {
    return { jobStatus: "blocked", runStatus: "cancelled", posted: false, postedCommentUrl: null, verdict: "unknown", error: "PR review was blocked before a confirmed comment was posted" };
  }
  if (finalStatus === "failed") {
    return { jobStatus: "failed", runStatus: "failed", posted: false, postedCommentUrl: null, verdict: "unknown", error: "PR review reported failure" };
  }

  const record = reviewRecord(taskDir);
  const postedCommentUrl = typeof record?.posted_comment_url === "string" ? record.posted_comment_url : null;
  const posted = record?.state === "posted"
    && record.posted === true
    && Boolean(postedCommentUrl)
    && postedCommentMatchesIssue(postedCommentUrl!, issueUrl, baseUrls);
  if (!posted) {
    return {
      jobStatus: "failed",
      runStatus: "failed",
      posted: false,
      postedCommentUrl: null,
      verdict: "unknown",
      error: "PR review finished without a confirmed posted record.json comment URL"
    };
  }
  return {
    jobStatus: "done",
    runStatus: "succeeded",
    posted: true,
    postedCommentUrl,
    verdict: reviewVerdict(record?.verdict),
    error: null
  };
}

export function reconcilePrReviewRunArtifacts(limit = 1000): number {
  const rows = db.prepare(`
    SELECT pr_review_runs.id, repair_jobs.task_dir, issues.url
    FROM pr_review_runs
    JOIN repair_jobs ON repair_jobs.id = pr_review_runs.job_id
    JOIN issues ON issues.id = pr_review_runs.issue_id
    WHERE pr_review_runs.status = 'succeeded'
      AND repair_jobs.task_dir IS NOT NULL
      AND (pr_review_runs.verdict = 'unknown' OR pr_review_runs.posted_comment_url NOT LIKE '%#issuecomment-%')
    ORDER BY pr_review_runs.id ASC
    LIMIT ?
  `).all(limit) as Array<{ id: number; task_dir: string; url: string | null }>;
  let updated = 0;
  for (const row of rows) {
    const historicalRecord = reviewRecord(row.task_dir);
    const historicalCommentUrl = historicalRecord?.posted_comment_url;
    if (row.url && (typeof historicalCommentUrl !== "string" || !historicalCommentUrl.startsWith(`${row.url}#issuecomment-`))) continue;
    // Keep this legacy maintenance pass from applying new alias rules to history.
    const outcome = reviewRunOutcomeFromArtifacts("needs_review", row.task_dir, row.url, []);
    if (outcome.runStatus !== "succeeded") {
      continue;
    }
    db.prepare(`
      UPDATE pr_review_runs
      SET verdict = ?, posted = 1, posted_comment_url = ?
      WHERE id = ?
    `).run(outcome.verdict, outcome.postedCommentUrl, row.id);
    updated += 1;
  }
  return updated;
}

function tryAutoFinalizePostedReview(job: RepairJobRow, taskDir: string): Record<string, unknown> | null {
  if (job.mode !== "review_only") {
    return null;
  }
  const issue = db.prepare("SELECT * FROM issues WHERE id = ?").get(job.issue_id) as IssueRow | undefined;
  if (!issue || issue.kind !== "pr") {
    return null;
  }
  const reviewPath = path.join(taskDir, "review.md");
  const verificationPath = path.join(taskDir, "verification.md");
  if (!fs.existsSync(reviewPath) || !fs.existsSync(verificationPath)) {
    return null;
  }
  const outcome = reviewRunOutcomeFromArtifacts("needs_review", taskDir, issue.url);
  if (outcome.runStatus !== "succeeded") {
    return null;
  }
  const finalJson = {
    status: "needs_review",
    target_repo: `${issue.repo_owner}/${issue.repo_name}`,
    task_dir: taskDir,
    worktree_path: job.worktree_path ?? null,
    branch_name: job.branch_name ?? null,
    pr_url: issue.url ?? null,
    summary: `Reviewed ${issue.repo_owner}/${issue.repo_name}#${issue.external_id} and posted the review comment. Auto-finalized because the review and verification artifacts were complete but final.json was missing.`,
    verification: [
      `review.md exists: ${reviewPath}`,
      `verification.md exists: ${verificationPath}`,
      `record.json confirms posted comment: ${outcome.postedCommentUrl}`
    ],
    residual_risk: [
      "final.json was reconstructed by Agent Forge after Codex stopped before writing the completion artifact",
      "Use review.md and verification.md as the detailed review evidence"
    ],
    triage: {
      decision: "mid-human-review",
      scores: {
        difficulty: 3,
        workload: 2,
        importance: 3,
        complexity: 3
      },
      summary: "Review-only PR job; review artifacts and successful posting evidence were already present."
    },
    development_plan: {
      summary: "PR review scope only; no code changes were made.",
      steps: [
        "Use the prepared PR review package",
        "Post the review comment to the existing PR",
        "Record review evidence",
        "Auto-finalize the runner contract from completed artifacts"
      ],
      target_files: [],
      verification: [
        "review.md written",
        "record.json confirms successful tea comment posting"
      ],
      risks: [
        "Auto-finalized from artifacts because Codex stopped before final.json"
      ]
    }
  };
  fs.writeFileSync(path.join(taskDir, "final.json"), `${JSON.stringify(finalJson, null, 2)}\n`);
  addJobEvent(job.id, "warn", "Auto-finalized review job from posted review artifacts after Codex stopped before final.json");
  return finalJson;
}

function writeFailedFinalJson(job: RepairJobRow, taskDir: string, error: string): Record<string, unknown> {
  const diagnostics = readCodexSessionDiagnosticsForTask(job.id, taskDir, { writeTail: true });
  const finalJson = {
    status: "failed",
    target_repo: job.target_repo ?? job.repo_hint ?? null,
    task_dir: taskDir,
    worktree_path: job.worktree_path ?? null,
    branch_name: job.branch_name ?? null,
    pr_url: job.pr_url ?? null,
    summary: `Agent Forge runner failed before Codex wrote final.json: ${error}`,
    verification: [
      fs.existsSync(path.join(taskDir, "review.md")) ? `review.md exists: ${path.join(taskDir, "review.md")}` : "review.md was not written",
      fs.existsSync(path.join(taskDir, "verification.md")) ? `verification.md exists: ${path.join(taskDir, "verification.md")}` : "verification.md was not written"
    ],
    residual_risk: [
      diagnostics?.lastAgentMessage ? `Last Codex message: ${diagnostics.lastAgentMessage}` : "No final Codex answer was captured",
      diagnostics?.lastTimestamp ? `Last Codex activity: ${diagnostics.lastTimestamp}` : "Last Codex activity timestamp is unknown",
      diagnostics?.tailPath ? `Codex session tail: ${diagnostics.tailPath}` : "Codex session tail was not captured"
    ],
    triage: {
      decision: "hard-human-handoff",
      scores: {
        difficulty: 5,
        workload: 5,
        importance: 3,
        complexity: 5
      },
      summary: "Runner failed before Codex produced issue triage."
    },
    development_plan: {
      summary: "No development plan was produced because the runner failed.",
      steps: [],
      target_files: [],
      verification: [],
      risks: [error]
    }
  };
  fs.writeFileSync(path.join(taskDir, "final.json"), `${JSON.stringify(finalJson, null, 2)}\n`);
  return finalJson;
}

function writeTmuxLauncher(taskDir: string, sessionName: string, inputPath: string): string {
  const launcherPath = path.join(taskDir, "run-codex-tmux.sh");
  const args = buildInteractiveCodexArgs();
  const command = [quoteShell(resolveCodexExecutable()), ...args.map((arg) => quoteShell(arg))].join(" ");
  fs.writeFileSync(
    launcherPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `cd ${quoteShell(config.workspaceRoot)}`,
      `export AUTOFIX_CODEX_SESSION=${quoteShell(sessionName)}`,
      `export AUTOFIX_TASK_DIR=${quoteShell(taskDir)}`,
      `exec ${command} "$(<${quoteShell(inputPath)})"`
    ].join("\n")
  );
  fs.chmodSync(launcherPath, 0o755);
  return launcherPath;
}

function writeTmuxResumeLauncher(taskDir: string, sessionName: string, inputPath: string, sessionId: string): string {
  const launcherPath = path.join(taskDir, "run-codex-resume-tmux.sh");
  const args = ["resume", ...buildInteractiveCodexArgs(), sessionId];
  const command = [quoteShell(resolveCodexExecutable()), ...args.map((arg) => quoteShell(arg)), `"$(<${quoteShell(inputPath)})"`].join(" ");
  fs.writeFileSync(
    launcherPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `cd ${quoteShell(config.workspaceRoot)}`,
      `export AUTOFIX_CODEX_SESSION=${quoteShell(sessionName)}`,
      `export AUTOFIX_TASK_DIR=${quoteShell(taskDir)}`,
      `exec ${command}`
    ].join("\n")
  );
  fs.chmodSync(launcherPath, 0o755);
  return launcherPath;
}

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function codexArchiveMarkerPath(taskDir: string): string {
  return path.join(taskDir, "codex-session-archived.json");
}

function archivedCodexSessionId(taskDir: string | null): string | null {
  if (!taskDir) return null;
  const markerPath = codexArchiveMarkerPath(taskDir);
  if (!fs.existsSync(markerPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(markerPath, "utf8")) as { sessionId?: unknown };
    return typeof parsed.sessionId === "string" && parsed.sessionId ? parsed.sessionId : null;
  } catch {
    return null;
  }
}

function runCodexArchiveCommand(command: "archive" | "unarchive", sessionId: string) {
  return spawnSync(resolveCodexExecutable(), [command, sessionId], {
    cwd: config.workspaceRoot,
    encoding: "utf8"
  });
}

function unarchiveCodexSessionForReview(job: RepairJobRow, previousTaskDir: string | null, sessionId: string): void {
  if (archivedCodexSessionId(previousTaskDir) !== sessionId || !previousTaskDir) return;
  const result = runCodexArchiveCommand("unarchive", sessionId);
  if (result.status !== 0) {
    throw new Error(`Unable to restore archived Codex session ${sessionId}: ${(result.stderr || result.stdout).trim()}`);
  }
  fs.rmSync(codexArchiveMarkerPath(previousTaskDir), { force: true });
  addJobEvent(job.id, "info", `Restored archived Codex session ${sessionId} for incremental review`);
}

function archiveCompletedReviewCodexSession(job: RepairJobRow, taskDir: string, sessionId: string | null): void {
  if (job.mode !== "review_only" || !sessionId || archivedCodexSessionId(taskDir) === sessionId) return;
  const result = runCodexArchiveCommand("archive", sessionId);
  if (result.status !== 0) {
    addJobEvent(job.id, "warn", `Unable to archive Codex session ${sessionId}: ${(result.stderr || result.stdout).trim()}`);
    return;
  }
  fs.writeFileSync(codexArchiveMarkerPath(taskDir), `${JSON.stringify({ sessionId, archivedAt: nowIso() }, null, 2)}\n`);
  addJobEvent(job.id, "info", `Archived Codex session ${sessionId} after PR review completion`);
}

async function archiveCompletedAppServerReview(job: RepairJobRow, taskDir: string, sessionId: string | null): Promise<boolean> {
  if (job.mode !== "review_only" || !sessionId || archivedCodexSessionId(taskDir) === sessionId) {
    return true;
  }
  try {
    await codexAppServer.request("thread/archive", { threadId: sessionId }, 10_000);
  } catch (error) {
    addJobEvent(job.id, "warn", `Unable to archive Codex App Server thread ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
  fs.writeFileSync(codexArchiveMarkerPath(taskDir), `${JSON.stringify({ sessionId, archivedAt: nowIso(), transport: "codex-app-server" }, null, 2)}\n`);
  addJobEvent(job.id, "info", `Archived Codex App Server thread ${sessionId} after PR review completion`);
  try {
    await codexAppServer.requestIfRunning("thread/unsubscribe", { threadId: sessionId }, 10_000);
    addJobEvent(job.id, "info", `Released Agent Forge subscription for Codex thread ${sessionId}`);
  } catch (error) {
    addJobEvent(job.id, "warn", `Unable to unsubscribe Codex App Server thread ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return true;
}

export async function reconcileCompletedAppServerReviewSessions(limit = 100): Promise<number> {
  const jobs = db.prepare(`
    SELECT * FROM repair_jobs
    WHERE mode = 'review_only'
      AND status IN ('done', 'failed', 'blocked')
      AND task_dir IS NOT NULL
      AND codex_session_id IS NOT NULL
    ORDER BY COALESCE(finished_at, updated_at) DESC, id DESC
    LIMIT ?
  `).all(limit) as RepairJobRow[];
  let archived = 0;
  for (const job of jobs) {
    if (!job.task_dir || !isAppServerJobTask(job.task_dir) || archivedCodexSessionId(job.task_dir) === job.codex_session_id) {
      continue;
    }
    if (await archiveCompletedAppServerReview(job, job.task_dir, job.codex_session_id)) {
      archived += 1;
    }
  }
  return archived;
}

function buildReviewCommentContract(taskDir: string): string {
  return `
For review-only PR jobs, post the review before finalizing. Prefer this shell-safe shape:

\`\`\`bash
python3 - <<'PY'
import subprocess
from pathlib import Path

body = Path("${path.join(taskDir, "review.md")}").read_text()
subprocess.run(["tea", "comment", "<pr-number>", "-r", "<owner/repo>", body], check=True)
PY
\`\`\`
`;
}

function buildCodexPrompt(job: RepairJobRow, taskDir: string): string {
  const prompt = fs.readFileSync(path.join(taskDir, "prompt.md"), "utf8");
  const schema = fs.readFileSync(path.join(taskDir, "final-output.schema.json"), "utf8");
  const reviewCommentContract = job.mode === "review_only" ? buildReviewCommentContract(taskDir) : "";
  return `${prompt}

## Agent Forge Runner Contract

You are running in a Agent Forge managed Codex App Server thread.
You have full local filesystem and command execution permission for this workspace.

Before ending, you must write exactly one JSON object to:

\`${path.join(taskDir, "final.json")}\`

Use this finish command so Agent Forge can mark the job complete:

\`\`\`bash
node ${quoteShell(path.join(taskDir, "complete-job.mjs"))} <<'JSON'
{
  "status": "needs_review",
  "target_repo": null,
  "task_dir": ${JSON.stringify(taskDir)},
  "worktree_path": null,
  "branch_name": null,
  "pr_url": null,
  "summary": "Replace with the final outcome.",
  "verification": [],
  "residual_risk": [],
  "triage": {
    "decision": "mid-human-review",
    "scores": {
      "difficulty": 3,
      "workload": 3,
      "importance": 3,
      "complexity": 3
    },
    "summary": "Replace with issue triage. For PR review-only jobs, use mid-human-review."
  },
  "development_plan": {
    "summary": "Replace with the development plan or PR review scope.",
    "steps": [],
    "target_files": [],
    "verification": [],
    "risks": []
  }
}
JSON
\`\`\`

The JSON must match this schema:

\`\`\`json
${schema}
\`\`\`

Use null for unavailable target_repo, worktree_path, branch_name, or pr_url.
Do not stop after prose-only output; Agent Forge marks this job complete only after final.json exists.
After writing final.json, stop working and let the current Codex turn finish.
${reviewCommentContract}
`;
}

function startCodexTmuxSession(jobId: number, taskDir: string, prompt: string): string {
  const sessionName = tmuxSessionName(jobId);
  if (sessionExists(sessionName)) {
    throw new Error(`tmux session already exists: ${sessionName}`);
  }
  const inputPath = path.join(taskDir, "codex-input.md");
  fs.writeFileSync(inputPath, prompt);
  const launcherPath = writeTmuxLauncher(taskDir, sessionName, inputPath);
  runTmux(["new-session", "-d", "-s", sessionName, "-c", config.workspaceRoot, launcherPath]);
  activeTmuxSessions.set(jobId, sessionName);
  return sessionName;
}

function startCodexReviewSession(job: RepairJobRow, issue: IssueRow, taskDir: string, prompt: string): { sessionName: string; resumedSessionId: string | null } {
  const previous = previousSuccessfulPrReview(issue, job);
  if (!previous?.codexSessionId) {
    return {
      sessionName: startCodexTmuxSession(job.id, taskDir, prompt),
      resumedSessionId: null
    };
  }
  const resumeSessionId = resolveResumableCodexSession(previous);
  if (!resumeSessionId) {
    addJobEvent(
      job.id,
      "warn",
      `Skipped Codex resume from job #${previous.jobId}: saved session id ${previous.codexSessionId} was not found in local Codex session metadata; starting a fresh incremental review session`
    );
    return {
      sessionName: startCodexTmuxSession(job.id, taskDir, prompt),
      resumedSessionId: null
    };
  }

  unarchiveCodexSessionForReview(job, previous.taskDir, resumeSessionId);

  const sessionName = tmuxSessionName(job.id);
  if (sessionExists(sessionName)) {
    throw new Error(`tmux session already exists: ${sessionName}`);
  }
  const inputPath = path.join(taskDir, "codex-input.md");
  fs.writeFileSync(inputPath, prompt);
  writeTmuxResumeLauncher(taskDir, sessionName, inputPath, resumeSessionId);
  runTmux(["new-session", "-d", "-s", sessionName, "-c", config.workspaceRoot, path.join(taskDir, "run-codex-resume-tmux.sh")]);
  activeTmuxSessions.set(job.id, sessionName);
  db.prepare("UPDATE repair_jobs SET codex_session_id = ?, updated_at = ? WHERE id = ?").run(resumeSessionId, nowIso(), job.id);
  job.codex_session_id = resumeSessionId;
  addJobEvent(job.id, "info", `Resuming prior PR review Codex session ${resumeSessionId} from job #${previous.jobId}`);
  return { sessionName, resumedSessionId: resumeSessionId };
}

function continuationPrompt(job: RepairJobRow, taskDir: string): string {
  return [
    "Agent Forge runner detected that the previous turn ended before the required contract was completed.",
    "",
    "Continue the original task now. Do not only describe a plan.",
    `Task package: ${taskDir}`,
    "",
    "Required before you stop:",
    `1. Complete the requested ${job.mode === "review_only" ? "PR review" : "issue repair"} work.`,
    job.mode === "review_only" ? `2. Write the posted review body to ${path.join(taskDir, "review.md")} and post it to the original PR.` : "2. Preserve the original issue repair requirements.",
    `3. Record evidence in ${path.join(taskDir, "verification.md")}.`,
    `4. Write ${path.join(taskDir, "final.json")} using ${path.join(taskDir, "complete-job.mjs")}.`,
    "",
    "If you cannot complete the work, still write final.json with status \"failed\" or \"blocked\" and a concrete summary/residual_risk."
  ].join("\n");
}

function sendPromptToTmux(sessionName: string, prompt: string): void {
  runTmux(["send-keys", "-t", sessionName, prompt, "Enter"]);
}

function startCodexResumeTmuxSession(job: RepairJobRow, taskDir: string, sessionId: string, attempt: number): string {
  const sessionName = `${tmuxSessionName(job.id)}-resume-${attempt}`;
  if (sessionExists(sessionName)) {
    runTmux(["kill-session", "-t", sessionName], { check: false });
  }
  const prompt = continuationPrompt(job, taskDir);
  const args = ["resume", ...buildInteractiveCodexArgs(), sessionId, prompt];
  const command = [quoteShell(resolveCodexExecutable()), ...args.map((arg) => quoteShell(arg))].join(" ");
  const launcherPath = path.join(taskDir, `run-codex-resume-${attempt}.sh`);
  fs.writeFileSync(
    launcherPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `cd ${quoteShell(config.workspaceRoot)}`,
      `export AUTOFIX_CODEX_SESSION=${quoteShell(sessionName)}`,
      `export AUTOFIX_TASK_DIR=${quoteShell(taskDir)}`,
      `exec ${command}`
    ].join("\n")
  );
  fs.chmodSync(launcherPath, 0o755);
  runTmux(["new-session", "-d", "-s", sessionName, "-c", config.workspaceRoot, launcherPath]);
  activeTmuxSessions.set(job.id, sessionName);
  addJobEvent(job.id, "warn", `Resumed Codex session ${sessionId} in tmux ${sessionName} after missing final.json`);
  return sessionName;
}

function restartCodexTmuxSession(job: RepairJobRow, taskDir: string, sessionName: string, attempt: number, fresh: boolean): string {
  writeCapturedLog(taskDir, sessionName);
  if (sessionExists(sessionName)) {
    runTmux(["kill-session", "-t", sessionName], { check: false });
  }
  if (!fresh) {
    const previous = findCodexSessionForTask(job.id, taskDir);
    if (previous?.sessionId) {
      return startCodexResumeTmuxSession(job, taskDir, previous.sessionId, attempt);
    }
  }
  db.prepare("UPDATE repair_jobs SET codex_session_id = NULL, updated_at = ? WHERE id = ?").run(nowIso(), job.id);
  job.codex_session_id = null;
  const nextSessionName = startCodexTmuxSession(job.id, taskDir, buildCodexPrompt(job, taskDir));
  addJobEvent(job.id, "warn", `Started a fresh Codex session in tmux ${nextSessionName} after stalled review recovery`);
  return nextSessionName;
}

function writeCapturedLog(taskDir: string, sessionName: string): void {
  const text = captureSession(sessionName);
  if (text) {
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, "tmux-capture.log"), text);
  }
}

export function extractCodexSessionIdFromJsonl(text: string): string | null {
  let threadId: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      const event = JSON.parse(line) as { type?: string; thread_id?: unknown; payload?: { id?: unknown } };
      if (event.type === "session_meta" && typeof event.payload?.id === "string" && event.payload.id) {
        return event.payload.id;
      }
      if (event.type === "thread.started" && typeof event.thread_id === "string" && event.thread_id) {
        threadId = event.thread_id;
      }
    } catch {
      continue;
    }
  }
  return threadId;
}

type CodexSessionMeta = {
  id: string | null;
  timestamp: string | null;
  source: string | null;
};

function codexSessionMeta(text: string): CodexSessionMeta | null {
  const firstLine = text.split(/\r?\n/, 1)[0];
  if (!firstLine) {
    return null;
  }
  try {
    const event = JSON.parse(firstLine) as {
      type?: string;
      payload?: {
        id?: unknown;
        timestamp?: unknown;
        source?: unknown;
      };
    };
    if (event.type !== "session_meta") {
      return null;
    }
    return {
      id: typeof event.payload?.id === "string" ? event.payload.id : null,
      timestamp: typeof event.payload?.timestamp === "string" ? event.payload.timestamp : null,
      source: typeof event.payload?.source === "string" ? event.payload.source : null
    };
  } catch {
    return null;
  }
}

type CodexSessionFile = {
  filePath: string;
  mtimeMs: number;
};

type CodexSessionMatch = {
  filePath: string;
  sessionId: string;
  lastTimestamp: string | null;
  tailPath: string | null;
};

type CodexSessionDiagnostics = {
  taskComplete: boolean;
  taskCompleteWithoutAgentMessage: boolean;
  turnFailed: boolean;
  terminalError: string | null;
  lastAgentMessage: string | null;
  lastTimestamp: string | null;
};

function listCodexSessionFiles(root: string, maxFiles = 300): CodexSessionFile[] {
  const files: CodexSessionFile[] = [];
  const visit = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
        continue;
      }
      try {
        files.push({ filePath: entryPath, mtimeMs: fs.statSync(entryPath).mtimeMs });
      } catch {
        continue;
      }
    }
  };

  visit(root);
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, maxFiles);
}

function jobCreatedAtMs(jobId: number): number | null {
  const row = db.prepare("SELECT created_at FROM repair_jobs WHERE id = ?").get(jobId) as { created_at: string } | undefined;
  const timestamp = row?.created_at ? Date.parse(row.created_at) : NaN;
  return Number.isFinite(timestamp) ? timestamp : null;
}

function isPlausibleSessionForJob(text: string, jobId: number): boolean {
  const jobCreated = jobCreatedAtMs(jobId);
  const metaTimestamp = codexSessionMeta(text)?.timestamp;
  const sessionCreated = metaTimestamp ? Date.parse(metaTimestamp) : NaN;
  if (!jobCreated || !Number.isFinite(sessionCreated)) {
    return true;
  }
  const earliest = jobCreated - 36 * 60 * 60 * 1000;
  const latest = jobCreated + 24 * 60 * 60 * 1000;
  return sessionCreated >= earliest && sessionCreated <= latest;
}

export function isAutoFixSessionForTask(text: string, jobId: number, taskDir: string): boolean {
  if (!codexSessionMeta(text)) {
    return false;
  }
  if (!/# [^\n]+ (?:PR Review|Issue)/.test(text)) {
    return false;
  }
  if (!/[^\n]+ Runner Contract/.test(text)) {
    return false;
  }
  if (!text.includes(`Job ID: \`${jobId}\``) || !text.includes(`Task package: \`${taskDir}\``)) {
    return false;
  }
  return isPlausibleSessionForJob(text, jobId);
}

function findCodexSessionFileById(sessionId: string): string | null {
  const sessionsRoot = path.join(os.homedir(), ".codex", "sessions");
  for (const file of listCodexSessionFiles(sessionsRoot, 1000)) {
    let text: string;
    try {
      text = fs.readFileSync(file.filePath, "utf8");
    } catch {
      continue;
    }
    const meta = codexSessionMeta(text);
    if (meta?.id === sessionId || file.filePath.includes(sessionId)) {
      return file.filePath;
    }
  }
  return null;
}

function resolveResumableCodexSession(previous: PreviousPrReviewContext): string | null {
  if (previous.taskDir) {
    const session = findCodexSessionForTask(previous.jobId, previous.taskDir);
    if (session?.sessionId && findCodexSessionFileById(session.sessionId)) {
      return session.sessionId;
    }
  }
  if (previous.codexSessionId && findCodexSessionFileById(previous.codexSessionId)) {
    return previous.codexSessionId;
  }
  return null;
}

function findCodexSessionIdForTask(jobId: number, taskDir: string): string | null {
  return findCodexSessionForTask(jobId, taskDir)?.sessionId ?? null;
}

export function lastCodexJsonlTimestamp(text: string): string | null {
  const lines = text.trim().split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const event = JSON.parse(lines[index]) as { timestamp?: unknown };
      if (typeof event.timestamp === "string") {
        return event.timestamp;
      }
    } catch {
      continue;
    }
  }
  return null;
}

export function codexSessionDiagnostics(text: string): CodexSessionDiagnostics {
  const diagnostics: CodexSessionDiagnostics = {
    taskComplete: false,
    taskCompleteWithoutAgentMessage: false,
    turnFailed: false,
    terminalError: null,
    lastAgentMessage: null,
    lastTimestamp: lastCodexJsonlTimestamp(text)
  };
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      const event = JSON.parse(line) as {
        type?: unknown;
        error?: unknown;
        status?: unknown;
        payload?: {
          type?: unknown;
          message?: unknown;
          last_agent_message?: unknown;
          error?: unknown;
        };
      };
      const payloadType = typeof event.payload?.type === "string" ? event.payload.type : "";
      if (payloadType === "task_complete") {
        diagnostics.taskComplete = true;
        if (typeof event.payload?.last_agent_message === "string" && event.payload.last_agent_message.trim()) {
          diagnostics.lastAgentMessage = event.payload.last_agent_message.trim();
        } else {
          diagnostics.taskCompleteWithoutAgentMessage = true;
        }
      }
      if (payloadType === "turn_failed" || event.type === "turn.failed" || event.type === "turn_failed") {
        diagnostics.turnFailed = true;
      }
      if (event.type === "error") {
        const detail = event.payload?.error ?? event.error ?? event.status;
        diagnostics.terminalError = typeof detail === "string" ? detail : JSON.stringify(detail ?? "Codex returned an error");
      }
      if (payloadType === "agent_message" && typeof event.payload?.message === "string" && event.payload.message.trim()) {
        diagnostics.lastAgentMessage = event.payload.message.trim();
      }
    } catch {
      continue;
    }
  }
  return diagnostics;
}

function writeCodexSessionTail(taskDir: string, filePath: string): string | null {
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  const tail = text.trimEnd().split(/\r?\n/).slice(-80).join("\n");
  const tailPath = path.join(taskDir, "codex-session-tail.jsonl");
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(tailPath, `${tail}\n`);
  return tailPath;
}

function findCodexSessionForTask(jobId: number, taskDir: string, options: { writeTail?: boolean } = {}): CodexSessionMatch | null {
  const sessionsRoot = path.join(os.homedir(), ".codex", "sessions");
  for (const file of listCodexSessionFiles(sessionsRoot)) {
    let text: string;
    try {
      text = fs.readFileSync(file.filePath, "utf8");
    } catch {
      continue;
    }
    if (!isAutoFixSessionForTask(text, jobId, taskDir)) {
      continue;
    }
    const sessionId = extractCodexSessionIdFromJsonl(text);
    if (sessionId) {
      return {
        filePath: file.filePath,
        sessionId,
        lastTimestamp: lastCodexJsonlTimestamp(text),
        tailPath: options.writeTail ? writeCodexSessionTail(taskDir, file.filePath) : null
      };
    }
  }
  return null;
}

function readCodexSessionDiagnosticsForTask(jobId: number, taskDir: string, options: { writeTail?: boolean } = {}): (CodexSessionDiagnostics & { filePath: string; tailPath: string | null }) | null {
  const match = findCodexSessionForTask(jobId, taskDir, options);
  if (!match) {
    return null;
  }
  try {
    const diagnostics = codexSessionDiagnostics(fs.readFileSync(match.filePath, "utf8"));
    return { ...diagnostics, filePath: match.filePath, tailPath: match.tailPath };
  } catch {
    return {
      filePath: match.filePath,
      tailPath: match.tailPath,
      taskComplete: false,
      taskCompleteWithoutAgentMessage: false,
      turnFailed: false,
      terminalError: null,
      lastAgentMessage: null,
      lastTimestamp: match.lastTimestamp
    };
  }
}

export function isCodexSessionStalled(lastTimestamp: string | null, nowMs: number, timeoutMs: number): boolean {
  const timestampMs = lastTimestamp ? Date.parse(lastTimestamp) : NaN;
  return Number.isFinite(timestampMs) && nowMs - timestampMs >= timeoutMs;
}

export function isCodexRecoveryGraceElapsed(lastRecoveryAtMs: number, nowMs: number, timeoutMs: number): boolean {
  return lastRecoveryAtMs === 0 || nowMs - lastRecoveryAtMs >= timeoutMs;
}

function persistCodexSessionId(job: RepairJobRow, taskDir: string): string | null {
  if (job.codex_session_id && findCodexSessionFileById(job.codex_session_id)) {
    return job.codex_session_id;
  }
  const sessionId = findCodexSessionIdForTask(job.id, taskDir);
  if (!sessionId) {
    return null;
  }
  db.prepare("UPDATE repair_jobs SET codex_session_id = ?, updated_at = ? WHERE id = ?").run(sessionId, nowIso(), job.id);
  addJobEvent(job.id, "info", `Saved Codex session id ${sessionId}`);
  job.codex_session_id = sessionId;
  return sessionId;
}

function cleanupCodexTmuxSession(job: RepairJobRow, taskDir: string, sessionName: string): void {
  const latest = db.prepare("SELECT status FROM repair_jobs WHERE id = ?").get(job.id) as { status: string } | undefined;
  if (latest?.status === "running") {
    addJobEvent(job.id, "warn", `Skipped deleting ${sessionName} because job is still running`);
    return;
  }
  writeCapturedLog(taskDir, sessionName);
  const sessionId = persistCodexSessionId(job, taskDir);
  archiveCompletedReviewCodexSession(job, taskDir, sessionId);
  if (!config.codexTmuxKeepSessions && sessionExists(sessionName)) {
    runTmux(["kill-session", "-t", sessionName], { check: false });
    addJobEvent(job.id, "info", `Deleted tmux session ${sessionName}`);
  }
}

export function cleanupCodexJobSession(job: RepairJobRow): void {
  const latest = (db.prepare("SELECT * FROM repair_jobs WHERE id = ?").get(job.id) as RepairJobRow | undefined) ?? job;
  if (!latest.task_dir) {
    return;
  }
  if (isAppServerJobTask(latest.task_dir)) {
    return;
  }
  cleanupCodexTmuxSession(latest, latest.task_dir, tmuxSessionName(latest.id));
}

export function cleanupFinishedCodexTmuxSessions(): number {
  if (config.codexTmuxKeepSessions) {
    return 0;
  }
  const jobs = db.prepare(`
    SELECT * FROM repair_jobs
    WHERE status IN ('done', 'pr_created', 'blocked', 'failed')
      AND task_dir IS NOT NULL
    ORDER BY id ASC
  `).all() as RepairJobRow[];
  const activeSessions = tmuxSessionNames();
  let cleaned = 0;
  for (const job of jobs) {
    const sessionName = tmuxSessionName(job.id);
    if (!activeSessions.has(sessionName)) {
      continue;
    }
    cleanupCodexTmuxSession(job, String(job.task_dir), sessionName);
    cleaned += 1;
  }
  return cleaned;
}

function waitForFinalJson(job: RepairJobRow, taskDir: string, initialSessionName: string): Promise<void> {
  const started = Date.now();
  let sessionName = initialSessionName;
  let lastEventAt = 0;
  let lastSessionLookupAt = 0;
  let autoContinueAttempts = 0;
  let lastContinuedTimestamp: string | null = null;
  let lastAutoContinueAt = 0;
  let lastAutoContinueCooldownEventAt = 0;
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      const latest = db.prepare("SELECT status FROM repair_jobs WHERE id = ?").get(job.id) as { status: string } | undefined;
      if (latest?.status === "blocked") {
        clearInterval(timer);
        reject(new Error("Job cancelled"));
        return;
      }

      const now = Date.now();
      if (!job.codex_session_id && now - lastSessionLookupAt > 30_000) {
        lastSessionLookupAt = now;
        persistCodexSessionId(job, taskDir);
      }

      const finalJson = readFinalJson(taskDir);
      if (finalJson) {
        clearInterval(timer);
        resolve();
        return;
      }
      if (tryAutoFinalizePostedReview(job, taskDir)) {
        clearInterval(timer);
        resolve();
        return;
      }

      const diagnostics = readCodexSessionDiagnosticsForTask(job.id, taskDir);
      const canAutoContinue = autoContinueAttempts < config.codexJobAutoContinueAttempts;
      const autoContinueCooldownRemainingMs = lastAutoContinueAt
        ? Math.max(0, config.codexJobAutoContinueCooldownMs - (now - lastAutoContinueAt))
        : 0;
      const autoContinueCooldownReady = autoContinueCooldownRemainingMs <= 0;
      const hasNewCompletedTurn = Boolean(
        diagnostics?.taskComplete &&
        diagnostics.lastTimestamp &&
        diagnostics.lastTimestamp !== lastContinuedTimestamp
      );

      const sessionRunning = sessionExists(sessionName);
      const hookTrustPrompt = sessionRunning && isCodexHookTrustPrompt(captureSession(sessionName));
      if (hookTrustPrompt) {
        if (!canAutoContinue) {
          clearInterval(timer);
          reject(new Error(`Codex is waiting for hook trust after ${autoContinueAttempts} recovery attempts: ${sessionName}`));
          return;
        }
        autoContinueAttempts += 1;
        lastAutoContinueAt = now;
        sessionName = restartCodexTmuxSession(job, taskDir, sessionName, autoContinueAttempts, false);
        addJobEvent(
          job.id,
          "warn",
          `Restarted Codex after detecting the hook trust prompt (attempt ${autoContinueAttempts}/${config.codexJobAutoContinueAttempts})`
        );
        return;
      }
      const terminalError = diagnostics?.terminalError
        ?? (diagnostics?.turnFailed ? "Codex turn failed" : null);
      if (sessionRunning && terminalError) {
        if (!canAutoContinue) {
          clearInterval(timer);
          reject(new Error(`Codex session reported an unrecoverable error after ${autoContinueAttempts} recovery attempts: ${terminalError}`));
          return;
        }
        autoContinueAttempts += 1;
        lastAutoContinueAt = now;
        sessionName = restartCodexTmuxSession(job, taskDir, sessionName, autoContinueAttempts, true);
        addJobEvent(job.id, "warn", `Restarted Codex after terminal error (attempt ${autoContinueAttempts}/${config.codexJobAutoContinueAttempts}): ${terminalError}`);
        return;
      }

      if (sessionRunning && hasNewCompletedTurn && !canAutoContinue) {
        clearInterval(timer);
        reject(new Error(`Codex completed a turn without final.json after ${autoContinueAttempts} recovery attempts: ${sessionName}`));
        return;
      }

      if (sessionRunning && hasNewCompletedTurn && canAutoContinue && autoContinueCooldownReady) {
        autoContinueAttempts += 1;
        lastContinuedTimestamp = diagnostics?.lastTimestamp ?? null;
        lastAutoContinueAt = now;
        sendPromptToTmux(sessionName, continuationPrompt(job, taskDir));
        addJobEvent(
          job.id,
          "warn",
          diagnostics?.taskCompleteWithoutAgentMessage
            ? `Requested completion from ${sessionName} after Codex ended without an agent message (attempt ${autoContinueAttempts}/${config.codexJobAutoContinueAttempts})`
            : `Auto-continued ${sessionName} after Codex completed a turn without final.json (attempt ${autoContinueAttempts}/${config.codexJobAutoContinueAttempts})`
        );
        return;
      }
      if (sessionRunning && hasNewCompletedTurn && canAutoContinue && !autoContinueCooldownReady && now - lastAutoContinueCooldownEventAt > 60_000) {
        lastAutoContinueCooldownEventAt = now;
        addJobEvent(
          job.id,
          "info",
          `Waiting ${Math.ceil(autoContinueCooldownRemainingMs / 1000)}s before next auto-continue attempt for ${sessionName}`
        );
      }

      if (
        sessionRunning
        && !hasNewCompletedTurn
        && isCodexRecoveryGraceElapsed(lastAutoContinueAt, now, config.codexJobNoProgressTimeoutMs)
        && isCodexSessionStalled(diagnostics?.lastTimestamp ?? null, now, config.codexJobNoProgressTimeoutMs)
      ) {
        if (!canAutoContinue) {
          clearInterval(timer);
          reject(new Error(`Codex session made no progress for ${config.codexJobNoProgressTimeoutMs}ms after ${autoContinueAttempts} recovery attempts: ${sessionName}`));
          return;
        }
        autoContinueAttempts += 1;
        lastAutoContinueAt = now;
        sessionName = restartCodexTmuxSession(job, taskDir, sessionName, autoContinueAttempts, false);
        addJobEvent(job.id, "warn", `Restarted stalled Codex session after ${config.codexJobNoProgressTimeoutMs}ms without new activity (attempt ${autoContinueAttempts}/${config.codexJobAutoContinueAttempts})`);
        return;
      }

      if (!sessionRunning) {
        writeCapturedLog(taskDir, sessionName);
        const codexSession = findCodexSessionForTask(job.id, taskDir, { writeTail: true });
        if (codexSession && canAutoContinue && autoContinueCooldownReady) {
          autoContinueAttempts += 1;
          lastContinuedTimestamp = codexSession.lastTimestamp;
          lastAutoContinueAt = now;
          sessionName = startCodexResumeTmuxSession(job, taskDir, codexSession.sessionId, autoContinueAttempts);
          return;
        }
        if (codexSession && canAutoContinue && !autoContinueCooldownReady) {
          if (now - lastAutoContinueCooldownEventAt > 60_000) {
            lastAutoContinueCooldownEventAt = now;
            addJobEvent(
              job.id,
              "info",
              `Waiting ${Math.ceil(autoContinueCooldownRemainingMs / 1000)}s before resuming exited Codex session ${codexSession.sessionId}`
            );
          }
          return;
        }
        clearInterval(timer);
        const detail = codexSession
          ? `last Codex activity ${codexSession.lastTimestamp ?? "unknown"}; tail saved to ${codexSession.tailPath ?? codexSession.filePath}; auto-continue attempts ${autoContinueAttempts}/${config.codexJobAutoContinueAttempts}`
          : `no matching Codex session JSONL found; auto-continue attempts ${autoContinueAttempts}/${config.codexJobAutoContinueAttempts}`;
        reject(new Error(`tmux session exited before final.json was written: ${sessionName}; ${detail}`));
        return;
      }
      if (now - started > config.codexJobTimeoutMs) {
        clearInterval(timer);
        writeCapturedLog(taskDir, sessionName);
        reject(new Error(`Codex tmux session timed out after ${config.codexJobTimeoutMs}ms: ${sessionName}`));
        return;
      }
      if (now - lastEventAt > 60_000) {
        lastEventAt = now;
        writeCapturedLog(taskDir, sessionName);
        addJobEvent(job.id, "info", `Waiting for ${sessionName} to write final.json`);
      }
    }, 5000);
  });
}

export function buildCodexJobThreadParams(): Record<string, unknown> {
  return {
    cwd: config.workspaceRoot,
    model: config.codexModel || null,
    approvalPolicy: "never",
    sandbox: "danger-full-access",
    config: {
      model_reasoning_effort: config.codexReasoningEffort
    }
  };
}

export function isCodexAppServerActiveWriterError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /already has an active writer|active writer/i.test(message);
}

function appServerJobStatePath(taskDir: string): string {
  return path.join(taskDir, "codex-app-server-run.json");
}

function isAppServerJobTask(taskDir: string): boolean {
  try {
    const state = JSON.parse(fs.readFileSync(appServerJobStatePath(taskDir), "utf8")) as { transport?: unknown };
    return state.transport === "codex-app-server";
  } catch {
    return false;
  }
}

function writeAppServerJobState(
  job: RepairJobRow,
  taskDir: string,
  threadId: string,
  turnId: string | null,
  action: "thread/start" | "thread/resume" | "turn/start" | "turn/continue"
): void {
  fs.writeFileSync(appServerJobStatePath(taskDir), `${JSON.stringify({
    transport: "codex-app-server",
    action,
    jobId: job.id,
    threadId,
    turnId,
    cwd: config.workspaceRoot,
    updatedAt: nowIso()
  }, null, 2)}\n`);
}

function appServerJobEventsPath(taskDir: string): string {
  return path.join(taskDir, "codex-app-server-events.jsonl");
}

function appendAppServerJobEvent(run: ActiveAppServerJobRun, notification: CodexAppServerNotification): void {
  fs.appendFileSync(appServerJobEventsPath(run.taskDir), `${JSON.stringify(notification)}\n`);
}

function notificationTurnId(notification: CodexAppServerNotification): string | null {
  const params = notification.params as { turnId?: unknown; turn?: { id?: unknown } } | undefined;
  if (typeof params?.turnId === "string") {
    return params.turnId;
  }
  return typeof params?.turn?.id === "string" ? params.turn.id : null;
}

function finishAppServerJobRun(run: ActiveAppServerJobRun, error: Error | null): void {
  if (run.settled) {
    return;
  }
  run.settled = true;
  clearInterval(run.timer);
  unregisterCodexAppServerTurn(run.turnId);
  pendingAppServerJobNotifications.delete(run.turnId);
  if (activeAppServerJobRuns.get(run.job.id) === run) {
    activeAppServerJobRuns.delete(run.job.id);
  }
  if (error) {
    run.reject(error);
  } else {
    run.resolve();
  }
}

async function continueAppServerJobRun(run: ActiveAppServerJobRun): Promise<void> {
  const previousTurnId = run.turnId;
  unregisterCodexAppServerTurn(previousTurnId);
  pendingAppServerJobNotifications.delete(previousTurnId);
  try {
    const turn = await codexAppServer.request<AppServerTurnResponse>("turn/start", {
      threadId: run.threadId,
      input: [{ type: "text", text: continuationPrompt(run.job, run.taskDir) }],
      cwd: config.workspaceRoot,
      model: config.codexModel || null,
      effort: config.codexReasoningEffort,
      approvalPolicy: "never"
    });
    run.turnId = turn.turn.id;
    run.autoContinueAttempts += 1;
    registerCodexAppServerTurn(run.turnId);
    writeAppServerJobState(run.job, run.taskDir, run.threadId, run.turnId, "turn/continue");
    addJobEvent(run.job.id, "warn", `Auto-continued Codex App Server thread ${run.threadId} after missing final.json (attempt ${run.autoContinueAttempts}/${config.codexJobAutoContinueAttempts})`);
    const pending = pendingAppServerJobNotifications.get(run.turnId) ?? [];
    pendingAppServerJobNotifications.delete(run.turnId);
    for (const notification of pending) {
      handleAppServerJobNotification(run, notification);
    }
  } catch (error) {
    finishAppServerJobRun(run, error instanceof Error ? error : new Error(String(error)));
  }
}

function handleAppServerJobNotification(run: ActiveAppServerJobRun, notification: CodexAppServerNotification): void {
  if (run.settled) {
    return;
  }
  appendAppServerJobEvent(run, notification);
  if (notification.method !== "turn/completed") {
    return;
  }
  const params = notification.params as { turn?: { status?: unknown; error?: { message?: unknown; additionalDetails?: unknown } | null } } | undefined;
  const turn = params?.turn;
  if (turn?.status !== "completed") {
    const message = typeof turn?.error?.message === "string" ? turn.error.message : `Codex turn ${String(turn?.status ?? "failed")}`;
    const details = typeof turn?.error?.additionalDetails === "string" ? `\n\n${turn.error.additionalDetails}` : "";
    finishAppServerJobRun(run, new Error(`${message}${details}`));
    return;
  }
  if (readFinalJson(run.taskDir) || tryAutoFinalizePostedReview(run.job, run.taskDir)) {
    finishAppServerJobRun(run, null);
    return;
  }
  if (run.autoContinueAttempts >= config.codexJobAutoContinueAttempts) {
    finishAppServerJobRun(run, new Error(`Codex App Server thread completed without final.json after ${run.autoContinueAttempts} recovery attempts: ${run.threadId}`));
    return;
  }
  void continueAppServerJobRun(run);
}

function handleAppServerJobNotificationGlobally(notification: CodexAppServerNotification): void {
  const turnId = notificationTurnId(notification);
  if (!turnId) {
    return;
  }
  const run = [...activeAppServerJobRuns.values()].find((candidate) => candidate.turnId === turnId);
  if (run) {
    handleAppServerJobNotification(run, notification);
    return;
  }
  if (isCodexAppServerTurnRegistered(turnId)) {
    return;
  }
  const pending = pendingAppServerJobNotifications.get(turnId) ?? [];
  pending.push(notification);
  pendingAppServerJobNotifications.set(turnId, pending.slice(-200));
  if (pendingAppServerJobNotifications.size > 50) {
    pendingAppServerJobNotifications.delete(pendingAppServerJobNotifications.keys().next().value as string);
  }
}

codexAppServer.onNotification(handleAppServerJobNotificationGlobally);
codexAppServer.onExit((error) => {
  for (const run of [...activeAppServerJobRuns.values()]) {
    finishAppServerJobRun(run, error);
  }
});

function waitForAppServerJobTurn(job: RepairJobRow, taskDir: string, threadId: string, turnId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const run = {} as ActiveAppServerJobRun;
    Object.assign(run, {
      job,
      taskDir,
      threadId,
      turnId,
      startedMs: Date.now(),
      autoContinueAttempts: 0,
      settled: false,
      resolve,
      reject
    });
    run.timer = setInterval(() => {
      if (run.settled) {
        return;
      }
      const latest = db.prepare("SELECT status FROM repair_jobs WHERE id = ?").get(job.id) as { status?: string } | undefined;
      if (latest?.status === "blocked") {
        void codexAppServer.request("turn/interrupt", { threadId: run.threadId, turnId: run.turnId }).catch(() => {});
        finishAppServerJobRun(run, new Error("Job cancelled"));
        return;
      }
      if (Date.now() - run.startedMs > config.codexJobTimeoutMs) {
        void codexAppServer.request("turn/interrupt", { threadId: run.threadId, turnId: run.turnId }).catch(() => {});
        finishAppServerJobRun(run, new Error(`Codex App Server job timed out after ${config.codexJobTimeoutMs}ms: ${run.threadId}`));
      }
    }, 1000);
    activeAppServerJobRuns.set(job.id, run);
    registerCodexAppServerTurn(turnId);
    const pending = pendingAppServerJobNotifications.get(turnId) ?? [];
    pendingAppServerJobNotifications.delete(turnId);
    for (const notification of pending) {
      handleAppServerJobNotification(run, notification);
    }
  });
}

function appServerThreadName(issue: IssueRow): string {
  const subject = issue.title.replace(/\s+/g, " ").trim().slice(0, 72);
  return `${issue.kind === "pr" ? "PR 评审" : "Issue 任务"} · ${issue.repo_owner}/${issue.repo_name}#${issue.external_id}${subject ? ` · ${subject}` : ""}`;
}

async function resumeOrStartAppServerJobThread(job: RepairJobRow, issue: IssueRow, taskDir: string, resumeThreadId: string | null): Promise<string> {
  const threadParams = buildCodexJobThreadParams();
  let threadId = resumeThreadId;
  if (threadId) {
    try {
      await codexAppServer.request("thread/unarchive", { threadId }, 10_000).catch((error) => {
        if (!/not archived|already active/i.test(error instanceof Error ? error.message : String(error))) {
          throw error;
        }
      });
      const resumed = await codexAppServer.request<AppServerThreadResponse>("thread/resume", { threadId, ...threadParams });
      threadId = resumed.thread.id;
      if (archivedCodexSessionId(taskDir) === threadId) {
        fs.rmSync(codexArchiveMarkerPath(taskDir), { force: true });
      }
      addJobEvent(job.id, "info", `Resumed Codex App Server thread ${threadId}`);
      writeAppServerJobState(job, taskDir, threadId, null, "thread/resume");
    } catch (error) {
      if (isCodexAppServerActiveWriterError(error)) {
        throw new Error(`Codex thread ${threadId} is currently being written by the desktop app; close or finish that turn before Agent Forge resumes this review`);
      }
      addJobEvent(job.id, "warn", `Unable to resume Codex thread ${threadId}: ${error instanceof Error ? error.message : String(error)}; starting a fresh thread`);
      threadId = null;
    }
  }
  if (!threadId) {
    const started = await codexAppServer.request<AppServerThreadResponse>("thread/start", threadParams);
    threadId = started.thread.id;
    addJobEvent(job.id, "info", `Started Codex App Server thread ${threadId}`);
    writeAppServerJobState(job, taskDir, threadId, null, "thread/start");
  }
  db.prepare("UPDATE repair_jobs SET codex_session_id = ?, updated_at = ? WHERE id = ?").run(threadId, nowIso(), job.id);
  job.codex_session_id = threadId;
  void codexAppServer.requestIfRunning("thread/name/set", { threadId, name: appServerThreadName(issue) }, 10_000).catch(() => {});
  return threadId;
}

async function runCodexAppServerJob(job: RepairJobRow, issue: IssueRow, taskDir: string, prompt: string, resumeThreadId: string | null): Promise<void> {
  fs.writeFileSync(path.join(taskDir, "codex-input.md"), prompt);
  fs.writeFileSync(appServerJobEventsPath(taskDir), "");
  const threadId = await resumeOrStartAppServerJobThread(job, issue, taskDir, resumeThreadId);
  const turn = await codexAppServer.request<AppServerTurnResponse>("turn/start", {
    threadId,
    input: [{ type: "text", text: prompt }],
    cwd: config.workspaceRoot,
    model: config.codexModel || null,
    effort: config.codexReasoningEffort,
    approvalPolicy: "never"
  });
  writeAppServerJobState(job, taskDir, threadId, turn.turn.id, "turn/start");
  addJobEvent(job.id, "info", `Started Codex App Server turn ${turn.turn.id} in thread ${threadId}`);
  await waitForAppServerJobTurn(job, taskDir, threadId, turn.turn.id);
}

export async function runCodexJob(job: RepairJobRow): Promise<void> {
  const issue = db.prepare("SELECT * FROM issues WHERE id = ?").get(job.issue_id) as IssueRow | undefined;
  if (!issue) {
    throw new Error(`Issue ${job.issue_id} not found`);
  }

  const taskDir = ensureTaskPackage(issue, job);
  writePrompt(issue, job, taskDir);

  const prompt = buildCodexPrompt(job, taskDir);
  const previous = previousSuccessfulPrReview(issue, job);

  try {
    await runCodexAppServerJob(job, issue, taskDir, prompt, previous?.codexSessionId ?? null);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    addJobEvent(job.id, "error", message);
    writeFailedFinalJson(job, taskDir, message);
  }

  const finalJson = readFinalJson(taskDir);
  if (!finalJson) {
    throw new Error(`final.json disappeared after wait completed: ${taskDir}`);
  }
  applyFinalJsonResult(issue, job, finalJson);
  await archiveCompletedAppServerReview(job, taskDir, job.codex_session_id);
}

function finalJsonToJobStatus(finalJson: Record<string, unknown>, job?: Pick<RepairJobRow, "mode">): string {
  const status = String(finalJson.status ?? "needs_review");
  if (job?.mode === "issue_triage" && status === "triaged") {
    return "triaged";
  }
  return status === "pr_created" ? "pr_created" : status === "blocked" ? "blocked" : status === "failed" ? "failed" : "done";
}

function applyFinalJsonResult(issue: IssueRow, job: RepairJobRow, finalJson: Record<string, unknown>): void {
  let nextStatus = finalJsonToJobStatus(finalJson, job);
  const reviewOutcome = issue.kind === "pr" && job.mode === "review_only"
    ? reviewRunOutcomeFromArtifacts(nextStatus, String(finalJson.task_dir ?? job.task_dir ?? ""), issue.url)
    : null;
  if (reviewOutcome?.jobStatus === "failed") {
    nextStatus = "failed";
  }
  const finishedAt = nowIso();
  db.prepare(`
    UPDATE repair_jobs
    SET status = ?, target_repo = COALESCE(?, target_repo), branch_name = COALESCE(?, branch_name),
        worktree_path = COALESCE(?, worktree_path), pr_url = COALESCE(?, pr_url), final_json = ?,
        finished_at = ?, updated_at = ?
    WHERE id = ?
  `).run(
    nextStatus,
    finalJson.target_repo ?? null,
    finalJson.branch_name ?? null,
    finalJson.worktree_path ?? null,
    finalJson.pr_url ?? null,
    JSON.stringify(finalJson),
    finishedAt,
    finishedAt,
    job.id
  );
  if (reviewOutcome) {
    if (reviewOutcome.error) {
      db.prepare("UPDATE repair_jobs SET error = ? WHERE id = ?").run(reviewOutcome.error, job.id);
    }
    updatePrReviewRunForJob(job.id, {
      status: reviewOutcome.runStatus,
      verdict: reviewOutcome.verdict,
      posted: reviewOutcome.posted,
      postedCommentUrl: reviewOutcome.postedCommentUrl,
      taskPackagePath: String(finalJson.task_dir ?? job.task_dir ?? ""),
      finishedAt,
      postedAt: reviewOutcome.posted ? finishedAt : null,
      errorMessage: reviewOutcome.error
    });
  }
  if (issue.kind === "pr" && job.mode === "review_only") {
    db.prepare("UPDATE issues SET updated_at = ? WHERE id = ?").run(finishedAt, issue.id);
  } else {
    db.prepare("UPDATE issues SET status = ?, updated_at = ? WHERE id = ?").run(nextStatus, finishedAt, issue.id);
  }
  addJobEvent(job.id, "info", `Codex job finished with status ${nextStatus}`);
}

export async function resumeCodexJob(job: RepairJobRow): Promise<void> {
  const issue = db.prepare("SELECT * FROM issues WHERE id = ?").get(job.issue_id) as IssueRow | undefined;
  if (!issue) {
    throw new Error(`Issue ${job.issue_id} not found`);
  }

  const taskDir = ensureTaskPackage(issue, job);
  writeCompletionHelper(taskDir);
  const finalJson = readFinalJson(taskDir);
  if (finalJson) {
    addJobEvent(job.id, "info", "Recovered final.json for running job after worker restart");
    applyFinalJsonResult(issue, job, finalJson);
    if (!isAppServerJobTask(taskDir)) {
      cleanupCodexTmuxSession(job, taskDir, tmuxSessionName(job.id));
    }
    return;
  }

  if (isAppServerJobTask(taskDir)) {
    if (!job.codex_session_id) {
      throw new Error("running Codex App Server job has no saved thread id");
    }
    addJobEvent(job.id, "info", `Resuming Codex App Server thread ${job.codex_session_id} after worker restart`);
    try {
      await runCodexAppServerJob(job, issue, taskDir, continuationPrompt(job, taskDir), job.codex_session_id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      addJobEvent(job.id, "error", message);
      writeFailedFinalJson(job, taskDir, message);
    }
    const resumedFinalJson = readFinalJson(taskDir);
    if (!resumedFinalJson) {
      throw new Error(`final.json disappeared after App Server recovery: ${taskDir}`);
    }
    applyFinalJsonResult(issue, job, resumedFinalJson);
    await archiveCompletedAppServerReview(job, taskDir, job.codex_session_id);
    return;
  }

  const sessionName = tmuxSessionName(job.id);
  if (!sessionExists(sessionName)) {
    throw new Error(`running job has no active tmux session and no final.json: ${sessionName}`);
  }

  activeTmuxSessions.set(job.id, sessionName);
  addJobEvent(job.id, "info", `Resumed monitoring tmux session ${sessionName} after worker restart`);
  try {
    await waitForFinalJson(job, taskDir, sessionName);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    addJobEvent(job.id, "error", message);
    writeFailedFinalJson(job, taskDir, message);
  } finally {
    activeTmuxSessions.delete(job.id);
  }

  const resumedFinalJson = readFinalJson(taskDir);
  if (!resumedFinalJson) {
    throw new Error(`final.json disappeared after resumed wait completed: ${taskDir}`);
  }
  applyFinalJsonResult(issue, job, resumedFinalJson);
  cleanupCodexTmuxSession(job, taskDir, sessionName);
}

export function buildInteractiveCodexArgs(): string[] {
  const args = [
    "-C",
    config.workspaceRoot,
    "--dangerously-bypass-approvals-and-sandbox",
    "--dangerously-bypass-hook-trust",
    "--no-alt-screen"
  ];

  if (config.codexModel) {
    args.push("--model", config.codexModel);
  }
  if (config.codexReasoningEffort) {
    args.push("--config", `model_reasoning_effort="${config.codexReasoningEffort}"`);
  }
  return args;
}

export function cancelCodexJob(jobId: number): boolean {
  const appServerRun = activeAppServerJobRuns.get(jobId);
  if (appServerRun) {
    void codexAppServer.request("turn/interrupt", { threadId: appServerRun.threadId, turnId: appServerRun.turnId }).catch(() => {});
    return true;
  }
  const sessionName = activeTmuxSessions.get(jobId) ?? tmuxSessionName(jobId);
  if (!sessionExists(sessionName)) {
    return false;
  }
  runTmux(["kill-session", "-t", sessionName], { check: false });
  activeTmuxSessions.delete(jobId);
  return true;
}
