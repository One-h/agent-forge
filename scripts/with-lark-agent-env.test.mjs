import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseRuntimeEnv, resolveLarkAgentEnvironment } from "./with-lark-agent-env.mjs";

test("parseRuntimeEnv accepts exported quoted values", () => {
  assert.deepEqual(parseRuntimeEnv("export LARK_AGENT_TOKEN='secret'\nLARK_AGENT_URL=\"http://127.0.0.1:4780\"\n"), {
    LARK_AGENT_TOKEN: "secret",
    LARK_AGENT_URL: "http://127.0.0.1:4780"
  });
});

test("resolveLarkAgentEnvironment discovers sibling runtime without overriding explicit values", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agent-forge-runtime-env-"));
  const forgeRoot = path.join(workspace, "agent-forge");
  const runtimeDirectory = path.join(workspace, "lark-agent", "data");
  fs.mkdirSync(forgeRoot, { recursive: true });
  fs.mkdirSync(runtimeDirectory, { recursive: true });
  fs.writeFileSync(path.join(runtimeDirectory, "runtime.env"), "export LARK_AGENT_RUNTIME_TOKEN='runtime-secret'\nexport LARK_AGENT_HOST_TOKEN='host-secret'\n");
  try {
    assert.deepEqual(resolveLarkAgentEnvironment({}, forgeRoot), {
      LARK_AGENT_URL: "http://127.0.0.1:4780",
      LARK_AGENT_TOKEN: "runtime-secret",
      LARK_AGENT_HOST_TOKEN: "host-secret"
    });
    assert.deepEqual(resolveLarkAgentEnvironment({ LARK_AGENT_URL: "http://127.0.0.1:9999", LARK_AGENT_TOKEN: "explicit", LARK_AGENT_HOST_TOKEN: "explicit-host" }, forgeRoot), {
      LARK_AGENT_URL: "http://127.0.0.1:9999",
      LARK_AGENT_TOKEN: "explicit",
      LARK_AGENT_HOST_TOKEN: "explicit-host"
    });
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("resolveLarkAgentEnvironment leaves optional integration disabled when no runtime exists", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agent-forge-no-lark-agent-"));
  const forgeRoot = path.join(workspace, "agent-forge");
  fs.mkdirSync(forgeRoot, { recursive: true });
  try {
    assert.deepEqual(resolveLarkAgentEnvironment({ KEEP_ME: "yes" }, forgeRoot), { KEEP_ME: "yes" });
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("legacy custom runtime environment paths retain integration and ambiguous paths fail closed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "forge-legacy-runtime-env-"));
  try {
    const file = path.join(root, "operator.env");
    fs.writeFileSync(file, "LARK_AGENT_RUNTIME_TOKEN=fixture-runtime\nLARK_AGENT_HOST_TOKEN=fixture-host\n");
    const loaded = resolveLarkAgentEnvironment({ PREVIOUS_FORGE_RUNTIME_ENV: file }, root);
    assert.equal(loaded.LARK_AGENT_TOKEN, "fixture-runtime"); assert.equal(loaded.LARK_AGENT_HOST_TOKEN, "fixture-host");
    assert.throws(() => resolveLarkAgentEnvironment({ FIRST_FORGE_RUNTIME_ENV: file, SECOND_FORGE_RUNTIME_ENV: path.join(root, "another") }, root));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
