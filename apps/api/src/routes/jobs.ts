import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { cancelCodexJob } from "../codexRunner.js";
import { db, updatePrReviewRunForJob, type RepairJobRow } from "../db.js";
import { taskPackageSummary } from "../taskPackages.js";
import { nowIso } from "../time.js";

const jobListQuerySchema = z.object({
  updated_after: z.string().datetime().optional()
});

export async function jobRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/jobs", async (request) => {
    const { updated_after: updatedAfter } = jobListQuerySchema.parse(request.query ?? {});
    const where = updatedAfter
      ? "WHERE repair_jobs.updated_at > ? OR repair_jobs.status IN ('queued', 'running')"
      : "";
    return db.prepare(`
      SELECT
        repair_jobs.id,
        repair_jobs.status,
        repair_jobs.mode,
        repair_jobs.updated_at,
        issues.repo_owner,
        issues.repo_name,
        issues.title AS issue_title,
        issues.kind AS issue_kind,
        issues.external_id
      FROM repair_jobs
      JOIN issues ON issues.id = repair_jobs.issue_id
      ${where}
      ORDER BY repair_jobs.updated_at DESC, repair_jobs.id DESC
      LIMIT 200
    `).all(...(updatedAfter ? [updatedAfter] : []));
  });

  app.get("/api/jobs/:id", async (request, reply) => {
    const { id } = z.object({ id: z.coerce.number() }).parse(request.params);
    const job = db.prepare("SELECT * FROM repair_jobs WHERE id = ?").get(id) as RepairJobRow | undefined;
    if (!job) return reply.code(404).send({ error: "Job not found" });
    return {
      ...job,
      task_package: taskPackageSummary(job)
    };
  });

  app.get("/api/jobs/:id/events", async (request) => {
    const { id } = z.object({ id: z.coerce.number() }).parse(request.params);
    return db.prepare("SELECT * FROM job_events WHERE job_id = ? ORDER BY id ASC LIMIT 1000").all(id);
  });

  app.post("/api/jobs/:id/cancel", async (request, reply) => {
    const { id } = z.object({ id: z.coerce.number() }).parse(request.params);
    const job = db.prepare("SELECT * FROM repair_jobs WHERE id = ?").get(id) as RepairJobRow | undefined;
    if (!job) return reply.code(404).send({ error: "Job not found" });
    if (!["queued", "running"].includes(job.status)) {
      return reply.code(409).send({ error: `Cannot cancel job in status ${job.status}` });
    }
    db.prepare("UPDATE repair_jobs SET status = 'blocked', error = 'Cancelled by user', finished_at = ?, updated_at = ? WHERE id = ?").run(
      nowIso(),
      nowIso(),
      id
    );
    updatePrReviewRunForJob(id, { status: "cancelled", errorMessage: "Cancelled by user", finishedAt: nowIso() });
    if (job.status === "running") {
      cancelCodexJob(id);
    }
    return db.prepare("SELECT * FROM repair_jobs WHERE id = ?").get(id);
  });
}
