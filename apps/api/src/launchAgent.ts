import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "./config.js";
import { resolveLaunchAgentLabel, resolveLaunchRuntimeEnv } from "./launchAgentIdentity.js";

const launchAgentDirectory = path.join(os.homedir(), "Library", "LaunchAgents");
const LAUNCH_AGENT_LABEL = resolveLaunchAgentLabel(launchAgentDirectory, config.repoRoot);
const launchAgentPath = path.join(launchAgentDirectory, `${LAUNCH_AGENT_LABEL}.plist`);
const launchLogDirectory = path.join(config.repoRoot, "data", "launchd");

export type LaunchAgentStatus = {
  supported: boolean;
  label: string;
  plistPath: string;
  installed: boolean;
  loaded: boolean;
  running: boolean;
  startDeferred: boolean;
  logDirectory: string;
};

function launchDomain(): string {
  return `gui/${process.getuid?.() ?? 0}`;
}

function launchService(): string {
  return `${launchDomain()}/${LAUNCH_AGENT_LABEL}`;
}

function command(command: string, args: string[]) {
  return spawnSync(command, args, { encoding: "utf8", timeout: 10_000 });
}

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function plistContents(): string {
  const pathValue = [process.env.PATH, path.join(os.homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].filter(Boolean).join(":");
  const values = [
    ["PATH", pathValue],
    ["HOME", os.homedir()]
  ];
  const runtimeEnv = resolveLaunchRuntimeEnv(config.repoRoot);
  if (runtimeEnv) values.push(["AGENT_FORGE_RUNTIME_ENV", runtimeEnv]);
  else if (config.larkAgentUrl) throw new Error("Save the Lark integration to a local runtime.env before installing the persistent service");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key><array>
    <string>${xml(process.execPath)}</string>
    <string>${xml(path.join(config.repoRoot, "scripts", "start-local.mjs"))}</string>
  </array>
  <key>WorkingDirectory</key><string>${xml(config.repoRoot)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xml(path.join(launchLogDirectory, "autofix-console.out.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(launchLogDirectory, "autofix-console.err.log"))}</string>
  <key>EnvironmentVariables</key><dict>${values.map(([key, value]) => `<key>${key}</key><string>${xml(value)}</string>`).join("")}</dict>
</dict></plist>
`;
}

function isLoaded(): boolean {
  if (process.platform !== "darwin") return false;
  return command("launchctl", ["print", launchService()]).status === 0;
}

function portsOccupied(): boolean {
  for (const port of [config.port, config.webPort, config.companionPort]) {
    if (command("lsof", ["-tiTCP:" + String(port), "-sTCP:LISTEN"]).status === 0) {
      return true;
    }
  }
  return false;
}

function ensureSupported(): void {
  if (process.platform !== "darwin") {
    throw new Error("launchd 常驻启动仅支持 macOS");
  }
}

function ensureProductionBuild(): void {
  const tsc = path.join(config.repoRoot, "node_modules", "typescript", "bin", "tsc");
  const vite = path.join(config.repoRoot, "node_modules", "vite", "bin", "vite.js");
  const run = (entry: string, args: string[], cwd = config.repoRoot) => {
    const result = spawnSync(process.execPath, [entry, ...args], { cwd, encoding: "utf8", timeout: 120_000 });
    if (result.status !== 0) {
      throw new Error((typeof result.stderr === "string" && result.stderr.trim()) || "构建失败");
    }
  };
  run(tsc, ["-p", "apps/api/tsconfig.json"]);
  run(tsc, ["-p", "apps/web/tsconfig.json"]);
  run(tsc, ["-p", "apps/codex-companion/tsconfig.json"]);
  run(vite, ["build"], path.join(config.repoRoot, "apps", "web"));
  run(vite, ["build"], path.join(config.repoRoot, "apps", "codex-companion"));
}

function launchctlOrThrow(args: string[]): void {
  const result = command("launchctl", args);
  if (result.status !== 0) {
    const detail = typeof result.stderr === "string" ? result.stderr.trim() : "";
    throw new Error(detail || `launchctl ${args[0]} 失败`);
  }
}

export function launchAgentStatus(startDeferred = false): LaunchAgentStatus {
  const installed = fs.existsSync(launchAgentPath);
  const loaded = installed && isLoaded();
  const printed = loaded ? command("launchctl", ["print", launchService()]) : null;
  const output = typeof printed?.stdout === "string" ? printed.stdout : "";
  return {
    supported: process.platform === "darwin",
    label: LAUNCH_AGENT_LABEL,
    plistPath: launchAgentPath,
    installed,
    loaded,
    running: /state = running/.test(output),
    startDeferred,
    logDirectory: launchLogDirectory
  };
}

export function installLaunchAgent(): LaunchAgentStatus {
  ensureSupported();
  ensureProductionBuild();
  fs.mkdirSync(launchAgentDirectory, { recursive: true });
  fs.mkdirSync(launchLogDirectory, { recursive: true });
  fs.writeFileSync(launchAgentPath, plistContents(), { mode: 0o600 });
  if (portsOccupied()) {
    return launchAgentStatus(true);
  }
  if (!isLoaded()) {
    launchctlOrThrow(["bootstrap", launchDomain(), launchAgentPath]);
  }
  launchctlOrThrow(["kickstart", "-k", launchService()]);
  return launchAgentStatus();
}

export function restartLaunchAgent(): void {
  ensureSupported();
  if (!fs.existsSync(launchAgentPath)) {
    throw new Error("请先安装常驻服务");
  }
  if (!isLoaded()) {
    launchctlOrThrow(["bootstrap", launchDomain(), launchAgentPath]);
  }
  launchctlOrThrow(["kickstart", "-k", launchService()]);
}

export function uninstallLaunchAgent(): void {
  ensureSupported();
  if (isLoaded()) {
    const result = command("launchctl", ["bootout", launchService()]);
    if (result.status !== 0) {
      const detail = typeof result.stderr === "string" ? result.stderr.trim() : "";
      throw new Error(detail || "无法停止常驻服务");
    }
  }
  fs.rmSync(launchAgentPath, { force: true });
}
