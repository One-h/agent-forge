import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveLarkAgentEnvironment } from "./with-lark-agent-env.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const apiEntry = path.join(root, "apps", "api", "dist", "index.js");
const viteEntry = path.join(root, "node_modules", "vite", "bin", "vite.js");
const companionServerEntry = path.join(root, "apps", "codex-companion", "src", "server.mjs");
const companionInjectorEntry = path.join(root, "apps", "codex-companion", "src", "injector.mjs");
const companionBundle = path.join(root, "apps", "codex-companion", "dist", "assets", "embed-main.js");
const host = process.env.HOST ?? "127.0.0.1";
const webPort = process.env.WEB_PORT ?? "4732";

if (
  !fs.existsSync(apiEntry)
  || !fs.existsSync(viteEntry)
  || !fs.existsSync(path.join(root, "apps", "web", "dist", "index.html"))
  || !fs.existsSync(companionServerEntry)
  || !fs.existsSync(companionInjectorEntry)
  || !fs.existsSync(companionBundle)
) {
  console.error("Missing production build. Run npm run build before starting Agent Forge.");
  process.exit(1);
}

const environment = resolveLarkAgentEnvironment();
const children = [
  spawn(process.execPath, [apiEntry], { cwd: root, env: environment, stdio: "inherit" }),
  spawn(process.execPath, [viteEntry, "preview", "--host", host, "--port", webPort, "--strictPort"], {
    cwd: path.join(root, "apps", "web"),
    env: environment,
    stdio: "inherit"
  }),
  spawn(process.execPath, [companionServerEntry], { cwd: root, env: environment, stdio: "inherit" }),
  spawn(process.execPath, [companionInjectorEntry], {
    cwd: root,
    env: { ...environment, AUTOFIX_CODEX_SKIP_LAUNCH: environment.AUTOFIX_CODEX_SKIP_LAUNCH ?? "1" },
    stdio: "inherit"
  })
];

let stopping = false;
const stop = (code = 0) => {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => process.exit(code), 1_000).unref();
};

process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
for (const child of children) {
  child.on("exit", (code) => stop(code ?? 1));
}
