# Agent Forge

Agent Forge is a local-first TypeScript control plane for one developer's workspace. It runs on your own Mac, stores its state in local SQLite, and is bound to `127.0.0.1` by default.

It syncs selected Gitea issues and pull requests into SQLite, shows them in a web UI, and lets a human trigger Codex repair jobs. Codex runs from the configured workspace root so it can use its `AGENTS.md`, skills, knowledge notes, and worktree helpers.

## Capabilities

- Sync open Gitea issues and pull requests from an allowlist of repositories.
- Store issues, repair jobs, events, and short setup locks in SQLite.
- Run multiple Codex jobs concurrently.
- Allow same-repo concurrency through isolated branch/worktree lanes.
- Let Codex create PRs directly and report the PR URL through structured output.
- Manage a local Lark sticker library with batch upload, editable usage guidance, and one ID-based sticker on every final Agent reply.
- Accept structured todos from Lark with priority, tags, automatic due dates, reminders, and completion callbacks to the source conversation.

## Quick Start

AI-assisted first-time installation: [AI 从零部署与配置指南](docs/AI-BOOTSTRAP.md).
It covers optional Git setup, the standalone Lark Agent, local credentials, startup order, and acceptance checks.

```bash
nvm use
npm install
npm run migrate
npm run dev
```

API: `http://localhost:4731`

Web: `http://localhost:4732`

Codex companion: `http://localhost:4734/todos`

`npm run dev` also builds and watches the original `/todos` React page for the dedicated Codex window and attaches to an existing loopback CDP renderer. Run `npm run forge:open` (or `npm run codex:open`) to check/start the service and open the dedicated window directly on Agent Forge Todo. See [apps/codex-companion/README.md](apps/codex-companion/README.md) for its security model and configuration.

User-facing configuration is stored in the local SQLite database. The database and task-output paths are resolved from the repository root. Lark sticker metadata is stored in SQLite and image files are kept under `data/lark-stickers/`.

Agents can extend the same library from a public image URL or a generated local file with `npm run stickers:add -- --url <image-url> --name <name> --description <usage> --tags <tag1,tag2>` (use `--file <absolute-path>` for local images). The command validates the image and records its source before adding it through the loopback API.

Open `http://localhost:4732/settings` to complete the first-run setup. The workspace path, Gitea address, username, trusted Lark IDs, and selected repositories are stored in local SQLite. Gitea token remains in macOS Keychain and is never stored in SQLite.

The first-run wizard checks the workspace, Gitea credential, selected repositories, and local diagnostics before enabling the workspace. Settings can also export and restore portable backups of configuration, repositories, todos, and audit history. Backups exclude tokens, Lark login state, task artifacts, and synced Issue/PR content.

For an upgrade from an older installation, the first startup imports non-sensitive values from an existing `.env` into SQLite once. The running service no longer reads `.env`; review the Settings page before manually removing that legacy file.

The health endpoint exposes non-sensitive sync configuration status at `/api/health`.

## Testing

Run tests with `npm test` from the repository root. API tests create a unique SQLite database in the operating system temporary directory and remove it when the test process exits. They never reuse `apps/api/data/autofix.sqlite`, the Lark Agent database, or the legacy `apps/api/data/test.sqlite` file.

Do not run API test files directly or override `DATABASE_PATH` for a test. The database module detects test processes and refuses to open any path that is not the isolated directory created by the test runner.

Lark-created todos use the configured execution-approval recipient as the default todo recipient. Reminder behavior can be adjusted with `TODO_REMINDER_TIME_ZONE`, `TODO_DIGEST_HOUR`, `TODO_REMINDER_START_HOUR`, `TODO_REMINDER_END_HOUR`, and `TODO_REMINDER_POLL_INTERVAL_MS`.

Detailed setup, troubleshooting, and removal instructions are in [docs/INSTALL.md](docs/INSTALL.md), [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md), and [docs/UNINSTALL.md](docs/UNINSTALL.md).

## Safety Model

The Feishu conversation header offers a Persona drawer for per-chat role and tone.
Default mode follows the global Feishu assistant prompt; custom mode supports
preview, save and reset through Lark Agent. Changes apply to the next turn without
resetting conversation history or changing trust/approval settings.

Group spontaneous replies require both the opt-in switch and an exact group ID in
Settings > Automation > the spontaneous-reply allowlist. An empty list disables
spontaneous replies everywhere; direct mentions and private messages are unaffected.
The allowlist is persisted locally and synchronized to Lark Agent on save/restore.

- The web UI passes structured job parameters only; it never accepts arbitrary shell commands.
- Agent Forge repair and PR-review jobs can run Codex with full local workspace permissions. Turn on only the repositories and integrations you trust; it never merges, deploys, or mutates online systems by itself.
- Lark messages remain read-only by default. When high-permission execution is explicitly enabled, the configured execution-approval recipient is trusted by default; additional trusted sender IDs are optional. Trusted senders have the full local permissions of the deploying user, including file changes, Git/Gitea actions, and any deployment capability already available through that user's local skills and credentials.
- Lark Codex replies use a local `codex app-server`. Messages in the same conversation are processed as serialized turns on the existing Codex thread, so every mentioned message receives its own final answer instead of replacing an earlier in-flight task.
- Gitea tokens saved through Settings are stored in macOS Keychain. The API only accepts the local web UI as a cross-origin caller. Lark uses the locally authenticated `lark-cli` profile.
- The system never deploys or writes production data automatically. A trusted sender can explicitly request an action that the deploying user's local skills and credentials permit; production actions still depend on the target skill and available local access.
- PR creation is delegated to Codex through the workspace `tea-pr-submit-cn` skill.
