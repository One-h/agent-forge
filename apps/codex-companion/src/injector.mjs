#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const appPath = "/Applications/ChatGPT.app";
const cdpPort = Number(process.env.AUTOFIX_CODEX_CDP_PORT || 9237);
const profilePath = process.env.AUTOFIX_CODEX_PROFILE
  || "/private/tmp/autofix-codex-companion-profile";
// The static companion server provides CORS plus the API proxy required by the
// sandboxed frame. The normal Agent Forge dev server remains untouched on 4732.
const todoUrl = process.env.AUTOFIX_TODO_URL || "http://127.0.0.1:4734/todos";
const skipLaunch = process.env.AUTOFIX_CODEX_SKIP_LAUNCH === "1";
const oneShot = process.env.AUTOFIX_CODEX_ONESHOT === "1";
const companionPath = path.dirname(new URL(import.meta.url).pathname);
const embedAssetsPath = path.resolve(companionPath, "../dist/assets");
const embedCssPath = path.join(embedAssetsPath, "style.css");
const embedJsPath = path.join(embedAssetsPath, "embed-main.js");

if (!Number.isInteger(cdpPort) || cdpPort < 1024 || cdpPort > 65535) {
  throw new Error("AUTOFIX_CODEX_CDP_PORT 必须是 1024-65535 的端口。");
}

function injectionSource(url) {
  return String.raw`(() => {
  const key = "__autofixTodoCompanionV7";
  const entryId = "autofix-todo-companion-entry";
  const pageId = "autofix-todo-companion-page";
  const frameId = "autofix-todo-companion-frame";
  const styleId = "autofix-todo-companion-style";
  const todoUrl = ${JSON.stringify(url)};
  window.__autofixTodoCompanionV1?.destroy?.();
  window.__autofixTodoCompanionV2?.destroy?.();
  window.__autofixTodoCompanionV3?.destroy?.();
  window.__autofixTodoCompanionV4?.destroy?.();
  window.__autofixTodoCompanionV5?.destroy?.();
  window.__autofixTodoCompanionV6?.destroy?.();
  delete window.__autofixTodoCompanionV1;
  delete window.__autofixTodoCompanionV2;
  delete window.__autofixTodoCompanionV3;
  delete window.__autofixTodoCompanionV4;
  delete window.__autofixTodoCompanionV5;
  delete window.__autofixTodoCompanionV6;
  const prior = window[key];
  if (prior?.todoUrl === todoUrl) { prior.ensure(); return; }
  prior?.destroy?.();
  let observer;
  let active = false;

  function findReference() {
    const scroll = document.querySelector("[data-app-action-sidebar-scroll]");
    if (!scroll) return null;
    const buttons = [...scroll.querySelectorAll("button")];
    const plugin = buttons.find((button) => /^(插件|plugins)$/i.test(button.textContent.trim()));
    return plugin?.parentElement || buttons.at(-1)?.parentElement || null;
  }
  function ensureStyle() {
    if (document.getElementById(styleId)) return;
    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = "#"+pageId+"{position:absolute;inset:0;z-index:50;background:var(--bg-primary,#fff)}#"+frameId+"{width:100%;height:100%;border:0;background:transparent}";
    document.head.append(style);
  }
  function close() {
    active = false;
    const page = document.getElementById(pageId);
    if (page) page.hidden = true;
    document.getElementById(entryId)?.removeAttribute("aria-current");
  }
  function open() {
    const page = document.getElementById(pageId);
    if (!page) return;
    active = true;
    page.hidden = false;
    document.getElementById(entryId)?.setAttribute("aria-current", "page");
  }
  function onHostClick(event) {
    if (!active || !(event.target instanceof Node)) return;
    const entry = document.getElementById(entryId);
    const page = document.getElementById(pageId);
    if (entry?.contains(event.target) || page?.contains(event.target)) return;
    close();
  }
  function parseCodexThreadId(value) {
    if (typeof value !== "string") return null;
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== "codex:" || parsed.hostname !== "threads") return null;
      if (parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash) return null;
      const match = parsed.pathname.match(/^\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
      return match?.[1] || null;
    } catch {
      return null;
    }
  }
  function onFrameMessage(event) {
    const frame = document.getElementById(frameId);
    if (!frame || event.source !== frame.contentWindow) return;
    const data = event.data;
    if (!data || data.type !== "autofix:open-codex-thread") return;
    const threadId = parseCodexThreadId(data.url);
    if (!threadId) return;
    close();
    window.postMessage({ type: "navigate-to-route", path: "/local/" + threadId }, "*");
  }
  function ensure() {
    ensureStyle();
    const reference = findReference();
    if (!reference?.parentElement) return;
    let entry = document.getElementById(entryId);
    if (!entry) {
      entry = reference.cloneNode(true);
      entry.id = entryId;
      entry.removeAttribute("disabled");
      entry.removeAttribute("aria-expanded");
      entry.removeAttribute("aria-controls");
      entry.querySelectorAll("[id]").forEach((node) => node.removeAttribute("id"));
      const label = entry.querySelector(".text-fade-truncate") || entry.querySelector("span");
      if (label) label.textContent = "Agent Forge 待办";
      entry.setAttribute("aria-label", "打开 Agent Forge 待办");
      entry.addEventListener("click", (event) => { event.preventDefault(); event.stopPropagation(); open(); });
      reference.after(entry);
    }
    const host = document.querySelector(".app-shell-main-content-frame")
      || document.querySelector('[class*="MainContentFrame"]');
    if (!host) return;
    let page = document.getElementById(pageId);
    if (!page) {
      page = document.createElement("section");
      page.id = pageId;
      page.hidden = true;
      const frame = document.createElement("iframe");
      frame.id = frameId;
      frame.name = "autofix-todo-companion-frame-v1";
      frame.src = "about:blank";
    // Keep an opaque frame origin.  ChatGPT's app:// renderer otherwise treats
    // the document as an app-origin child and refuses its local module graph.
    frame.setAttribute("sandbox", "allow-scripts allow-forms allow-popups");
      frame.setAttribute("title", "Agent Forge 待办");
      page.append(frame);
      host.append(page);
    }
    if (active) open();
  }
  observer = new MutationObserver(ensure);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener("click", onHostClick, true);
  window.addEventListener("message", onFrameMessage);
  window[key] = { todoUrl, ensure, open, close, destroy() { observer?.disconnect(); document.removeEventListener("click", onHostClick, true); window.removeEventListener("message", onFrameMessage); document.getElementById(entryId)?.remove(); document.getElementById(pageId)?.remove(); document.getElementById(styleId)?.remove(); } };
  ensure();
})();`;
}

