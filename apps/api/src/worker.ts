import { config } from "./config.js";
import { addJobEvent, cleanupExpiredRepoSetupLocks, db, getAppSettings, migrate, updatePrReviewRunForJob, type RepairJobRow } from "./db.js";
import { syncGiteaIssues } from "./gitea.js";
import { cleanupCodexJobSession, cleanupFinishedCodexTmuxSessions, reconcileCompletedAppServerReviewSessions, reconcilePrReviewRunArtifacts, resumeCodexJob, runCodexJob } from "./codexRunner.js";
import { nowIso } from "./time.js";
import { startTodoNotificationWorker, stopTodoNotificationWorker } from "./todoNotifications.js";

const activeJobs = new Set<number>();
let syncTimer: NodeJS.Timeout | undefined;
let workerTimer: NodeJS.Timeout | undefined;
let syncInFlight = false;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nextQueuedJob(): RepairJobRow | undefined {
  return db.prepare("SELECT * FROM repair_jobs WHERE status = 'queued' ORDER BY id ASC LIMIT 1").get() as RepairJobRow | undefined;
}

function runningJobs(): RepairJobRow[] {
  return db.prepare("SELECT * FROM repair_jobs WHERE status = 'running' ORDER BY id ASC").all() as RepairJobRow[];
}

async function runJob(job: RepairJobRow): Promise<void> {
  activeJobs.add(job.id);
  const startedAt = nowIso();
  db.prepare("UPDATE repair_jobs SET status = 'running', started_at = ?, updated_at = ? WHERE id = ?").run(startedAt, startedAt, job.id);
  updatePrReviewRunForJob(job.id, { status: "running", startedAt });
  try {
    await runCodexJob(job);
  } catch (error) {
    const latest = db.prepare("SELECT status FROM repair_jobs WHERE id = ?").get(job.id) as { status: string } | undefined;
    if (latest?.status === "blocked") {
      addJobEvent(job.id, "warn", "Job stopped after cancellation");
      updatePrReviewRunForJob(job.id, { status: "cancelled", finishedAt: nowIso(), errorMessage: "Cancelled by user" });
      cleanupCodexJobSession({ ...job, status: "blocked" });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    const finishedAt = nowIso();
    db.prepare("UPDATE repair_jobs SET status = 'failed', error = ?, finished_at = ?, updated_at = ? WHERE id = ?").run(
      message,
      finishedAt,
      finishedAt,
      job.id
    );
    addJobEvent(job.id, "error", message);
    updatePrReviewRunForJob(job.id, { status: "failed", errorMessage: message, finishedAt });
    cleanupCodexJobSession({ ...job, status: "failed" });
  } finally {
    activeJobs.delete(job.id);
  }
}

async function resumeJob(job: RepairJobRow): Promise<void> {
  activeJobs.add(job.id);
  updatePrReviewRunForJob(job.id, { status: "running", startedAt: job.started_at ?? nowIso() });
  try {
    await resumeCodexJob(job);
  } catch (error) {
    const latest = db.prepare("SELECT status FROM repair_jobs WHERE id = ?").get(job.id) as { status: string } | undefined;
    if (latest?.status !== "running") {
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    const finishedAt = nowIso();
    db.prepare("UPDATE repair_jobs SET status = 'failed', error = ?, finished_at = ?, updated_at = ? WHERE id = ?").run(
      message,
      finishedAt,
      finishedAt,
      job.id
    );
    addJobEvent(job.id, "error", message);
    updatePrReviewRunForJob(job.id, { status: "failed", errorMessage: message, finishedAt });
    cleanupCodexJobSession({ ...job, status: "failed" });
  } finally {
    activeJobs.delete(job.id);
  }
}

async function workerTick(): Promise<void> {
  cleanupExpiredRepoSetupLocks();
  while (activeJobs.size < config.maxConcurrentCodexJobs) {
    const job = nextQueuedJob();
    if (!job) {
      return;
    }
    void runJob(job);
    await sleep(50);
  }
}

async function syncTick(): Promise<void> {
  if (syncInFlight) {
    console.warn("Gitea sync skipped: another sync is still running");
    return;
  }
  syncInFlight = true;
  try {
    const result = await syncGiteaIssues();
    console.log(`Gitea sync mode=${result.mode} scanned=${result.scanned} upserted=${result.upserted} filtered=${result.filtered}`);
  } catch (error) {
    console.warn(`Gitea sync skipped: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    syncInFlight = false;
  }
}

function resetSyncTimer(): void {
  if (syncTimer) {
    clearInterval(syncTimer);
  }
  syncTimer = setInterval(() => {
    void syncTick();
  }, getAppSettings().pollIntervalMs);
}

export function rescheduleGiteaSyncTimer(): void {
  if (!syncTimer) {
    return;
  }
  resetSyncTimer();
}

export function startBackgroundWorkers(): void {
  migrate();
  setTimeout(() => {
    const cleaned = cleanupFinishedCodexTmuxSessions();
    if (cleaned > 0) {
      console.log(`Cleaned ${cleaned} finished Codex tmux session(s)`);
    }
  }, 0);
  setTimeout(() => {
    const reconciled = reconcilePrReviewRunArtifacts();
    if (reconciled > 0) {
      console.log(`Reconciled ${reconciled} posted PR review artifact(s)`);
    }
  }, 1000);
  setTimeout(() => {
    void reconcileCompletedAppServerReviewSessions().then((archived) => {
      if (archived > 0) {
        console.log(`Archived ${archived} completed Codex App Server PR review thread(s)`);
      }
    }).catch((error) => console.warn(`Unable to reconcile completed Codex App Server PR review threads: ${error instanceof Error ? error.message : String(error)}`));
  }, 1500);
  for (const job of runningJobs()) {
    void resumeJob(job);
  }
  workerTimer = setInterval(() => {
    void workerTick();
  }, 2000);
  resetSyncTimer();
  void workerTick();
  void syncTick();
  startTodoNotificationWorker();
}

export function stopBackgroundWorkers(): void {
  if (workerTimer) clearInterval(workerTimer);
  if (syncTimer) clearInterval(syncTimer);
  stopTodoNotificationWorker();
}
