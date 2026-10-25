import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

const DISCOVERY_CACHE_TTL_MS = 120_000;
const DISCOVERY_CONCURRENCY = 8;

export type LocalRepository = {
  name: string;
  path: string;
  remote: string;
  repo: string | null;
};

type DiscoveryCache = {
  key: string;
  expiresAt: number;
  repositories: LocalRepository[];
};

let discoveryCache: DiscoveryCache | null = null;

function remoteRepo(remote: string): string | null {
  const normalized = remote.trim().replace(/\.git$/, "");
  const pathPart = normalized.includes(":") && !normalized.includes("://")
    ? normalized.slice(normalized.indexOf(":") + 1)
    : normalized.replace(/^https?:\/\/[^/]+\//, "");
  const parts = pathPart.split("/").filter(Boolean);
  return parts.length < 2 ? null : `${parts.at(-2)!}/${parts.at(-1)!}`;
}

export function remoteMatchesConfiguredGitea(remote: string): boolean {
  if (config.giteaBaseUrls.length === 0) return true;
  const scpHost = remote.match(/^[^@\s]+@([^:/\s]+):/)?.[1];
  let remoteHost = scpHost ?? "";
  if (!remoteHost) {
    try {
      remoteHost = new URL(remote).host;
    } catch {
      return false;
    }
  }
  return config.giteaBaseUrls.some((baseUrl) => {
    try {
      return new URL(baseUrl).host === remoteHost;
    } catch {
      return false;
    }
  });
}

function gitConfigPath(repoPath: string): string | null {
  const dotGit = path.join(repoPath, ".git");
  try {
    const stat = fs.statSync(dotGit);
    if (stat.isDirectory()) return path.join(dotGit, "config");
    const pointer = fs.readFileSync(dotGit, "utf8").match(/^gitdir:\s*(.+)\s*$/m)?.[1];
    return pointer ? path.resolve(repoPath, pointer, "config") : null;
  } catch {
    return null;
  }
}

function originRemote(repoPath: string): string | null {
  const configPath = gitConfigPath(repoPath);
  if (!configPath) return null;
  try {
    const configText = fs.readFileSync(configPath, "utf8");
    const section = configText.match(/^\[remote "origin"\]([\s\S]*?)(?=^\[|(?![\s\S]))/m)?.[1];
    return section?.match(/^\s*url\s*=\s*(.+?)\s*$/m)?.[1] ?? null;
  } catch {
    return null;
  }
}

async function mapConcurrent<T, R>(items: T[], limit: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await mapper(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function repositoryCandidates(): Array<{ name: string; path: string }> {
  const roots = [config.workspaceRoot, path.join(config.workspaceRoot, "runtimes")]
    .filter((root, index, values) => Boolean(root) && values.indexOf(root) === index && fs.existsSync(root));
  const candidates: Array<{ name: string; path: string }> = [];
  for (const root of roots) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === "worktrees") continue;
      const repoPath = path.join(root, entry.name);
      if (!fs.existsSync(path.join(repoPath, ".git"))) continue;
      candidates.push({ name: entry.name, path: repoPath });
    }
  }
  return candidates;
}

export async function discoverLocalRepositories(options: { refresh?: boolean } = {}): Promise<LocalRepository[]> {
  const key = `${config.workspaceRoot}\u0000${config.giteaBaseUrls.join("\u0000")}`;
  if (!options.refresh && discoveryCache?.key === key && discoveryCache.expiresAt > Date.now()) {
    return discoveryCache.repositories;
  }
  const discovered = await mapConcurrent(repositoryCandidates(), DISCOVERY_CONCURRENCY, async (candidate) => {
    const remote = originRemote(candidate.path);
    if (!remote) return null;
    return {
      name: candidate.name,
      path: candidate.path,
      remote,
      repo: remoteMatchesConfiguredGitea(remote) ? remoteRepo(remote) : null
    } satisfies LocalRepository;
  });
  const repositories = discovered.filter((repository): repository is LocalRepository => repository !== null)
    .sort((left, right) => left.name.localeCompare(right.name));
  discoveryCache = { key, expiresAt: Date.now() + DISCOVERY_CACHE_TTL_MS, repositories };
  return repositories;
}
