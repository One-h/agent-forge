import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

// Node 24 strips TS but not JSX. Keep this loader local to the display test.
registerHooks({
  load(url, context, nextLoad) {
    if (url === new URL("./larkExecutionConfigs.css", import.meta.url).href) {
      return { format: "module", source: "", shortCircuit: true };
    }
    if (url === new URL("./LarkExecutionConfigs.tsx", import.meta.url).href) {
      const { outputText } = ts.transpileModule(readFileSync(new URL(url), "utf8"), {
        compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      });
      return { format: "module", source: outputText, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const { executionValue, executionRounds, LarkExecutionConfigs } = await import("./LarkExecutionConfigs.tsx");
const snapshot = {
  schemaVersion: 1,
  recordedAt: "2026-10-22T01:00:00Z",
  threadId: "thread-1",
  turnId: "turn-1",
  action: "turn/start",
  model: "gpt-5-test",
  reasoningEffort: "high",
  approvalPolicy: "on-request",
  sandbox: "workspace-write",
  workspaceRoot: "/workspace/project",
  trustScope: "trusted",
  persona: { mode: "custom", name: "工程师", version: 7, updatedAt: null },
  globalPromptHash: "abcdef0123456789abcdef0123456789",
  source: "accepted-request",
};
const render = (configs) => renderToStaticMarkup(createElement(LarkExecutionConfigs, { configs }));

test("historical messages explicitly show missing records", () => {
  assert.match(render(), /暂无本轮配置记录/);
  assert.match(render([]), /暂无本轮配置记录/);
  assert.doesNotMatch(render(), /已接受参数|gpt-|默认/);
});

test("displays accepted per-turn parameters and shortened hash with full tooltip", () => {
  const html = render([snapshot]);
  for (const text of ["本轮执行配置", "已接受参数", "gpt-5-test", "思考等级", "高", "按需审批", "工作区可写", "可信", "/workspace/project", "工程师 · v7 · 自定义", "thread-1", "turn-1"]) {
    assert.ok(html.includes(text), text);
  }
  assert.ok(html.includes(`title="${snapshot.globalPromptHash}">abcdef012345…`));
  assert.doesNotMatch(html, /服务端已验证模型|服务内部推理/);
});

test("steer stays within its turn while retries and other sessions remain separate", () => {
  const steer = { ...snapshot, action: "turn/steer" };
  const retry = { ...snapshot, turnId: "turn-2", model: "retry-model" };
  const otherThread = { ...snapshot, threadId: "thread-2" };
  const configs = [snapshot, steer, retry, otherThread];
  const before = structuredClone(configs);
  const rounds = executionRounds(configs);
  assert.deepEqual(rounds.map((round) => round.records.length), [2, 1, 1]);
  const html = render(configs);
  assert.equal((html.match(/<h4>轮次 /g) ?? []).length, 3);
  assert.match(html, /轮内补充/);
  assert.match(html, /retry-model/);
  assert.deepEqual(configs, before);
  assert.equal(executionRounds([{ ...snapshot, turnId: "" }, { ...snapshot, turnId: "" }]).length, 2);
});

test("missing or malformed fields remain unknown without inferring defaults", () => {
  for (const value of [undefined, null, "", "  ", {}, 0, false]) assert.equal(executionValue(value), "未知");
  assert.equal(executionValue("new-model"), "new-model");
  const html = render([{
    ...snapshot, model: null, reasoningEffort: null, approvalPolicy: null, sandbox: null,
    workspaceRoot: null, trustScope: null, persona: null, globalPromptHash: "", recordedAt: "bad-date",
  }]);
  assert.ok((html.match(/未知/g) ?? []).length >= 10);
  assert.doesNotMatch(html, /gpt-|workspace-write|on-request|默认|Invalid Date|v0/);
  assert.match(render([{ ...snapshot, persona: { name: "旧人设", version: NaN } }]), /旧人设 · 版本未知 · 未知/);
  assert.match(render([{ ...snapshot, source: undefined }]), /来源未知/);
  assert.doesNotMatch(render([{ ...snapshot, source: undefined }]), /已接受参数/);
});

test("untrusted names, model, paths, IDs and hash render as text, never markup", () => {
  const payload = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
  const html = render([{
    ...snapshot, model: payload, threadId: payload, turnId: payload,
    approvalPolicy: payload, sandbox: payload, reasoningEffort: payload, workspaceRoot: payload,
    persona: { ...snapshot.persona, name: payload }, globalPromptHash: payload,
  }]);
  assert.doesNotMatch(html, /<img|<script|title="<|<\/script>/);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
});
