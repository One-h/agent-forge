import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(apiRoot, "..", "..");
const testDirectory = mkdtempSync(path.join(tmpdir(), "agent-forge-api-test-"));
const databasePath = path.join(testDirectory, "test.sqlite");
const testFiles = readdirSync(path.join(apiRoot, "src"), { recursive: true })
  .filter((file) => typeof file === "string" && file.endsWith(".test.ts"))
  .map((file) => path.join("src", file))
  .sort();

try {
  const result = spawnSync(process.execPath, [path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs"), "--test", ...testFiles], {
    cwd: apiRoot,
    env: {
      ...process.env,
      DATABASE_PATH: databasePath,
      GITEA_BASE_URL: "https://git.example",
      GITEA_REPOS: "acme/api",
      GITEA_TOKEN: "test",
      GITEA_USER: "codex",
      AGENT_FORGE_TEST_DATABASE: "1",
      AGENT_FORGE_TEST_ROOT: testDirectory,
      NODE_ENV: "test"
    },
    stdio: "inherit"
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(testDirectory, { recursive: true, force: true });
}
