import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const browserRequire = process.env.FORGE_QA_NODE_MODULES
  ? createRequire(path.join(process.env.FORGE_QA_NODE_MODULES, "forge-qa.cjs")) : require;
const { chromium } = browserRequire("playwright");
const { expect } = browserRequire("playwright/test");
const { build } = require("esbuild");
const webRoot = fileURLToPath(new URL("../", import.meta.url));
const reportDir = await mkdtemp(path.join(tmpdir(), "forge-topic-execution-browser-"));
const output = await build({
  stdin: { contents: `
    import { createRoot } from "react-dom/client";
    import { BrowserRouter } from "react-router-dom";
    import { LarkMessageDetailDrawer } from "./src/pages/LarkMessageDetail";
    import "./src/styles.css";
    const id = Number(new URLSearchParams(location.search).get("message") ?? 7);
    createRoot(document.getElementById("root")).render(<BrowserRouter><main className="workspace"><LarkMessageDetailDrawer messageId={id} onClose={() => {}} /></main></BrowserRouter>);
  `, resolveDir: webRoot, loader: "tsx" },
  bundle: true, write: false, outfile: "fixture.js", jsx: "automatic", format: "esm",
  define: { "process.env.NODE_ENV": '"production"' }
});
const files = new Map(output.outputFiles.map(file => [`/${path.basename(file.path)}`, file.contents]));
const server = createServer((req, res) => {
  const route = new URL(req.url, "http://fixture.test").pathname;
  if (req.method !== "GET" || route.startsWith("/api/")) { res.writeHead(500).end("Unmocked request"); return; }
  if (route === "/") {
    res.setHeader("Content-Type", "text/html");
    res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script type="module" src="/fixture.js"></script></html>');
  } else if (files.has(route)) {
    res.setHeader("Content-Type", route.endsWith(".css") ? "text/css" : "application/javascript");
    res.end(files.get(route));
  } else res.writeHead(404).end();
});

let browser;
try {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, ...(process.env.FORGE_QA_CHROMIUM ? { executablePath: process.env.FORGE_QA_CHROMIUM } : {}) });
  for (const width of [1360, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: "block" });
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    const errors = [], writes = [];
    page.on("pageerror", error => errors.push(error.message));
    let override = null, busy = false, registered = false;
    await context.route("**/*", async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== origin) return route.abort();
      if (!url.pathname.startsWith("/api/")) return route.continue();
      if (/^\/api\/lark\/messages\/[78]$/.test(url.pathname)) {
        const isTopic = url.pathname.endsWith("/7");
        return route.fulfill({ json: { id: isTopic ? 7 : 8, direction: "inbound", chat_type: isTopic ? "group" : "p2p",
          chat_id: isTopic ? "oc_fixture" : "ou_fixture", thread_id: isTopic ? "omt_fixture" : null,
          content: "Fixture message", codex_status: "answered", reply_status: "sent", received_at: "2026-01-01T00:00:00Z" } });
      }
      if (url.pathname === "/api/lark/chats/oc_fixture/topics/omt_fixture/execution") {
        if (request.method() === "PUT") {
          writes.push(request.postDataJSON());
          if (busy) return route.fulfill({ status: 409, json: { message: "话题仍有排队或运行任务，或所选引擎、模型已不可用。请刷新后重试。" } });
          override = writes.at(-1).override;
        }
        return route.fulfill({ json: { override, effective: override ?? { engineId: "codex", model: "fixture-codex" },
          available: true, engines: registered ? [{ id: "claude", label: "Claude Code", models: ["fixture-claude"] }] : [] } });
      }
      errors.push(`Unmocked path: ${url.pathname}`);
      return route.fulfill({ status: 500, body: "Unmocked API" });
    });
    await page.goto(origin);
    await page.getByRole("button", { name: "话题设置" }).click();
    const section = page.getByRole("region", { name: "话题执行设置" });
    await expect(section.getByText("Lark Agent 尚未注册外部引擎。")).toBeVisible();
    await expect(section.getByRole("button", { name: "保存话题设置" })).toBeDisabled();
    registered = true;
    const refresh = async () => {
      const readback = page.waitForResponse(response => response.request().method() === "GET" && response.url().endsWith("/omt_fixture/execution"));
      await section.getByRole("button", { name: "刷新话题设置" }).click();
      assert.equal((await readback).status(), 200);
    };
    await refresh();
    await section.getByLabel("执行引擎").selectOption("claude");
    await section.getByLabel("模型", { exact: true }).selectOption("fixture-claude");
    busy = true;
    await section.getByRole("button", { name: "保存话题设置" }).click();
    await expect(section.getByRole("alert")).toContainText("话题仍有排队或运行任务");
    await expect(section.getByText("Codex · fixture-codex")).toBeVisible();
    busy = false;
    await section.getByRole("button", { name: "保存话题设置" }).click();
    await expect(section.getByText("Claude Code · fixture-claude")).toBeVisible();
    assert.deepEqual(writes.at(-1), { override: { engineId: "claude", model: "fixture-claude" } });
    await page.screenshot({ path: path.join(reportDir, `topic-execution-${width}.png`) });
    assert.equal(await section.evaluate(el => el.scrollWidth <= el.clientWidth + 1), true);
    await refresh();
    await expect(section.getByLabel("模型", { exact: true })).toHaveValue("fixture-claude");
    await section.getByLabel("执行引擎").selectOption({ label: "继承群聊 · Codex" });
    await expect(section.getByLabel("执行引擎")).toHaveValue("");
    await section.getByRole("button", { name: "保存话题设置" }).click();
    await expect(section.getByText("Codex · fixture-codex")).toBeVisible();
    assert.deepEqual(writes.at(-1), { override: null });
    await page.goto(`${origin}/?message=8`);
    await expect(page.getByText("消息 #8", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "话题设置" })).toHaveCount(0);
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log(JSON.stringify({ browser: "passed", widths: [1360, 390], reportDir }));
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
