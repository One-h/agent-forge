# Agent Forge

Agent Forge is a local-first TypeScript control plane for one developer's workspace. It runs on your own Mac, stores its state in local SQLite, and is bound to `127.0.0.1` by default.

It syncs selected Gitea issues and pull requests into SQLite, shows them in a web UI, and lets a human trigger Codex repair jobs. Codex runs from the configured workspace root so it can use its `AGENTS.md`, skills, knowledge notes, and worktree helpers.

## Capabilities

- Sync open Gitea issues and pull requests from an allowlist of repositories.
- Store issues, repair jobs, events, and short setup locks in SQLite.
- Run multiple Codex jobs concurrently.
- Allow same-repo concurrency through isolated branch/worktree lanes.
- Let Codex create PRs directly and report the PR URL through structured output.
- Manage a local Lark sticker library with batch upload and configurable, MCP-based sticker selection when connected to Lark Agent.
- Accept structured todos from Lark with priority, tags, automatic due dates, reminders, and completion callbacks to the source conversation.

## Two Projects, One Optional Integration

| Project | Responsibility | Runs independently? |
| --- | --- | --- |
| **Agent Forge** (this repository) | Web console, settings, Codex Todo, Git/Gitea workflows, and the management UI for Lark Agent | Yes; Git and Lark integrations are optional |
| **[Lark Agent](https://github.com/One-h/lark-agent)** | Feishu/Lark listeners, Codex conversations, approvals, contacts, images/files, stickers, and reliable delivery | Yes; Forge adds a web management UI and host capabilities |

```text
Feishu / Lark <--> Lark Agent :4780 <--> Codex App Server
                        |
                   Agent Forge
                   API :4731 / Web :4732 / Companion :4734
                        |
                 Git/Gitea, Todo, optional deployment adapter
```

The repositories have separate dependencies, processes, and SQLite databases.
**Installing Forge does not install or start Lark Agent.** Forge connects over a
loopback HTTP API using shared runtime/host tokens; neither repository is an npm
dependency of the other. Both use your own workspace, skills, and credentials.

## Quick Start: Console Only

Requires macOS, Git, Node.js 24/npm, and a logged-in Codex CLI for Codex tasks.
Use this route for Todo and optional Git/Gitea workflows without a Feishu bot.

```bash
git clone https://github.com/One-h/agent-forge.git
cd agent-forge
# With nvm installed; run nvm install first if Node 24 is missing.
nvm use
npm ci
npm run migrate
npm run dev
```

Open Settings and choose your workspace. Skip Git setup when it is not needed.
This command starts the Forge services below, not the Lark Agent listener.

API: `http://localhost:4731`

Web: `http://localhost:4732`

Codex companion: `http://localhost:4734/todos`

## Install the Full Suite

Start with the **[complete installation walkthrough](docs/INSTALL.md#full-suite)**.
It includes both clones, Node 24 dependencies, protected local configuration,
shared tokens, startup commands, activation, and acceptance checks. For an AI
performing the installation, also follow [AI 从零部署与配置指南](docs/AI-BOOTSTRAP.md).

1. Install `agent-forge` and `lark-agent` as sibling directories.
2. Install/login to Codex and `lark-cli`; configure your own Feishu application,
   bot availability, message events, and card-action callbacks.
3. Create the local Lark Agent configuration and two random shared tokens.
   Keep them outside Git; the walkthrough does not overwrite existing files.
4. Start Lark Agent on `4780`, then Forge on `4731/4732/4734`. Forge automatically
   reads the sibling `lark-agent/data/runtime.env`; for another location set
   `AGENT_FORGE_RUNTIME_ENV` to its absolute path.
5. Complete Settings, activate the bot, and verify a real private reply, group
   mention, and approval callback. A healthy process alone is not full acceptance.

No company workspace, contacts, sticker collection, production credentials, or
deployment workflow is bundled. Import your own authorized media; configure a
[local deployment adapter](docs/DEPLOYMENT-ADAPTER.md) only if you need deployment.

## Configuration and Daily Use

`npm run dev` also builds and watches the original `/todos` React page for the dedicated Codex window and attaches to an existing loopback CDP renderer. Run `npm run forge:open` (or `npm run codex:open`) to check/start the service and open the dedicated window directly on Agent Forge Todo. See [apps/codex-companion/README.md](apps/codex-companion/README.md) for its security model and configuration.

Forge configuration and jobs are stored in its local SQLite database, with paths resolved from the repository root. With Lark Agent connected, its conversation/sticker metadata and media are owned by the Agent; the full-suite layout stores them in `lark-agent/data/lark-agent.sqlite` and `lark-agent/data/stickers/`. Do not share database files between the two services or assume a Forge-only backup includes the Agent's data.

Agents can extend the same library from a public image URL or a generated local file with `npm run stickers:add -- --url <image-url> --name <name> --description <usage> --tags <tag1,tag2>` (use `--file <absolute-path>` for local images). The command validates the image and records its source before adding it through the loopback API.

Open `http://localhost:4732/settings` to complete the first-run setup. The workspace path, Gitea address, username, trusted Lark IDs, and selected repositories are stored in local SQLite. Gitea token remains in macOS Keychain and is never stored in SQLite.

Group privacy protection is optional and disabled by default. Enable it in Settings or the group privacy page to review group replies and operations privately. Its company-directory allowlist is separate from the ordinary assistant's workspace and defaults to empty; choosing directories does not enable privacy protection. See [choosing company directories](docs/INSTALL.md#61-选择助手可研究的公司资料目录).

The first-run wizard checks the workspace and local diagnostics. Git/Gitea setup is optional; credentials and selected repositories are required only when enabling repository sync. Settings can also export and restore portable backups of configuration, repositories, todos, and audit history. Backups exclude tokens, Lark login state, task artifacts, and synced Issue/PR content.

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
- Lark Codex replies use a local `codex app-server`. Conversations reuse their thread within the same trust scope. New messages can steer an active turn; its final answer may consolidate several inputs rather than sending one independent answer per message.
- Gitea tokens saved through Settings are stored in macOS Keychain. The API only accepts the local web UI as a cross-origin caller. Lark uses the locally authenticated `lark-cli` profile.
- Production actions require an explicit user request and the configured trust/approval policy, which may include automatic turn approval. Deployment also requires a local adapter and the operator's credentials; command execution is not reported as verification without explicit verification evidence.
- PR creation is delegated to Codex using a workspace submission skill when available, or the configured Git/Gitea tools otherwise.
