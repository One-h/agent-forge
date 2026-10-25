import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("todo workflow passes its isolated API and persistence fixture", () => {
  const testRoot = process.env.AGENT_FORGE_TEST_ROOT;
  assert.ok(testRoot, "AGENT_FORGE_TEST_ROOT must be provided by the API test runner");
  assert.equal(path.resolve(testRoot).startsWith(`${path.resolve(os.tmpdir())}${path.sep}`), true);
  const directory = fs.mkdtempSync(path.join(testRoot, "todo-workflow-"));
  const fixture = fileURLToPath(new URL("./testFixtures/todoWorkflow.fixture.ts", import.meta.url));
  try {
    const result = spawnSync("tsx", [fixture], {
      cwd: path.dirname(fileURLToPath(import.meta.url)),
      encoding: "utf8",
      env: {
        ...process.env,
        DATABASE_PATH: path.join(directory, "test.sqlite"),
        GITEA_BASE_URL: "https://git.example",
        GITEA_TOKEN: "test",
        GITEA_USER: "tester",
        GITEA_REPOS: "acme/example",
        LARK_CODEX_APPROVER_OPEN_ID: ""
      }
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
