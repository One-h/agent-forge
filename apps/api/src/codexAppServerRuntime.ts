import { CodexAppServerClient } from "./codexAppServer.js";
import { config } from "./config.js";

// All local Agent Forge Codex workflows share one App Server and the user's
// default CODEX_HOME, so their threads stay visible in the desktop app.
export const codexAppServer = new CodexAppServerClient(() => config.workspaceRoot || process.cwd());

const activeTurnIds = new Set<string>();

export function registerCodexAppServerTurn(turnId: string): void {
  activeTurnIds.add(turnId);
}

export function unregisterCodexAppServerTurn(turnId: string): void {
  activeTurnIds.delete(turnId);
}

export function codexAppServerActiveTurnCount(): number {
  return activeTurnIds.size;
}

export function isCodexAppServerTurnRegistered(turnId: string): boolean {
  return activeTurnIds.has(turnId);
}
