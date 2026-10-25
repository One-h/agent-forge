#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDirectory, "..");

export function parseRuntimeEnv(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

export function resolveLarkAgentEnvironment(baseEnvironment = process.env, root = repoRoot) {
  const environment = { ...baseEnvironment };
  const legacyPaths = [...new Set(Object.entries(environment).filter(([key, value]) => key.endsWith("_FORGE_RUNTIME_ENV") && value?.trim()).map(([, value]) => value.trim()))];
  if (environment.AGENT_FORGE_RUNTIME_ENV === undefined && legacyPaths.length > 1) throw new Error("Multiple runtime environment paths; configure AGENT_FORGE_RUNTIME_ENV explicitly");
  const explicitRuntimeEnv = (environment.AGENT_FORGE_RUNTIME_ENV ?? legacyPaths[0])?.trim();
  const candidates = explicitRuntimeEnv
    ? [path.resolve(root, explicitRuntimeEnv)]
    : [
        path.join(root, "data", "runtime.env"),
        path.resolve(root, "..", "lark-agent", "data", "runtime.env")
      ];
  const runtimeEnvPath = candidates.find((candidate) => fs.existsSync(candidate));

  if (explicitRuntimeEnv && !runtimeEnvPath) {
    throw new Error(`AGENT_FORGE_RUNTIME_ENV does not exist: ${candidates[0]}`);
  }
  if (!runtimeEnvPath) return environment;

  const runtimeEnvironment = parseRuntimeEnv(fs.readFileSync(runtimeEnvPath, "utf8"));
  environment.LARK_AGENT_URL ||= runtimeEnvironment.LARK_AGENT_URL || "http://127.0.0.1:4780";
  environment.LARK_AGENT_TOKEN ||= runtimeEnvironment.LARK_AGENT_TOKEN || runtimeEnvironment.LARK_AGENT_RUNTIME_TOKEN || "";
  if (runtimeEnvironment.LARK_AGENT_HOST_TOKEN) environment.LARK_AGENT_HOST_TOKEN ||= runtimeEnvironment.LARK_AGENT_HOST_TOKEN;
  return environment;
}

function main() {
  const commandArgs = process.argv.slice(2);
  if (commandArgs[0] === "--") commandArgs.shift();
  const [command, ...args] = commandArgs;
  if (!command) {
    console.error("Usage: node scripts/with-lark-agent-env.mjs -- <command> [...args]");
    process.exit(2);
  }

  let environment;
  try {
    environment = resolveLarkAgentEnvironment();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  const child = spawn(command, args, { cwd: repoRoot, env: environment, stdio: "inherit" });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => child.kill(signal));
  }
  child.on("error", (error) => {
    console.error(error.message);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
