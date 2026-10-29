import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { api } from "../api.ts";

registerHooks({
  resolve(specifier, context, nextResolve) {
    const aliases = { "../api": new URL("../api.ts", import.meta.url).href, "../components/OwnerMentionAssists": new URL("./OwnerMentionAssists.tsx", import.meta.url).href };
    return nextResolve(aliases[specifier] ?? specifier, context);
  },
  load(url, context, nextLoad) {
  if (url === new URL("../pages/personalInbox.css", import.meta.url).href) return { format: "module", source: "", shortCircuit: true };
  if (["./OwnerMentionAssists.tsx", "../pages/PersonalInbox.tsx"].some(file => url === new URL(file, import.meta.url).href)) {
    const { outputText } = ts.transpileModule(readFileSync(new URL(url), "utf8"), {
      compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
    });
    return { format: "module", source: outputText, shortCircuit: true };
  }
  return nextLoad(url, context);
} });
const { OwnerMentionAssistMessage } = await import("./OwnerMentionAssists.tsx");
const { PersonalInboxPage } = await import("../pages/PersonalInbox.tsx");
const item = {
  id: 7, lark_message_id: 7, owner_id: "ou_owner", decision: "owner_required", status: "needs_owner",
  reason: "Need confirmation", question: "Confirm reply?", draft: "Proposed reply", version: 3,
  content: "Original request", chat_id: "oc_group", chat_type: "group", sender_id: "ou_requester",
  message_id: "om_original", thread_id: null, enabled: true,
  ownerResponses: [{ id: 8, message_id: "om_reply", content: "Owner response", message_at: "2026-01-01T00:00:00Z", reply_to_message_id: "om_original" }]
};
const render = value => renderToStaticMarkup(createElement(OwnerMentionAssistMessage, { item: value, onRefresh: async () => {} }));

test("assist API stays separate from personal inbox, sends only contract fields and exposes version conflicts", async () => {
  const fetch = globalThis.fetch, calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body) : undefined });
    return new Response(JSON.stringify(init?.method === "POST" ? { item } : { items: [item] }));
  };
  try {
    assert.deepEqual(await api.ownerMentionAssists(), { items: [item] });
    await api.decideOwnerMentionAssist(7, { action: "send", text: "Edited reply", version: 3, requesterId: "ou_other" });
    await api.decideOwnerMentionAssist(7, { action: "dismiss", version: 3 });
    await api.updateLarkOwnerMentionAssist("oc_group", "on");
    assert.deepEqual(calls, [
      { url: "/api/owner-mention-assists", method: "GET", body: undefined },
      { url: "/api/owner-mention-assists/7/decision", method: "POST", body: { action: "send", text: "Edited reply", version: 3 } },
      { url: "/api/owner-mention-assists/7/decision", method: "POST", body: { action: "dismiss", version: 3 } },
      { url: "/api/lark/chats/oc_group/settings", method: "PATCH", body: { ownerMentionAssistMode: "on" } }
    ]);
    globalThis.fetch = async () => new Response(JSON.stringify({ error: "version changed" }), { status: 409 });
    await assert.rejects(api.decideOwnerMentionAssist(7, { action: "send", version: 2 }), error => error.statusCode === 409);
  } finally { globalThis.fetch = fetch; }
});

test("assist display includes original request, owner replies, reason and editable bot draft", () => {
  const html = render(item);
  for (const text of ["Original request", "本人群内回复", "Owner response", "Need confirmation", "Confirm reply?", "Proposed reply", "确认机器人发送", "忽略"]) assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /以我身份|以本人身份/);
  for (const status of ["pending", "handling", "reconsidering", "ready", "ignored", "sent", "dismissed"]) assert.doesNotMatch(render({ ...item, status }), /确认机器人发送|<textarea/);
  assert.doesNotMatch(render({ ...item, enabled: false }), /确认机器人发送|<textarea/);
  assert.match(render({ ...item, status: "needs_owner" }), /确认机器人发送/);
  assert.doesNotMatch(render({ ...item, content: '<script>alert("x")</script>' }), /<script>/);
});

test("ready is already confirmed and an active native turn cannot be reviewed", () => {
  assert.match(render({ ...item, status: "ready" }), /已确认待投递/);
  assert.doesNotMatch(render({ ...item, status: "ready" }), /待确认发送|确认机器人发送|>忽略</);
  const locked = render({ ...item, enabled: false });
  assert.match(locked, /此记录当前不可审核或发送/);
  assert.doesNotMatch(locked, /<textarea|确认机器人发送|>忽略</);
});

test("personal inbox keeps the assist section independent even before the old snapshot loads", () => {
  const html = renderToStaticMarkup(createElement(PersonalInboxPage));
  assert.match(html, /个人收件箱/); assert.match(html, /群聊协同待确认/); assert.match(html, /正在加载群聊协同/);
});
