import assert from "node:assert/strict";
import test from "node:test";
import { api } from "../api.ts";

test("persona save and preview send writable fields only after loading a versioned persona", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), method: init.method, body: JSON.parse(init.body) });
    return new Response("{}");
  };
  try {
    const saved = { mode: "custom", name: "角色", instructions: "表达风格", version: 7, updatedAt: "2026-10-22T10:00:00Z" };
    await api.saveLarkPersona("oc_test", saved);
    await api.previewLarkPersona("oc_test", saved);
    assert.deepEqual(requests.map(item => item.body), [
      { mode: "custom", name: "角色", instructions: "表达风格" },
      { mode: "custom", name: "角色", instructions: "表达风格" }
    ]);
  } finally { globalThis.fetch = originalFetch; }
});
