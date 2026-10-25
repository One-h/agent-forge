#!/usr/bin/env node
import Database from "better-sqlite3";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const databasePath = process.env.DATABASE_PATH ?? "./apps/api/data/autofix.sqlite";
const dbPath = path.isAbsolute(databasePath) ? databasePath : path.resolve(repoRoot, databasePath);
const lockTtlMs = Number(process.env.REPO_SETUP_LOCK_TTL_MS ?? 300_000);
const waitMs = Number(process.env.REPO_SETUP_LOCK_WAIT_MS ?? 300_000);
const pollMs = Number(process.env.REPO_SETUP_LOCK_POLL_MS ?? 1000);

const [repoKey, jobIdText, separator, ...command] = process.argv.slice(2);
if (!repoKey || !jobIdText || separator !== "--" || command.length === 0) {
  console.error("Usage: scripts/with-repo-setup-lock.mjs <repo-key> <job-id> -- <command> [args...]");
  process.exit(2);
}

const jobId = Number(jobIdText);
if (!Number.isInteger(jobId)) {
  console.error(`Invalid job id: ${jobIdText}`);
  process.exit(2);
}

const db = new Database(dbPath);
db.exec(`
  CREATE TABLE IF NOT EXISTS repo_setup_locks (
    repo_key TEXT PRIMARY KEY,
    job_id INTEGER NOT NULL,
    locked_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
`);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanupExpiredLocks() {
  db.prepare("DELETE FROM repo_setup_locks WHERE expires_at < ?").run(new Date().toISOString());
}

function acquireLock() {
  cleanupExpiredLocks();
  const lockedAt = new Date();
  const expiresAt = new Date(lockedAt.getTime() + lockTtlMs);
  try {
    db.prepare("INSERT INTO repo_setup_locks (repo_key, job_id, locked_at, expires_at) VALUES (?, ?, ?, ?)").run(
      repoKey,
      jobId,
      lockedAt.toISOString(),
      expiresAt.toISOString()
    );
    return true;
  } catch (error) {
    if (String(error.message).includes("UNIQUE constraint failed")) {
      return false;
    }
    throw error;
  }
}

function releaseLock() {
  db.prepare("DELETE FROM repo_setup_locks WHERE repo_key = ? AND job_id = ?").run(repoKey, jobId);
}

async function main() {
  const deadline = Date.now() + waitMs;
  while (!acquireLock()) {
    if (Date.now() >= deadline) {
      console.error(`Timed out waiting for repo setup lock: ${repoKey}`);
      process.exit(1);
    }
    await sleep(pollMs);
  }

  const child = spawn(command[0], command.slice(1), { stdio: "inherit" });
  const code = await new Promise((resolve) => {
    child.on("close", resolve);
  });
  releaseLock();
  process.exit(code ?? 1);
}

process.on("SIGINT", () => {
  releaseLock();
  process.exit(130);
});
process.on("SIGTERM", () => {
  releaseLock();
  process.exit(143);
});

await main();
