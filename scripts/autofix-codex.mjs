#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { access, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDirectory, "..");
const existingPanes = spawnSync("tmux", ["list-panes", "-a", "-F", "#{session_name}\t#{pane_current_path}"], { encoding: "utf8" });
const existingSession = (existingPanes.stdout ?? "").split("\n").map(line => line.split("\t")).find(([, directory]) => directory === repoRoot)?.[0];
const session = process.env.AGENT_FORGE_TMUX_SESSION || existingSession || "agent-forge-dev";
const appPath = "/Applications/ChatGPT.app";
const cdpPort = Number(process.env.AUTOFIX_CODEX_CDP_PORT || 9237);
const profilePath = process.env.AUTOFIX_CODEX_PROFILE || "/private/tmp/autofix-codex-companion-profile";

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function nodeBinForRepo() {
  const requested = (await readFile(path.join(repoRoot, ".nvmrc"), "utf8")).trim().replace(/^v/, "");
  const requestedMajor = requested.split(".")[0];
  const nvmVersions = path.join(os.homedir(), ".nvm", "versions", "node");
  const candidates = await readdir(nvmVersions).catch(() => []);
  const matching = candidates
    .filter((name) => name.replace(/^v/, "").split(".")[0] === requestedMajor)
    .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
  for (const version of matching) {
    const bin = path.join(nvmVersions, version, "bin");
    if (await exists(path.join(bin, "node")) && await exists(path.join(bin, "npm"))) return bin;
  }
  if (process.versions.node.split(".")[0] === requestedMajor) return path.dirname(process.execPath);
  throw new Error(`未找到 .nvmrc 要求的 Node ${requestedMajor}。请先运行 nvm install ${requestedMajor}。`);
}

async function fetchOk(url, timeoutMs = 1_000) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return response.ok;
  } catch {
    return false;
  }
}

function hasSession() {
  return spawnSync("tmux", ["has-session", "-t", session], { stdio: "ignore" }).status === 0;
}

async function servicesHealthy() {
  const checks = await Promise.all([
    fetchOk("http://127.0.0.1:4731/api/health"),
    fetchOk("http://127.0.0.1:4732/"),
    fetchOk("http://127.0.0.1:4734/health"),
  ]);
  return checks.every(Boolean);
}

async function ensureServices() {
  if (await servicesHealthy()) {
    console.log("Agent Forge 服务已就绪。");
    return;
  }
  if (hasSession()) throw new Error("统一服务已存在但尚未完全就绪，请检查该服务日志；不会中断已有任务。");
  for (const port of [4731, 4732, 4734]) {
    if (spawnSync("lsof", ["-tiTCP:" + port, "-sTCP:LISTEN"], { stdio: "ignore" }).status === 0) throw new Error(`端口 ${port} 已占用；不会启动第二个服务或停止未知进程。`);
  }
  const nodeBin = await nodeBinForRepo();
  const servicePath = [nodeBin, process.env.PATH].filter(Boolean).join(":");
  const command = `env PATH=${shellQuote(servicePath)} npm run dev`;
  const result = spawnSync("tmux", ["new-session", "-d", "-s", session, "-c", repoRoot, command], { cwd: repoRoot, stdio: "inherit" });
  const deadline = Date.now() + 30_000;
  while (result.status === 0 && !(await servicesHealthy()) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 500));
  if (result.status !== 0 || !(await servicesHealthy())) {
    throw new Error("Agent Forge 服务启动失败，请检查服务日志。");
  }
}

async function findCodexTarget(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  do {
    try {
      const targets = await fetch(`http://127.0.0.1:${cdpPort}/json/list`, {
        signal: AbortSignal.timeout(800),
      }).then((response) => response.json());
      const target = targets.find((item) => (
        item.type === "page"
        && item.url === "app://-/index.html"
        && typeof item.webSocketDebuggerUrl === "string"
      ));
      if (target) return target;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  return null;
}

function openDedicatedWindow() {
  const result = spawnSync("/usr/bin/open", [
    "-n", "-a", appPath, "--args",
    `--user-data-dir=${profilePath}`,
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${cdpPort}`,
    `--remote-allow-origins=http://127.0.0.1:${cdpPort}`,
  ], { stdio: "inherit" });
  if (result.status !== 0) throw new Error("无法打开定制 Codex 窗口。");
}

async function activateAutoFix(target) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("无法连接定制 Codex renderer。")), { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const handler = pending.get(message.id);
    if (!handler) return;
    pending.delete(message.id);
    message.error ? handler.reject(new Error(message.error.message)) : handler.resolve(message.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  try {
    await send("Page.bringToFront");
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      const evaluation = await send("Runtime.evaluate", {
        expression: `(() => {
          const entry = document.getElementById("autofix-todo-companion-entry");
          if (!entry) return false;
          entry.click();
          return true;
        })()`,
        returnByValue: true,
      });
      if (evaluation.result?.value === true) return true;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return false;
  } finally {
    socket.close();
  }
}

async function main() {
  if (!Number.isInteger(cdpPort) || cdpPort < 1024 || cdpPort > 65535) {
    throw new Error("AUTOFIX_CODEX_CDP_PORT 必须是 1024-65535 的端口。");
  }
  await ensureServices();
  let target = await findCodexTarget(500);
  if (!target) {
    openDedicatedWindow();
    target = await findCodexTarget(20_000);
  }
  if (!target) {
    console.log("定制 Codex 窗口已启动；首次登录完成后会自动出现 Agent Forge 待办入口。");
    return;
  }
  const opened = await activateAutoFix(target);
  console.log(opened
    ? "定制 Codex 已打开，并已进入 Agent Forge 待办。"
    : "定制 Codex 已打开；页面加载完成后点击左侧“Agent Forge 待办”。");
}

main().catch((error) => {
  console.error(`Agent Forge：${error.message}`);
  process.exitCode = 1;
});
