import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { preferredEnvironmentValue } from "./environment.js";

export function resolveLaunchRuntimeEnv(repoRoot: string, environment: Record<string, string | undefined> = process.env): string | undefined {
  const explicit = preferredEnvironmentValue("AGENT_FORGE_RUNTIME_ENV", "_FORGE_RUNTIME_ENV", environment)?.trim();
  const candidates = explicit ? [path.resolve(repoRoot, explicit)] : [path.join(repoRoot, "data", "runtime.env"), path.resolve(repoRoot, "..", "lark-agent", "data", "runtime.env")];
  const selected = candidates.find(file => fs.existsSync(file) && fs.statSync(file).isFile());
  if (explicit && !selected) throw new Error("Configured runtime environment file is unavailable");
  return selected;
}

export function resolveLaunchAgentLabel(directory: string, repoRoot: string, override = process.env.AGENT_FORGE_LAUNCH_LABEL): string {
  if (override) {
    if (!/^[A-Za-z0-9][A-Za-z0-9.-]{0,199}$/.test(override)) throw new Error("Invalid launch agent label");
    return override;
  }
  if (process.platform === "darwin" && fs.existsSync(directory)) {
    for (const file of fs.readdirSync(directory).filter(file => file.endsWith(".plist")).slice(0, 200)) {
      try {
        const candidate = path.join(directory, file);
        if (fs.statSync(candidate).size > 64 * 1024) continue;
        const text = fs.readFileSync(candidate, "utf8");
        const encodedRoot = repoRoot.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
        if (!text.includes(encodedRoot) || !text.includes("start-local.mjs")) continue;
        const parsed = spawnSync("plutil", ["-convert", "json", "-o", "-", candidate], { encoding: "utf8", timeout: 2000, maxBuffer: 1024 * 1024 });
        if (parsed.status !== 0) continue;
        const plist = JSON.parse(parsed.stdout) as { Label?: string; WorkingDirectory?: string; ProgramArguments?: string[] };
        if (plist.WorkingDirectory === repoRoot && plist.ProgramArguments?.includes(path.join(repoRoot, "scripts", "start-local.mjs"))
          && typeof plist.Label === "string" && /^[A-Za-z0-9][A-Za-z0-9.-]{0,199}$/.test(plist.Label) && file === `${plist.Label}.plist`) return plist.Label;
      } catch { /* Unrelated or unreadable services are never modified. */ }
    }
  }
  return "dev.agent-forge.local";
}