class CdpConnection {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 0;
    this.pending = new Map();
    this.closed = false;
    this.closedPromise = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", () => reject(new Error("无法连接 ChatGPT CDP。")), { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result);
    });
    this.socket.addEventListener("close", () => {
      this.closed = true;
      const error = new Error("ChatGPT CDP 连接已关闭。");
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      this.resolveClosed();
    }, { once: true });
  }
  async send(method, params = {}) {
    await this.ready;
    if (this.closed) throw new Error("ChatGPT CDP 连接已关闭。");
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP ${method} 超时。`)); }, 10_000);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  close() {
    if (!this.closed && this.socket.readyState < WebSocket.CLOSING) this.socket.close();
  }
}

let stopping = false;
let activeConnection = null;

async function delay(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForTarget(timeoutMs = 30_000) {
  const deadline = timeoutMs === null ? Number.POSITIVE_INFINITY : Date.now() + timeoutMs;
  while (!stopping && Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${cdpPort}/json/list`, { signal: AbortSignal.timeout(1_000) });
      const targets = await response.json();
      const page = targets.find((target) => (
        target.type === "page"
        && target.url === "app://-/index.html"
        && typeof target.webSocketDebuggerUrl === "string"
      ));
      if (page) return page;
    } catch {}
    await delay(250);
  }
  if (stopping) return null;
  throw new Error("等待独立 ChatGPT CDP 窗口超时。请完成该窗口登录后重试。");
}

function findFrameByName(frame, name) {
  if (frame.frame?.name === name) return frame.frame;
  for (const child of frame.childFrames || []) {
    const found = findFrameByName(child, name);
    if (found) return found;
  }
  return null;
}

function runtimeExceptionMessage(details) {
  return details?.exception?.description
    || details?.exception?.value
    || details?.text
    || "未知 JavaScript 异常";
}

