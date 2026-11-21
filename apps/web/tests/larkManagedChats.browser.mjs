import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
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
const reportDir = await mkdtemp(path.join(tmpdir(), "forge-managed-chats-browser-"));
const output = await build({
  entryPoints: [path.join(webRoot, "src/main.tsx")], bundle: true, write: false, outfile: "fixture.js",
  jsx: "automatic", format: "esm", define: { "process.env.NODE_ENV": '"production"' }
});
const files = new Map(output.outputFiles.map(file => [`/${path.basename(file.path)}`, file.contents]));
const server = createServer((req, res) => {
  const route = new URL(req.url, "http://fixture.test").pathname;
  if (req.method !== "GET" || route.startsWith("/api/")) { res.writeHead(500).end("Unmocked request"); return; }
  if (route === "/lark-managed-chats") {
    res.setHeader("Content-Type", "text/html");
    res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script type="module" src="/fixture.js"></script></html>');
  } else if (files.has(route)) {
    res.setHeader("Content-Type", route.endsWith(".css") ? "text/css" : "application/javascript");
    res.end(files.get(route));
  } else res.writeHead(404).end();
});

const catalog = [{ id: "codex", label: "Codex", models: ["fixture-codex"] }, { id: "claude", label: "Claude Code", models: ["fixture-claude"] }];
const appLink = "https://applink.feishu.cn/client/chat/open?openChatId=";
const row = (input, fields) => ({ ...input, chatId: null, openUrl: null, createdAt: "2026-11-21T00:00:00.000Z",
  status: "creating", error: null, persona: input.persona ?? null, execution: input.execution ?? null, ...fields });
let browser;
try {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, ...(process.env.FORGE_QA_CHROMIUM ? { executablePath: process.env.FORGE_QA_CHROMIUM } : {}) });
  for (const width of [1360, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: "block" });
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    const errors = [], writes = [], items = [];
    const initialRead = Promise.withResolvers();
    const initialWrite = Promise.withResolvers();
    let reads = 0;
    page.on("pageerror", error => errors.push(error.message));
    await context.route("**/*", async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== origin) return route.abort();
      if (!url.pathname.startsWith("/api/")) return route.continue();
      if (url.pathname === "/api/settings" && request.method() === "GET") return route.fulfill({ json: { workspaceRoot: "Fixture" } });
      if (url.pathname !== "/api/lark/managed-chats") {
        errors.push(`Unmocked API: ${request.method()} ${url.pathname}`);
        return route.fulfill({ status: 500 });
      }
      if (request.method() === "GET") {
        if (++reads === 1) {
          await initialRead.promise;
          return route.fulfill({ status: 502, json: { code: "LARK_AGENT_UNAVAILABLE", message: "Fixture failure" } });
        }
        return route.fulfill({ json: { items, engines: catalog } });
      }
      const input = request.postDataJSON();
      writes.push(input);
      if (writes.length === 1) {
        await initialWrite.promise;
        return route.abort("timedout");
      }
      if (writes.length === 2) {
        const item = row(input, { chatId: "oc_default", status: "ready" });
        items.push(item);
        return route.fulfill({ json: { item } });
      }
      items.unshift(row(input, { chatId: "oc_custom", openUrl: `${appLink}oc_custom`, status: "attention", error: "请核对群设置" }),
        row({ requestId: "ef49fd2f-d9eb-4256-8522-ec76d2216ce1", name: "备用群" }, { openUrl: "https://untrusted.test" }));
      return route.abort("timedout");
    });

    await page.goto(`${origin}/lark-managed-chats`);
    await expect(page.getByRole("link", { name: "飞书群聊" })).toHaveAttribute("aria-current", "page");
    const composer = page.getByRole("region", { name: "新建私有群" });
    const history = page.getByRole("region", { name: "应用创建的群" });
    const refresh = history.getByRole("button", { name: "刷新群聊列表" });
    await expect(history.getByRole("status")).toContainText("正在读取");
    await expect(composer.getByRole("button", { name: "创建私有群" })).toBeDisabled();
    initialRead.resolve();
    await expect(history.getByRole("alert")).toContainText("未能读取飞书群聊");
    await refresh.click();
    await expect(history.getByText("暂无应用创建的群聊。")).toBeVisible();
    await composer.getByLabel("群名称").fill("默认测试群");
    await composer.getByRole("button", { name: "创建私有群" }).click();
    await expect(composer.getByRole("button", { name: "创建中…" })).toBeDisabled();
    initialWrite.resolve();
    await expect(composer.getByRole("alert")).toContainText("请重试原请求或刷新列表核对");
    await expect(composer.getByLabel("群名称")).toBeDisabled();
    await composer.getByRole("button", { name: "重试原请求" }).click();
    await expect(history.getByRole("link", { name: "在飞书打开 默认测试群" })).toHaveAttribute("href", `${appLink}oc_default`);
    assert.match(writes[0].requestId, /^[0-9a-f-]{36}$/);
    assert.deepEqual(writes[0], { requestId: writes[0].requestId, name: "默认测试群" });
    assert.deepEqual(writes[1], writes[0]);

    await composer.getByLabel("群名称").fill("自定义测试群");
    await composer.getByLabel("模型", { exact: true }).selectOption({ label: "fixture-claude" });
    await composer.getByRole("checkbox", { name: "自定义人设" }).check();
    await composer.getByLabel("人设名称").fill("审查员");
    await composer.getByLabel("人设指令").fill("复核指定内容。");
    await composer.getByRole("button", { name: "创建私有群" }).click();
    await expect(composer.getByRole("alert")).toContainText("未能确认建群结果");
    await refresh.click();
    await expect(history.getByRole("link", { name: "在飞书打开 自定义测试群" })).toHaveAttribute("href", `${appLink}oc_custom`);
    await expect(history.getByRole("link", { name: "在飞书打开 备用群" })).toHaveCount(0);
    await expect(history.getByText("待核对", { exact: true })).toBeVisible();
    await expect(history.getByText("创建中", { exact: true })).toBeVisible();
    await expect(history.getByText("Claude Code · fixture-claude", { exact: true })).toBeVisible();
    await expect(composer.getByRole("status")).toContainText("自定义测试群：待核对");
    assert.deepEqual(writes[2], { requestId: writes[2].requestId, name: "自定义测试群",
      persona: { mode: "custom", name: "审查员", instructions: "复核指定内容。" }, execution: { engineId: "claude", model: "fixture-claude" } });
    assert.notEqual(writes[2].requestId, writes[0].requestId);
    assert.equal(writes.length, 3);
    await composer.getByRole("checkbox", { name: "自定义人设" }).check();
    assert.equal(await page.locator(".managedChatsPage").evaluate(el => el.scrollWidth <= el.clientWidth + 1), true);
    await page.screenshot({ path: path.join(reportDir, `managed-chats-${width}.png`), fullPage: true });
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log(JSON.stringify({ browser: "passed", widths: [1360, 390], reportDir }));
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
