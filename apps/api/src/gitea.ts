import { config } from "./config.js";
import { addNotification, appSettingValue, db, getAppSettings, type IssueRow } from "./db.js";
import { createReviewOnlyJobForPull } from "./repairJobs.js";
import { nowIso } from "./time.js";

type GiteaIssue = {
  id?: number;
  number: number;
  title: string;
  body?: string;
  html_url?: string;
  state?: string;
  pull_request?: unknown;
  assignee?: { login?: string } | null;
  assignees?: Array<{ login?: string }>;
  user?: { login?: string } | null;
  labels?: Array<{ name?: string }>;
  repository?: {
    full_name?: string;
    name?: string;
    owner?: { login?: string } | null;
  };
  head?: { sha?: string; ref?: string } | null;
  head_sha?: string;
  headSha?: string;
  head_commit_id?: string;
  requested_reviewers?: Array<{ login?: string }>;
  reviewers?: Array<{ login?: string }>;
};

type GiteaPull = {
  id?: number;
  number: number;
  title: string;
  body?: string;
  html_url?: string;
  state?: string;
  head?: { sha?: string; ref?: string } | null;
  head_sha?: string;
  headSha?: string;
  head_commit_id?: string;
  user?: { login?: string } | null;
  assignee?: { login?: string } | null;
  assignees?: Array<{ login?: string }>;
  requested_reviewers?: Array<{ login?: string }>;
  reviewers?: Array<{ login?: string }>;
  labels?: Array<{ name?: string }>;
};

type GiteaComment = {
  id: number;
  issue_url?: string;
  html_url?: string;
  body?: string;
  user?: { login?: string } | null;
  updated_at?: string;
  created_at?: string;
};

type Repo = { owner: string; name: string };

type RepoFetchData = {
  repo: Repo;
  issues: GiteaIssue[];
  pulls: GiteaPull[];
  comments: GiteaComment[];
};

type SyncMode = "full" | "search";

const REPO_SYNC_CONCURRENCY = Number(process.env.GITEA_SYNC_REPO_CONCURRENCY ?? 2);
const PULL_DETAIL_CONCURRENCY = Number(process.env.GITEA_SYNC_PULL_DETAIL_CONCURRENCY ?? 4);
const GITEA_FETCH_RETRIES = Number(process.env.GITEA_FETCH_RETRIES ?? 3);
const GITEA_FETCH_RETRY_DELAY_MS = Number(process.env.GITEA_FETCH_RETRY_DELAY_MS ?? 300);
const GITEA_SEARCH_MAX_PAGES = Number(process.env.GITEA_SEARCH_MAX_PAGES ?? 10);
const SEARCH_SYNC_LOOKBACK_BUFFER_MS = 60_000;
const GITEA_SYNC_FULL_AT_KEY = "giteaFullSyncAt";
const GITEA_SYNC_SEARCH_AT_KEY = "giteaSearchSyncAt";
const GITEA_REPOS_SETTING_KEY = "giteaRepos";

function configuredGiteaRepos(): Repo[] {
  const stored = appSettingValue(GITEA_REPOS_SETTING_KEY);
  if (stored === null) {
    return config.giteaRepos;
  }
  try {
    const parsed = JSON.parse(stored) as unknown;
    return Array.isArray(parsed)
      ? parsed.flatMap((value) => {
        if (typeof value !== "string") return [];
        const [owner, name] = value.split("/", 2);
        return owner && name ? [{ owner, name }] : [];
      })
      : [];
  } catch {
    return config.giteaRepos;
  }
}

