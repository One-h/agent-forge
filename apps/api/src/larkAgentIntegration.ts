import { config } from "./config.js";
import path from "node:path";
import { getAppSettings, persistedRuntimeConfig } from "./db.js";
import { syncLarkRuntimeSettings, withLarkRuntimeSettingsLock } from "./larkRuntimeSettingsSync.js";

export const forgeLarkAgentCapabilities = [
  { id: "forge.gitea.review-pr", title: "评审 PR", description: "Start a Forge PR review workflow. Input requires issueId and optional repoHint.", inputSchema: { type: "object", properties: { issueId: { type: "integer" }, repoHint: { type: "string" } }, required: ["issueId"] }, risk: "local-write" },
  { id: "forge.gitea.triage-issue", title: "分析 Issue", description: "Start Forge issue triage. Input requires issueId and optional repoHint.", inputSchema: { type: "object", properties: { issueId: { type: "integer" }, repoHint: { type: "string" } }, required: ["issueId"] }, risk: "local-write" },
  { id: "forge.deploy.inspect", title: "检查生产发布目标", description: "Read the exact main revision, image, ArgoCD Application and live workload state before deployment. Input requires repo and apps.", inputSchema: { type: "object", properties: { repo: { type: "string" }, apps: { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] } }, required: ["repo", "apps"] }, risk: "read" },
  { id: "forge.deploy.production", title: "生产发布", description: "Deploy an inspected target. Input requires repo, apps and expectedRevision. This always requires approval.", inputSchema: { type: "object", properties: { repo: { type: "string" }, apps: { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] }, expectedRevision: { type: "string" } }, required: ["repo", "apps", "expectedRevision"] }, risk: "external-write" },
  {
    id: "forge.todo.create",
    title: "创建待办",
    description: "Create a Forge todo with priority, tags, due date and reminder policy.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", maxLength: 160 },
        description: { type: ["string", "null"], maxLength: 4000 },
        priority: { type: "string", enum: ["urgent", "high", "normal", "low"] },
        tags: { type: "array", items: { type: "string", maxLength: 32 }, maxItems: 8 },
        dueAt: { type: ["string", "null"], format: "date-time" },
        reminderFrequency: { type: "string", enum: ["none", "every_2_hours", "daily", "weekly"] },
        notifyOnCompletion: { type: "boolean" }
      },
      required: ["title"]
    },
    risk: "local-write"
  }
];

export async function registerForgeLarkAgentCapabilities(): Promise<number> {
  if (!config.larkAgentUrl) return 0;
  const response = await fetch(`${config.larkAgentUrl}/v1/capabilities/register`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(config.larkAgentToken ? { authorization: `Bearer ${config.larkAgentToken}` } : {}) },
    body: JSON.stringify({ capabilities: forgeLarkAgentCapabilities.filter(capability => !capability.id.startsWith("forge.deploy.") || Boolean(getAppSettings().deploymentAdapterPath)) })
  });
  if (!response.ok) throw new Error(await response.text());
  const registered = (await response.json() as { registered: number }).registered;
  await withLarkRuntimeSettingsLock(async () => {
    const remote = await larkAgentFetch("/v1/settings") as { trustedExecutionEnabled?: unknown; workspaceRoot?: unknown } | null;
    if (typeof remote?.trustedExecutionEnabled === "boolean" && typeof remote.workspaceRoot === "string") {
      const local = persistedRuntimeConfig();
      await syncLarkRuntimeSettings({
        trustedExecutionEnabled: getAppSettings().larkTrustedExecutionEnabled,
        ...(local.workspaceRoot ? { workspaceRoot: path.resolve(local.workspaceRoot) } : {})
      });
    }
  });
  return registered;
}

export async function larkAgentRequest(path: string, init: RequestInit = {}): Promise<unknown> {
  if (!config.larkAgentUrl) return null;
  const response = await fetch(`${config.larkAgentUrl}${path}`, { ...init, headers: { ...(config.larkAgentToken ? { authorization: `Bearer ${config.larkAgentToken}` } : {}), ...init.headers } });
  const body = await response.text();
  if (!response.ok) throw new Error(body);
  if (!body.trim()) return null;
  return JSON.parse(body) as unknown;
}

export async function larkAgentFetch(path: string): Promise<unknown> { return larkAgentRequest(path); }

export class LarkAgentResponseError extends Error {
  constructor(public readonly statusCode: number, public readonly responseBody: unknown) {
    super(`Lark Agent returned HTTP ${statusCode}`);
  }
}

export async function larkAgentProxyFetch(path: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(`${config.larkAgentUrl}${path}`, {
    ...init,
    headers: { ...(config.larkAgentToken ? { authorization: `Bearer ${config.larkAgentToken}` } : {}), ...init.headers }
  });
  const text = await response.text();
  let body: unknown = null;
  if (text.trim()) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = text;
    }
  }
  if (!response.ok) throw new LarkAgentResponseError(response.status, body);
  return body;
}
