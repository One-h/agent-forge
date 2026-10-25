type ForgeCapability = {
  id: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  risk: "read" | "local-write" | "external-write";
};

export const forgeCapabilities: ForgeCapability[] = [
  { id: "forge.gitea.review-pr", title: "评审 PR", description: "Start a Forge PR review workflow. Input requires issueId and optional repoHint.", inputSchema: { type: "object", properties: { issueId: { type: "integer" }, repoHint: { type: "string" } }, required: ["issueId"] }, risk: "local-write" },
  { id: "forge.gitea.triage-issue", title: "分析 Issue", description: "Start Forge issue triage. Input requires issueId and optional repoHint.", inputSchema: { type: "object", properties: { issueId: { type: "integer" }, repoHint: { type: "string" } }, required: ["issueId"] }, risk: "local-write" },
  { id: "forge.deploy.inspect", title: "检查生产发布目标", description: "Read the exact main revision, image, ArgoCD Application and live workload state before a production deployment. Input requires repo and apps.", inputSchema: { type: "object", properties: { repo: { type: "string" }, apps: { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] } }, required: ["repo", "apps"] }, risk: "read" },
  { id: "forge.deploy.production", title: "生产发布", description: "Deploy an inspected production target. Input requires repo, apps and the exact expectedRevision returned by forge.deploy.inspect. This is externally visible and always requires approval.", inputSchema: { type: "object", properties: { repo: { type: "string" }, apps: { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] }, expectedRevision: { type: "string" } }, required: ["repo", "apps", "expectedRevision"] }, risk: "external-write" },
  { id: "forge.todo.create", title: "创建待办", description: "Create a Forge Codex todo.", inputSchema: { type: "object" }, risk: "local-write" }
];

export async function registerForgeCapabilities(baseUrl: string, token?: string): Promise<number> {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/capabilities/register`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ capabilities: forgeCapabilities })
  });
  if (!response.ok) throw new Error(await response.text());
  return (await response.json() as { registered: number }).registered;
}
