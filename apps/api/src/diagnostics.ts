import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { db } from "./db.js";

export type LocalDiagnostic = {
  key: string;
  label: string;
  status: "pass" | "warn" | "fail";
  detail: string;
};

const DIAGNOSTIC_CACHE_TTL_MS = 60_000;
let diagnosticCache: { expiresAt: number; diagnostics: LocalDiagnostic[] } | null = null;

function commandDiagnostic(key: string, label: string, command: string, args: string[]): Promise<LocalDiagnostic> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "ignore" });
    const timeout = setTimeout(() => child.kill("SIGTERM"), 5_000);
    child.on("error", () => resolve({ key, label, status: "fail", detail: "未安装或不可执行" }));
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve(code === 0
        ? { key, label, status: "pass", detail: "已就绪" }
        : { key, label, status: "fail", detail: "未安装或不可执行" });
    });
  });
}

function filesystemDiagnostics(): LocalDiagnostic[] {
  const outputDir = path.dirname(config.databasePath);
  const workspaceExists = fs.existsSync(config.workspaceRoot);
  const result: LocalDiagnostic[] = [{
    key: "workspace",
    label: "工作区",
    status: workspaceExists ? "pass" : "fail",
    detail: workspaceExists ? config.workspaceRoot : "工作区路径不存在"
  }];
  try {
    fs.mkdirSync(outputDir, { recursive: true });
    fs.accessSync(outputDir, fs.constants.R_OK | fs.constants.W_OK);
    const stats = fs.statfsSync(outputDir);
    const freeBytes = Number(stats.bavail) * Number(stats.bsize);
    result.push({
      key: "database",
      label: "本地数据库",
      status: freeBytes > 512 * 1024 * 1024 ? "pass" : "warn",
      detail: `可读写，剩余 ${(freeBytes / 1024 / 1024 / 1024).toFixed(1)} GB`
    });
  } catch {
    result.push({ key: "database", label: "本地数据库", status: "fail", detail: "数据库目录不可读写" });
  }
  return result;
}

async function giteaDiagnostic(): Promise<LocalDiagnostic> {
  if (!config.giteaBaseUrl || !config.giteaToken) {
    return { key: "gitea", label: "Gitea 连接", status: "warn", detail: "尚未配置地址或 token" };
  }
  try {
    const response = await fetch(`${config.giteaBaseUrl}/api/v1/user`, {
      headers: { Authorization: `token ${config.giteaToken}`, Accept: "application/json" },
      signal: AbortSignal.timeout(5_000)
    });
    return response.ok
      ? { key: "gitea", label: "Gitea 连接", status: "pass", detail: "token 可读取当前用户" }
      : { key: "gitea", label: "Gitea 连接", status: "fail", detail: `验证失败，HTTP ${response.status}` };
  } catch {
    return { key: "gitea", label: "Gitea 连接", status: "fail", detail: "无法连接 Gitea" };
  }
}

export async function localDiagnostics(options: { refresh?: boolean } = {}): Promise<LocalDiagnostic[]> {
  if (!options.refresh && diagnosticCache && diagnosticCache.expiresAt > Date.now()) {
    return diagnosticCache.diagnostics;
  }
  const quickCheck = db.prepare("PRAGMA quick_check").get() as { quick_check?: string } | undefined;
  const migration = quickCheck?.quick_check === "ok"
    ? { key: "migration", label: "数据库迁移", status: "pass" as const, detail: "数据库完整，可执行迁移" }
    : { key: "migration", label: "数据库迁移", status: "fail" as const, detail: "数据库完整性检查失败" };
  const commandResults = await Promise.all([
    commandDiagnostic("codex", "Codex CLI", "codex", ["--version"]),
    commandDiagnostic("tmux", "tmux", "tmux", ["-V"]),
    commandDiagnostic("tea", "Tea CLI", "tea", ["--version"]),
    commandDiagnostic("lark", "飞书 CLI", "lark-cli", ["--version"]),
    giteaDiagnostic()
  ]);
  const diagnostics = [
    ...filesystemDiagnostics(),
    migration,
    ...commandResults
  ];
  diagnosticCache = { expiresAt: Date.now() + DIAGNOSTIC_CACHE_TTL_MS, diagnostics };
  return diagnostics;
}