async function loadTodoFrame(cdp) {
  const [css, js] = await Promise.all([readFile(embedCssPath, "utf8"), readFile(embedJsPath, "utf8")]);
  const html = `<!doctype html><html><head><base href=${JSON.stringify(`${new URL(todoUrl).origin}/`)}><style>${css}</style></head><body><div id="root"></div></body></html>`;
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const { frameTree } = await cdp.send("Page.getFrameTree");
    const frame = findFrameByName(frameTree, "autofix-todo-companion-frame-v1");
    if (frame) {
      await cdp.send("Page.setDocumentContent", { frameId: frame.id, html });
      const { executionContextId } = await cdp.send("Page.createIsolatedWorld", {
        frameId: frame.id,
        worldName: "autofix-todo-react",
        grantUniveralAccess: true,
      });
      const evaluation = await cdp.send("Runtime.evaluate", {
        contextId: executionContextId,
        expression: `(function () {\n${js}\n}).call(globalThis)`,
        awaitPromise: true,
      });
      if (evaluation.exceptionDetails) {
        throw new Error(`Agent Forge React bundle 执行失败：${runtimeExceptionMessage(evaluation.exceptionDetails)}`);
      }
      const mountDeadline = Date.now() + 5_000;
      while (Date.now() < mountDeadline) {
        const mounted = await cdp.send("Runtime.evaluate", {
          contextId: executionContextId,
          expression: "Boolean(document.getElementById('root')?.childElementCount)",
          returnByValue: true,
        });
        if (mounted.exceptionDetails) {
          throw new Error(`Agent Forge React 挂载检查失败：${runtimeExceptionMessage(mounted.exceptionDetails)}`);
        }
        if (mounted.result?.value === true) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error("Agent Forge React root 在 5 秒内未挂载。");
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("未找到 Agent Forge 待办 iframe。请在 ChatGPT 中重新点击菜单后重试。");
}

async function todoFrameMounted(cdp, frameId) {
  const { executionContextId } = await cdp.send("Page.createIsolatedWorld", {
    frameId,
    worldName: "autofix-todo-mount-watch",
  });
  const mounted = await cdp.send("Runtime.evaluate", {
    contextId: executionContextId,
    expression: "Boolean(document.getElementById('root')?.childElementCount)",
    returnByValue: true,
  });
  return !mounted.exceptionDetails && mounted.result?.value === true;
}

async function watchTodoFrame(cdp, source) {
  while (!stopping && !cdp.closed) {
    try {
      const { frameTree } = await cdp.send("Page.getFrameTree");
      const frame = findFrameByName(frameTree, "autofix-todo-companion-frame-v1");
      if (!frame) {
        await cdp.send("Runtime.evaluate", { expression: source, awaitPromise: true });
      } else if (!(await todoFrameMounted(cdp, frame.id))) {
        await loadTodoFrame(cdp);
        console.log("Agent Forge React 页面已自动恢复。");
      }
    } catch (error) {
      if (cdp.closed || stopping) break;
      console.error(`Agent Forge Companion 恢复检查失败：${error.message}`);
    }
    await Promise.race([delay(750), cdp.closedPromise]);
  }
}

async function attachAndInject(target) {
  const cdp = new CdpConnection(target.webSocketDebuggerUrl);
  activeConnection = cdp;
  try {
    await cdp.send("Page.enable");
    await cdp.send("Page.setBypassCSP", { enabled: true });
    const source = injectionSource(todoUrl);
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source });
    await cdp.send("Runtime.evaluate", { expression: source, awaitPromise: true });
    await loadTodoFrame(cdp);
    console.log(`Agent Forge Companion 已注入：${todoUrl}`);
    console.log(`独立 profile：${profilePath}`);
    if (!oneShot) {
      console.log("Agent Forge Companion 正在常驻监控 renderer 与 iframe 恢复。");
      await watchTodoFrame(cdp, source);
    }
  } finally {
    cdp.close();
    if (activeConnection === cdp) activeConnection = null;
  }
}

async function main() {
  await mkdir(profilePath, { recursive: true });
  if (!skipLaunch) {
    spawn("/usr/bin/open", ["-n", "-a", appPath, "--args",
      `--user-data-dir=${profilePath}`,
      "--remote-debugging-address=127.0.0.1",
      `--remote-debugging-port=${cdpPort}`,
      `--remote-allow-origins=http://127.0.0.1:${cdpPort}`,
    ], { detached: true, stdio: "ignore" }).unref();
  }
  do {
    const target = await waitForTarget(oneShot ? 30_000 : null);
    if (!target) break;
    try {
      await attachAndInject(target);
    } catch (error) {
      if (oneShot || stopping) throw error;
    console.error(`Agent Forge Companion 连接中断，等待重新连接：${error.message}`);
      await delay(750);
    }
  } while (!oneShot && !stopping);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    stopping = true;
    activeConnection?.close();
  });
}

main().catch((error) => {
  if (!stopping) {
  console.error(`Agent Forge Companion 失败：${error.message}`);
    process.exitCode = 1;
  }
});
