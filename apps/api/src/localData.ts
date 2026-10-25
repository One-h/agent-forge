import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "./config.js";
import { db } from "./db.js";

const launchLogDirectory = path.join(config.repoRoot, "data", "launchd");
const larkTaskPrefix = path.join(os.tmpdir(), "autofix-lark-codex-");

export type LocalDataUsage = {
  databaseBytes: number;
  taskArtifactBytes: number;
  taskArtifactCount: number;
  larkArtifactBytes: number;
  larkArtifactCount: number;
  launchLogBytes: number;
  totalBytes: number;
};

export type LocalDataCleanupTarget = "completed-task-artifacts" | "launchd-logs";

export type LocalDataCleanupResult = {
  target: LocalDataCleanupTarget;
  removedCount: number;
  reclaimedBytes: number;
};

function directoryStats(target: string): { bytes: number; count: number } {
  if (!fs.existsSync(target)) return { bytes: 0, count: 0 };
  let bytes = 0;
  let count = 0;
  const visit = (current: string) => {
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(current)) visit(path.join(current, entry));
      return;
    }
    if (stat.isFile()) {
      bytes += stat.size;
      count += 1;
    }
  };
  visit(target);
  return { bytes, count };
}

function safeWithin(candidate: string, root: string): boolean {
  const resolved = path.resolve(candidate);
  return resolved === root || resolved.startsWith(`${root}${path.sep}`);
}

function removableRepairTaskDirectories(cutoff: string): Array<{ path: string; bytes: number }> {
  const rows = db.prepare(`
    SELECT id, task_dir FROM repair_jobs
    WHERE status IN ('done', 'pr_created', 'blocked', 'failed', 'triaged')
      AND COALESCE(finished_at, updated_at) < ?
      AND task_dir IS NOT NULL
  `).all(cutoff) as Array<{ id: number; task_dir: string }>;
  const root = path.resolve(config.taskOutputDir);
  const removed: Array<{ path: string; bytes: number }> = [];
  const clear = db.prepare("UPDATE repair_jobs SET task_dir = NULL, updated_at = ? WHERE id = ?");
  const transaction = db.transaction(() => {
    for (const row of rows) {
      if (!safeWithin(row.task_dir, root) || row.task_dir === root || !fs.existsSync(row.task_dir)) continue;
      const bytes = directoryStats(row.task_dir).bytes;
      fs.rmSync(row.task_dir, { recursive: true, force: true });
      clear.run(new Date().toISOString(), row.id);
      removed.push({ path: row.task_dir, bytes });
    }
  });
  transaction();
  return removed;
}

function removableLarkTaskDirectories(cutoff: string): Array<{ path: string; bytes: number }> {
  const rows = db.prepare(`
    SELECT id, codex_task_dir FROM lark_messages
    WHERE codex_status IN ('answered', 'failed', 'timeout', 'skipped')
      AND received_at < ?
      AND codex_task_dir IS NOT NULL
  `).all(cutoff) as Array<{ id: number; codex_task_dir: string }>;
  const removed: Array<{ path: string; bytes: number }> = [];
  const clear = db.prepare("UPDATE lark_messages SET codex_task_dir = NULL WHERE id = ?");
  const transaction = db.transaction(() => {
    for (const row of rows) {
      if (!safeWithin(row.codex_task_dir, path.dirname(larkTaskPrefix)) || !path.resolve(row.codex_task_dir).startsWith(larkTaskPrefix) || !fs.existsSync(row.codex_task_dir)) continue;
      const bytes = directoryStats(row.codex_task_dir).bytes;
      fs.rmSync(row.codex_task_dir, { recursive: true, force: true });
      clear.run(row.id);
      removed.push({ path: row.codex_task_dir, bytes });
    }
  });
  transaction();
  return removed;
}

export function localDataUsage(): LocalDataUsage {
  const database = [config.databasePath, `${config.databasePath}-wal`, `${config.databasePath}-shm`]
    .reduce((total, filePath) => total + (fs.existsSync(filePath) ? fs.statSync(filePath).size : 0), 0);
  const tasks = directoryStats(config.taskOutputDir);
  const larkDirectories = [...new Set((db.prepare("SELECT codex_task_dir FROM lark_messages WHERE codex_task_dir IS NOT NULL").all() as Array<{ codex_task_dir: string }>)
    .map((row) => row.codex_task_dir)
    .filter((directory) => path.resolve(directory).startsWith(larkTaskPrefix)))];
  const lark = larkDirectories.reduce((total, directory) => {
    const stats = directoryStats(directory);
    return { bytes: total.bytes + stats.bytes, count: total.count + (stats.bytes > 0 ? 1 : 0) };
  }, { bytes: 0, count: 0 });
  const logs = directoryStats(launchLogDirectory);
  return {
    databaseBytes: database,
    taskArtifactBytes: tasks.bytes,
    taskArtifactCount: tasks.count,
    larkArtifactBytes: lark.bytes,
    larkArtifactCount: lark.count,
    launchLogBytes: logs.bytes,
    totalBytes: database + tasks.bytes + lark.bytes + logs.bytes
  };
}

export function cleanupLocalData(target: LocalDataCleanupTarget, olderThanDays: number): LocalDataCleanupResult {
  if (!Number.isInteger(olderThanDays) || olderThanDays < 1 || olderThanDays > 3_650) {
    throw new Error("保留天数必须在 1 到 3650 之间");
  }
  const cutoff = new Date(Date.now() - olderThanDays * 86_400_000);
  if (target === "completed-task-artifacts") {
    const candidates = [
      ...removableRepairTaskDirectories(cutoff.toISOString()),
      ...removableLarkTaskDirectories(cutoff.toISOString())
    ];
    const reclaimedBytes = candidates.reduce((total, directory) => total + directory.bytes, 0);
    return { target, removedCount: candidates.length, reclaimedBytes };
  }

  if (!fs.existsSync(launchLogDirectory)) return { target, removedCount: 0, reclaimedBytes: 0 };
  let removedCount = 0;
  let reclaimedBytes = 0;
  for (const entry of fs.readdirSync(launchLogDirectory)) {
    const filePath = path.join(launchLogDirectory, entry);
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.mtimeMs >= cutoff.getTime()) continue;
    reclaimedBytes += stat.size;
    fs.rmSync(filePath, { force: true });
    removedCount += 1;
  }
  return { target, removedCount, reclaimedBytes };
}
