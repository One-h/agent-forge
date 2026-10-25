import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveLaunchAgentLabel, resolveLaunchRuntimeEnv } from "./launchAgentIdentity.js";

test("launch identity defaults are generic and configuration cannot inject a path", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "forge-launch-label-"));
  try {
    assert.equal(resolveLaunchAgentLabel(root, "/example/workspace", ""), "dev.agent-forge.local");
    assert.equal(resolveLaunchAgentLabel(root, "/example/workspace", "custom.forge.service"), "custom.forge.service");
    assert.throws(() => resolveLaunchAgentLabel(root, "/example/workspace", "../other-service"));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("persistent startup retains a custom legacy runtime env path and otherwise discovers the local file", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "forge-launch-env-"));
  try {
    const custom = path.join(root, "custom.env"); fs.writeFileSync(custom, "LARK_AGENT_TOKEN=fixture\n");
    assert.equal(resolveLaunchRuntimeEnv(root, { PREVIOUS_FORGE_RUNTIME_ENV: custom }), custom);
    assert.throws(() => resolveLaunchRuntimeEnv(root, { AGENT_FORGE_RUNTIME_ENV: path.join(root, "missing.env") }));
    fs.mkdirSync(path.join(root, "data")); const local = path.join(root, "data", "runtime.env"); fs.writeFileSync(local, "");
    assert.equal(resolveLaunchRuntimeEnv(root, {}), local);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("an existing installation for this checkout is reused without hard-coded private labels", { skip: process.platform !== "darwin" }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "forge-existing-launch-"));
  try {
    const repoRoot = path.join(root, "workspace");
    fs.writeFileSync(path.join(root, "previous.service.plist"), `<?xml version="1.0"?><plist version="1.0"><dict><key>Label</key><string>previous.service</string><key>WorkingDirectory</key><string>${repoRoot}</string><key>ProgramArguments</key><array><string>node</string><string>${repoRoot}/scripts/start-local.mjs</string></array></dict></plist>`);
    assert.equal(resolveLaunchAgentLabel(root, repoRoot, ""), "previous.service");
    assert.equal(resolveLaunchAgentLabel(root, path.join(root, "another"), ""), "dev.agent-forge.local");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
