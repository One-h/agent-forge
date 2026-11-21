import assert from "node:assert/strict";
import test from "node:test";
import { managedLarkChatLink } from "./managedLarkChatLink.ts";

const appLink = "https://applink.feishu.cn/client/chat/open?openChatId=";

test("normalizes the exact Feishu group AppLink or derives one from the row chat ID", () => {
  assert.equal(managedLarkChatLink(null, `${appLink}oc_a1&url=https://other.test#fragment`), `${appLink}oc_a1`);
  assert.equal(managedLarkChatLink("oc_a1", `${appLink}oc_a2`), `${appLink}oc_a1`);
  assert.equal(managedLarkChatLink("oc_a1", null), `${appLink}oc_a1`);
  assert.equal(managedLarkChatLink("oc_a1", "javascript:alert(1)"), `${appLink}oc_a1`);
});

test("never links arbitrary URLs or malformed identifiers", () => {
  for (const invalid of [
    "javascript:alert(1)", "http://applink.feishu.cn/client/chat/open?openChatId=oc_a1",
    "https://applink.feishu.cn.evil.test/client/chat/open?openChatId=oc_a1",
    "https://applink.feishu.cn@evil.test/client/chat/open?openChatId=oc_a1",
    "https://someone@applink.feishu.cn/client/chat/open?openChatId=oc_a1",
    "https://applink.feishu.cn/client/web_url/open?openChatId=oc_a1",
    `${appLink}oc_a1&openChatId=oc_a2`, `${appLink}ou_a1`, `${appLink}oc_1%2Fa`, `${appLink}oc_a1%0A`
  ]) assert.equal(managedLarkChatLink(null, invalid), null, invalid);
  assert.equal(managedLarkChatLink("oc_/../x", null), null);
});