export function giteaSyncConfigStatus(): {
  configured: boolean;
  missing: string[];
  repoCount: number;
  repos: string[];
  userFilter: string | null;
} {
  const repos = configuredGiteaRepos();
  const missing: string[] = [];
  if (!config.giteaBaseUrl) missing.push("GITEA_BASE_URL");
  if (!config.giteaToken) missing.push("GITEA_TOKEN");
  if (repos.length === 0) missing.push("GITEA_REPOS");
  return {
    configured: missing.length === 0,
    missing,
    repoCount: repos.length,
    repos: repos.map((repo) => `${repo.owner}/${repo.name}`),
    userFilter: config.giteaUser || null
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function giteaFetch<T>(path: string): Promise<T> {
  if (!config.giteaBaseUrl) {
    throw new Error("GITEA_BASE_URL is not configured");
  }
  if (!config.giteaToken) {
    throw new Error("GITEA_TOKEN is not configured");
  }

  let lastError: unknown = null;
  const attempts = Math.max(1, GITEA_FETCH_RETRIES);
  const requestTimeoutMs = Number.isFinite(config.giteaFetchTimeoutMs) && config.giteaFetchTimeoutMs > 0
    ? config.giteaFetchTimeoutMs
    : 15_000;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(`${config.giteaBaseUrl}${path}`, {
        headers: {
          Authorization: `token ${config.giteaToken}`,
          Accept: "application/json"
        },
        signal: AbortSignal.timeout(requestTimeoutMs)
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${await response.text()}`);
      }
      return (await response.json()) as T;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await delay(GITEA_FETCH_RETRY_DELAY_MS * attempt);
      }
    }
  }
  throw new Error(`Gitea request failed for ${path}: ${errorMessage(lastError)}`);
}

async function giteaFetchPages<T>(path: string, limit = 50, maxPages = 5): Promise<T[]> {
  const separator = path.includes("?") ? "&" : "?";
  const firstPage = await giteaFetch<T[]>(`${path}${separator}limit=${limit}&page=1`);
  if (firstPage.length < limit || maxPages <= 1) {
    return firstPage;
  }
  const rest = await Promise.all(
    Array.from({ length: maxPages - 1 }, (_, index) => index + 2).map((page) =>
      giteaFetch<T[]>(`${path}${separator}limit=${limit}&page=${page}`)
    )
  );
  return [firstPage, ...rest].flat();
}

function giteaQuery(params: Record<string, string | number | boolean | null | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      query.set(key, String(value));
    }
  }
  return query.toString();
}

async function mapConcurrent<T, R>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        results[currentIndex] = await worker(items[currentIndex], currentIndex);
      }
    })
  );
  return results;
}

function shouldKeepIssue(issue: GiteaIssue): boolean {
  if (!config.giteaUser) {
    return true;
  }
  const assignees = [
    issue.assignee?.login,
    ...(issue.assignees ?? []).map((assignee) => assignee.login)
  ].filter(Boolean);
  const labels = (issue.labels ?? []).map((label) => label.name ?? "");
  return assignees.includes(config.giteaUser) || labels.includes("autofix");
}

function shouldKeepPull(pull: GiteaPull): boolean {
  if (!config.giteaUser) {
    return true;
  }
  const relatedUsers = [
    pull.assignee?.login,
    ...(pull.assignees ?? []).map((assignee) => assignee.login),
    ...(pull.requested_reviewers ?? []).map((reviewer) => reviewer.login),
    ...(pull.reviewers ?? []).map((reviewer) => reviewer.login)
  ].filter(Boolean);
  const labels = (pull.labels ?? []).map((label) => label.name ?? "");
  if (pull.user?.login === config.giteaUser || relatedUsers.includes(config.giteaUser) || labels.includes("autofix")) {
    return true;
  }
  // Gitea deployments do not always expose reviewer assignment in list results.
  // For the control console, incoming PRs in allowlisted repos are still actionable.
  return pull.user?.login !== config.giteaUser;
}

export type GiteaSyncResult = {
  mode: SyncMode;
  scanned: number;
  upserted: number;
  filtered: number;
  issuesScanned: number;
  pullsScanned: number;
  commentsScanned: number;
  mentionsNotified: number;
  autoReviewJobsStarted: number;
  durationMs: number;
  repos: Array<{
    repo: string;
    scanned: number;
    upserted: number;
    filtered: number;
  }>;
};

function uniqueUsers(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter(Boolean) as string[])];
}

function pullReviewers(pull: GiteaPull): string[] {
  return uniqueUsers([
    ...(pull.requested_reviewers ?? []).map((reviewer) => reviewer.login),
    ...(pull.reviewers ?? []).map((reviewer) => reviewer.login)
  ]);
}

function parseReviewerList(value: string | null): string[] {
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function reviewersIncludeCurrentUser(reviewers: string[]): boolean {
  return Boolean(config.giteaUser && reviewers.includes(config.giteaUser));
}

function pullHeadSha(pull: GiteaPull): string | null {
  return pull.head?.sha ?? pull.head_sha ?? pull.headSha ?? pull.head_commit_id ?? null;
}

function shouldNotifyPullReviewRequest(pull: GiteaPull): boolean {
  return Boolean(config.giteaUser && pullReviewers(pull).includes(config.giteaUser));
}

function mentionsCurrentUser(text: string | null | undefined): boolean {
  if (!config.giteaUser || !text) {
    return false;
  }
  const escaped = config.giteaUser.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w.-])@${escaped}(?=$|[^\\w.-])`, "i").test(text);
}

async function enrichPull(repo: { owner: string; name: string }, pull: GiteaPull): Promise<GiteaPull> {
  if (pull.user?.login && (pull.requested_reviewers?.length || pull.reviewers?.length)) {
    return pull;
  }
  try {
    const detailPath = `/api/v1/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/pulls/${pull.number}`;
    const detail = await giteaFetch<GiteaPull>(detailPath);
    return {
      ...pull,
      ...detail,
      user: detail.user ?? pull.user,
      requested_reviewers: detail.requested_reviewers ?? pull.requested_reviewers,
      reviewers: detail.reviewers ?? pull.reviewers,
      assignees: detail.assignees ?? pull.assignees,
      assignee: detail.assignee ?? pull.assignee,
      labels: detail.labels ?? pull.labels
    };
  } catch {
    return pull;
  }
}

async function fetchRepoDataFull(repo: Repo): Promise<RepoFetchData> {
  const issuesPath = `/api/v1/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/issues?state=all`;
  const pullsPath = `/api/v1/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/pulls?state=open`;
  const commentsPath = `/api/v1/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/issues/comments`;
  const [issues, listPulls, comments] = await Promise.all([
    giteaFetchPages<GiteaIssue>(issuesPath),
    giteaFetchPages<GiteaPull>(pullsPath),
    config.giteaUser ? giteaFetchPages<GiteaComment>(commentsPath, 50, 5) : Promise.resolve([])
  ]);
  const pulls = await mapConcurrent(listPulls, PULL_DETAIL_CONCURRENCY, (pull) => enrichPull(repo, pull));
  return { repo, issues, pulls, comments };
}

function repoKey(repo: Repo): string {
  return `${repo.owner}/${repo.name}`;
}

function configuredRepoMap(): Map<string, Repo> {
  return new Map(configuredGiteaRepos().map((repo) => [repoKey(repo), repo]));
}

function repoFromSearchItem(item: GiteaIssue): Repo | null {
  const fullName = item.repository?.full_name;
  if (fullName?.includes("/")) {
    const [owner, name] = fullName.split("/", 2);
    return owner && name ? { owner, name } : null;
  }
  const owner = item.repository?.owner?.login;
  const name = item.repository?.name;
  if (owner && name) {
    return { owner, name };
  }
  const match = item.html_url?.match(/\/([^/]+)\/([^/]+)\/(?:issues|pulls)\/\d+(?:$|[?#])/);
  return match ? { owner: match[1], name: match[2] } : null;
}

function searchItemToPull(item: GiteaIssue): GiteaPull {
  return {
    id: item.id,
    number: item.number,
    title: item.title,
    body: item.body,
    html_url: item.html_url,
    state: item.state,
    head: item.head,
    head_sha: item.head_sha,
    headSha: item.headSha,
    head_commit_id: item.head_commit_id,
    user: item.user,
    assignee: item.assignee,
    assignees: item.assignees,
    requested_reviewers: item.requested_reviewers,
    reviewers: item.reviewers,
    labels: item.labels
  };
}

type SearchRepoGroup = {
  repo: Repo;
  issues: Map<number, GiteaIssue>;
  pulls: Map<number, GiteaPull>;
};

function searchGroupFor(groups: Map<string, SearchRepoGroup>, item: GiteaIssue): SearchRepoGroup | null {
  const repo = repoFromSearchItem(item);
  if (!repo) {
    return null;
  }
  const allowed = configuredRepoMap().get(repoKey(repo));
  if (!allowed) {
    return null;
  }
  const key = repoKey(allowed);
  const group = groups.get(key) ?? { repo: allowed, issues: new Map<number, GiteaIssue>(), pulls: new Map<number, GiteaPull>() };
  groups.set(key, group);
  return group;
}

async function fetchSearchItems(type: "issues" | "pulls", params: Record<string, string | number | boolean | null | undefined>): Promise<GiteaIssue[]> {
  const query = giteaQuery({ state: "open", type, ...params });
  return await giteaFetchPages<GiteaIssue>(`/api/v1/repos/issues/search?${query}`, 50, GITEA_SEARCH_MAX_PAGES);
}

function writeAppSetting(key: string, value: string, updatedAt: string): void {
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, value, updatedAt);
}

function shouldRunFullSync(forceFull: boolean | undefined): boolean {
  if (forceFull || config.giteaFullSyncIntervalMs <= 0) {
    return true;
  }
  const lastFullSyncAt = appSettingValue(GITEA_SYNC_FULL_AT_KEY);
  if (!lastFullSyncAt) {
    return true;
  }
  const lastMs = Date.parse(lastFullSyncAt);
  return !Number.isFinite(lastMs) || Date.now() - lastMs >= config.giteaFullSyncIntervalMs;
}

function searchSinceIso(): string | null {
  const lastSyncAt = appSettingValue(GITEA_SYNC_SEARCH_AT_KEY) ?? appSettingValue(GITEA_SYNC_FULL_AT_KEY);
  if (!lastSyncAt) {
    return null;
  }
  const lastMs = Date.parse(lastSyncAt);
  if (!Number.isFinite(lastMs)) {
    return null;
  }
  // The stored UI interval can be longer than the environment default. Keep a
  // small overlap so every gap between two scans remains covered.
  const effectiveLookbackMs = Math.max(
    0,
    config.giteaSearchSyncLookbackMs,
    getAppSettings().pollIntervalMs + SEARCH_SYNC_LOOKBACK_BUFFER_MS
  );
  return new Date(Math.max(0, lastMs - effectiveLookbackMs)).toISOString();
}

async function fetchRepoDataSearch(): Promise<RepoFetchData[]> {
  const since = searchSinceIso();
  const groups = new Map<string, SearchRepoGroup>();
  const [reviewRequestedPulls, changedPulls, changedIssues] = await Promise.all([
    config.giteaUser ? fetchSearchItems("pulls", { review_requested: "true" }) : Promise.resolve([]),
    since ? fetchSearchItems("pulls", { since }) : Promise.resolve([]),
    since ? fetchSearchItems("issues", { since }) : Promise.resolve([])
  ]);

  for (const item of reviewRequestedPulls) {
    searchGroupFor(groups, item)?.pulls.set(item.number, searchItemToPull(item));
  }
  for (const item of changedPulls) {
    searchGroupFor(groups, item)?.pulls.set(item.number, searchItemToPull(item));
  }
  for (const item of changedIssues) {
    searchGroupFor(groups, item)?.issues.set(item.number, item);
  }

  return await Promise.all(
    [...groups.values()].map(async (group) => {
      const pulls = await mapConcurrent([...group.pulls.values()], PULL_DETAIL_CONCURRENCY, (pull) => enrichPull(group.repo, pull));
      return { repo: group.repo, issues: [...group.issues.values()], pulls, comments: [] };
    })
  );
}

function notifyNewItem(issueId: number, kind: "issue" | "pr", repo: string, number: number, title: string): void {
  const type = kind === "pr" ? "new_pr" : "new_issue";
  addNotification(type, `New ${kind.toUpperCase()} ${repo}#${number}`, title, issueId);
}

function notifyMention(issueId: number, kind: "issue" | "pr", repo: string, number: number, body: string, dedupeKey: string): boolean {
  const before = db.prepare("SELECT id FROM notifications WHERE dedupe_key = ?").get(dedupeKey);
  if (before) {
    return false;
  }
  addNotification("mention", `Mentioned in ${kind.toUpperCase()} ${repo}#${number}`, body.slice(0, 500), issueId, dedupeKey);
  return true;
}

function findIssueRow(repo: { owner: string; name: string }, externalId: number): { id: number; kind: "issue" | "pr"; title: string } | undefined {
  return db.prepare(`
    SELECT id, kind, title FROM issues
    WHERE source = 'gitea' AND repo_owner = ? AND repo_name = ? AND external_id = ?
  `).get(repo.owner, repo.name, String(externalId)) as { id: number; kind: "issue" | "pr"; title: string } | undefined;
}

function issueNumberFromComment(comment: GiteaComment): number | null {
  const match = comment.issue_url?.match(/\/issues\/(\d+)$/);
  return match ? Number(match[1]) : null;
}

function activeReviewExists(issueId: number): boolean {
  const row = db.prepare(`
    SELECT 1
    FROM pr_review_runs
    WHERE issue_id = ? AND status IN ('pending', 'running')
    LIMIT 1
  `).get(issueId);
  return Boolean(row);
}

export async function syncGiteaIssues(options: { forceFull?: boolean } = {}): Promise<GiteaSyncResult> {
  const startedAt = Date.now();
  const status = giteaSyncConfigStatus();
  if (!status.configured) {
    throw new Error(`Gitea sync is not configured: missing ${status.missing.join(", ")}`);
  }

  const syncedAt = nowIso();
  let scanned = 0;
  let upserted = 0;
  let filtered = 0;
  let issuesScanned = 0;
  let pullsScanned = 0;
  let commentsScanned = 0;
  let mentionsNotified = 0;
  let autoReviewJobsStarted = 0;
  const appSettings = getAppSettings();
  const configuredRepos = configuredGiteaRepos();
  const mode: SyncMode = shouldRunFullSync(options.forceFull) ? "full" : "search";
  const repos: GiteaSyncResult["repos"] = [];
  const seenKeys = new Set<string>();
  const repoDataList = mode === "full"
    ? await mapConcurrent(configuredRepos, REPO_SYNC_CONCURRENCY, (repo) => fetchRepoDataFull(repo))
    : await fetchRepoDataSearch();

  const statement = db.prepare(`
    INSERT INTO issues (
      source, external_id, kind, repo_owner, repo_name, title, body, url, state,
      assignee, author, reviewers, labels, head_sha, status, last_synced_at, created_at, updated_at
    ) VALUES (
      'gitea', @external_id, @kind, @repo_owner, @repo_name, @title, @body, @url, @state,
      @assignee, @author, @reviewers, @labels, @head_sha, @status, @last_synced_at, @created_at, @updated_at
    )
    ON CONFLICT(source, repo_owner, repo_name, kind, external_id) DO UPDATE SET
      title = excluded.title,
      body = excluded.body,
      url = excluded.url,
      state = excluded.state,
      assignee = excluded.assignee,
      author = excluded.author,
      reviewers = excluded.reviewers,
      labels = excluded.labels,
      head_sha = excluded.head_sha,
      status = CASE
        WHEN excluded.state = 'closed' AND issues.status IN ('open', 'queued') THEN 'closed'
        WHEN excluded.state = 'open' AND issues.status = 'closed' THEN 'open'
        ELSE issues.status
      END,
      last_synced_at = excluded.last_synced_at,
      updated_at = excluded.updated_at
  `);

  const applySync = db.transaction(() => {
    for (const { repo, issues, pulls, comments } of repoDataList) {
      const repoStats = {
        repo: `${repo.owner}/${repo.name}`,
        scanned: issues.length,
        upserted: 0,
        filtered: 0
      };
      scanned += issues.length;
      issuesScanned += issues.length;
      for (const issue of issues) {
        if (issue.pull_request) {
          continue;
        }
        if (!shouldKeepIssue(issue)) {
          filtered += 1;
          repoStats.filtered += 1;
          continue;
        }
        seenKeys.add(`${repo.owner}/${repo.name}/issue/${issue.number}`);
        const labels = (issue.labels ?? []).map((label) => label.name).filter(Boolean);
        const existing = db.prepare(`
          SELECT id FROM issues WHERE source = 'gitea' AND repo_owner = ? AND repo_name = ? AND kind = 'issue' AND external_id = ?
        `).get(repo.owner, repo.name, String(issue.number)) as { id: number } | undefined;
        const result = statement.run({
          external_id: String(issue.number),
          kind: "issue",
          repo_owner: repo.owner,
          repo_name: repo.name,
          title: issue.title,
          body: issue.body ?? "",
          url: issue.html_url ?? null,
          state: issue.state ?? null,
          assignee: issue.assignee?.login ?? issue.assignees?.[0]?.login ?? null,
          author: issue.user?.login ?? null,
          reviewers: "[]",
          labels: JSON.stringify(labels),
          head_sha: null,
          status: issue.state === "closed" ? "closed" : "open",
          last_synced_at: syncedAt,
          created_at: syncedAt,
          updated_at: syncedAt
        });
        if (!existing) {
          notifyNewItem(Number(result.lastInsertRowid), "issue", `${repo.owner}/${repo.name}`, issue.number, issue.title);
        }
        const issueRowId = existing?.id ?? Number(result.lastInsertRowid);
        if (mentionsCurrentUser(issue.body) && notifyMention(issueRowId, "issue", `${repo.owner}/${repo.name}`, issue.number, issue.body ?? "", `gitea:mention:body:${repo.owner}/${repo.name}:issue:${issue.number}`)) {
          mentionsNotified += 1;
        }
        upserted += 1;
        repoStats.upserted += 1;
      }

      scanned += pulls.length;
      pullsScanned += pulls.length;
      repoStats.scanned += pulls.length;
      for (const pull of pulls) {
        if (!shouldKeepPull(pull)) {
          filtered += 1;
          repoStats.filtered += 1;
          continue;
        }
        seenKeys.add(`${repo.owner}/${repo.name}/pr/${pull.number}`);
        const labels = (pull.labels ?? []).map((label) => label.name).filter(Boolean);
        const reviewers = pullReviewers(pull);
        const assignees = uniqueUsers([
          pull.assignee?.login,
          ...(pull.assignees ?? []).map((assignee) => assignee.login)
        ]);
        const existing = db.prepare(`
          SELECT id, head_sha, reviewers FROM issues WHERE source = 'gitea' AND repo_owner = ? AND repo_name = ? AND kind = 'pr' AND external_id = ?
        `).get(repo.owner, repo.name, String(pull.number)) as { id: number; head_sha: string | null; reviewers: string | null } | undefined;
        const headSha = pullHeadSha(pull);
        const result = statement.run({
          external_id: String(pull.number),
          kind: "pr",
          repo_owner: repo.owner,
          repo_name: repo.name,
          title: pull.title,
          body: pull.body ?? "",
          url: pull.html_url ?? null,
          state: pull.state ?? null,
          assignee: assignees[0] ?? null,
          author: pull.user?.login ?? null,
          reviewers: JSON.stringify(reviewers),
          labels: JSON.stringify(labels),
          head_sha: headSha,
          status: pull.state === "closed" ? "closed" : "open",
          last_synced_at: syncedAt,
          created_at: syncedAt,
          updated_at: syncedAt
        });
        if (!existing && shouldNotifyPullReviewRequest(pull)) {
          notifyNewItem(Number(result.lastInsertRowid), "pr", `${repo.owner}/${repo.name}`, pull.number, pull.title);
        }
        const pullRowId = existing?.id ?? Number(result.lastInsertRowid);
        const headChanged = Boolean(existing && existing.head_sha !== headSha);
        const reviewRequested = reviewersIncludeCurrentUser(reviewers);
        const newlyReviewRequested = Boolean(existing && !reviewersIncludeCurrentUser(parseReviewerList(existing.reviewers)) && reviewRequested);
        const activeReview = activeReviewExists(pullRowId);
        if (reviewRequested && (!existing || newlyReviewRequested || headChanged) && appSettings.autoReviewNewPulls && !activeReview) {
          const pullRow = db.prepare("SELECT * FROM issues WHERE id = ?").get(pullRowId) as IssueRow | undefined;
          if (pullRow && createReviewOnlyJobForPull(pullRow).ok) {
            autoReviewJobsStarted += 1;
          }
        }
        if (mentionsCurrentUser(pull.body) && notifyMention(pullRowId, "pr", `${repo.owner}/${repo.name}`, pull.number, pull.body ?? "", `gitea:mention:body:${repo.owner}/${repo.name}:pr:${pull.number}`)) {
          mentionsNotified += 1;
        }
        upserted += 1;
        repoStats.upserted += 1;
      }

      if (config.giteaUser) {
        commentsScanned += comments.length;
        for (const comment of comments) {
          if (!mentionsCurrentUser(comment.body)) {
            continue;
          }
          const issueNumber = issueNumberFromComment(comment);
          if (!issueNumber) {
            continue;
          }
          const issueRow = findIssueRow(repo, issueNumber);
          if (!issueRow) {
            continue;
          }
          if (notifyMention(issueRow.id, issueRow.kind, `${repo.owner}/${repo.name}`, issueNumber, comment.body ?? "", `gitea:mention:comment:${repo.owner}/${repo.name}:${comment.id}`)) {
            mentionsNotified += 1;
          }
        }
      }
      repos.push(repoStats);
    }

    if (mode === "full") {
      for (const repo of configuredRepos) {
        const existingRows = db.prepare(`
          SELECT id, kind, external_id FROM issues
          WHERE source = 'gitea' AND repo_owner = ? AND repo_name = ? AND state = 'open'
        `).all(repo.owner, repo.name) as Array<{ id: number; kind: "issue" | "pr"; external_id: string }>;
        for (const row of existingRows) {
          const key = `${repo.owner}/${repo.name}/${row.kind}/${row.external_id}`;
          if (!seenKeys.has(key)) {
            db.prepare("UPDATE issues SET state = 'closed', status = CASE WHEN status IN ('open', 'queued') THEN 'closed' ELSE status END, updated_at = ? WHERE id = ?").run(syncedAt, row.id);
          }
        }
      }
    }
    if (mode === "full") {
      writeAppSetting(GITEA_SYNC_FULL_AT_KEY, syncedAt, syncedAt);
    }
    writeAppSetting(GITEA_SYNC_SEARCH_AT_KEY, syncedAt, syncedAt);
  });
  applySync();

  return { mode, scanned, upserted, filtered, issuesScanned, pullsScanned, commentsScanned, mentionsNotified, autoReviewJobsStarted, durationMs: Date.now() - startedAt, repos };
}
