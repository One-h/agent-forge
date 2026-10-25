import fs from "node:fs";
import path from "node:path";
import type { RepairJobRow } from "./db.js";

export type TriageDecision = "easy-direct" | "mid-human-review" | "hard-human-handoff" | "unknown";

export type TriageSummary = {
  decision: TriageDecision;
  difficulty: number | null;
  workload: number | null;
  importance: number | null;
  complexity: number | null;
  summary: string | null;
};

export type DevelopmentPlanSummary = {
  summary: string | null;
  steps: string[];
  targetFiles: string[];
  verification: string[];
  risks: string[];
};

export type TaskPackageSummary = {
  path: string | null;
  files: Array<{ name: string; path: string; exists: boolean; bytes: number | null }>;
  finalJson: Record<string, unknown> | null;
  triage: TriageSummary;
  developmentPlan: DevelopmentPlanSummary;
};

const taskPackageFiles = [
  "prompt.md",
  "final.json",
  "review.md",
  "verification.md",
  "context-manifest.md",
  "development-plan.md",
  "record.json",
  "codex-input.md",
  "codex-session-tail.jsonl",
  "tmux-capture.log"
];

function safeReadJson(filePath: string): Record<string, unknown> | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function readFinalJson(job: RepairJobRow, taskDir: string): Record<string, unknown> | null {
  if (job.final_json) {
    try {
      const parsed = JSON.parse(job.final_json) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Fall through to the on-disk final.json below.
    }
  }
  return safeReadJson(path.join(taskDir, "final.json"));
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeDecision(value: unknown): TriageDecision {
  return value === "easy-direct" || value === "mid-human-review" || value === "hard-human-handoff" ? value : "unknown";
}

export function triageSummaryFromFinalJson(finalJson: Record<string, unknown> | null): TriageSummary {
  const triage = finalJson?.triage && typeof finalJson.triage === "object" && !Array.isArray(finalJson.triage)
    ? finalJson.triage as Record<string, unknown>
    : {};
  const scores = triage.scores && typeof triage.scores === "object" && !Array.isArray(triage.scores)
    ? triage.scores as Record<string, unknown>
    : {};

  return {
    decision: normalizeDecision(triage.decision),
    difficulty: numberOrNull(scores.difficulty),
    workload: numberOrNull(scores.workload),
    importance: numberOrNull(scores.importance),
    complexity: numberOrNull(scores.complexity),
    summary: typeof triage.summary === "string" && triage.summary.trim() ? triage.summary : null
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function developmentPlanFromFinalJson(finalJson: Record<string, unknown> | null): DevelopmentPlanSummary {
  const plan = finalJson?.development_plan && typeof finalJson.development_plan === "object" && !Array.isArray(finalJson.development_plan)
    ? finalJson.development_plan as Record<string, unknown>
    : {};
  return {
    summary: typeof plan.summary === "string" && plan.summary.trim() ? plan.summary : null,
    steps: stringArray(plan.steps),
    targetFiles: stringArray(plan.target_files),
    verification: stringArray(plan.verification),
    risks: stringArray(plan.risks)
  };
}

export function taskPackageSummary(job: RepairJobRow): TaskPackageSummary {
  const taskDir = job.task_dir && path.isAbsolute(job.task_dir) ? job.task_dir : null;
  const finalJson = taskDir ? readFinalJson(job, taskDir) : null;
  return {
    path: taskDir,
    files: taskPackageFiles.map((name) => {
      const filePath = taskDir ? path.join(taskDir, name) : name;
      const exists = taskDir ? fs.existsSync(filePath) : false;
      return {
        name,
        path: filePath,
        exists,
        bytes: exists ? fs.statSync(filePath).size : null
      };
    }),
    finalJson,
    triage: triageSummaryFromFinalJson(finalJson),
    developmentPlan: developmentPlanFromFinalJson(finalJson)
  };
}
