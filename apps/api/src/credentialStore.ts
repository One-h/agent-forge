import { spawnSync } from "node:child_process";

const KEYCHAIN_SERVICE = "autofix-console";
const GITEA_TOKEN_ACCOUNT = "gitea-token";

function keychainCommand(args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync("security", args, { encoding: "utf8", timeout: 5_000 });
}

export function readGiteaTokenFromKeychain(): string | null {
  if (process.platform !== "darwin") {
    return null;
  }
  const result = keychainCommand(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", GITEA_TOKEN_ACCOUNT, "-w"]);
  const token = typeof result.stdout === "string" ? result.stdout.trim() : "";
  return result.status === 0 && token ? token : null;
}

export function giteaTokenKeychainAvailable(): boolean {
  return process.platform === "darwin";
}

export function saveGiteaTokenToKeychain(token: string): void {
  if (!giteaTokenKeychainAvailable()) {
    throw new Error("Gitea token storage currently requires the macOS Keychain");
  }
  const result = keychainCommand([
    "add-generic-password",
    "-U",
    "-s", KEYCHAIN_SERVICE,
    "-a", GITEA_TOKEN_ACCOUNT,
    "-w", token
  ]);
  if (result.status !== 0) {
    throw new Error("Unable to save the Gitea token to the macOS Keychain");
  }
}
