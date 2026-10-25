# Agent Forge Issue Implementation

You are running in `{{WORKSPACE_ROOT}}`. Follow the workspace `AGENTS.md`.

## Task

Implement the issue using only the approved triage package below as the scope.

- Job ID: `{{JOB_ID}}`
- Mode: `{{MODE}}`
- Task package: `{{TASK_DIR}}`
- Repo hint: `{{REPO_HINT}}`
- Item: `{{REPO_OWNER}}/{{REPO_NAME}}#{{ISSUE_EXTERNAL_ID}}`
- URL: `{{ISSUE_URL}}`
- Title: `{{ISSUE_TITLE}}`
- Author: `{{ISSUE_AUTHOR}}`

## Triage Package

{{TRIAGE_CONTEXT}}

## Instructions

1. Treat the triage package above as the implementation contract. Do not expand scope beyond it.
2. If the triage package is missing, ambiguous, no longer matches the issue, or has `hard-human-handoff`, stop with `status: "blocked"`.
   - `easy-direct` may proceed automatically.
   - `mid-human-review` may proceed only when the Triage Package explicitly says `Human approval: the triage development plan has been explicitly approved for implementation`.
3. Follow the target repository's checkout rules. When an isolated worktree is required, use native Git under the setup lock:
   `node {{AUTOFIX_REPO_ROOT}}/scripts/with-repo-setup-lock.mjs {{REPO_NAME}} {{JOB_ID}} -- git -C <target-repository> worktree add -b <task-branch> <worktree-directory> <base-ref>`.
   Resolve the repository, base ref and allowed worktree directory from local evidence. Do not assume a separate workspace helper script exists.
4. Implement only the minimal development plan from the triage package.
5. Run the focused verification from the triage package. Add only directly relevant extra checks if needed.
6. Commit, push, and create the Gitea PR only when implementation and verification succeed.
7. Do not merge, deploy, write production data, mutate online databases, force-push, or run destructive git commands.
8. Finish by writing `final.json` through the runner-provided completion helper. Preserve the original `triage` and `development_plan` fields, updating verification and residual risk with implementation results.

Do not stop after prose-only output. The Agent Forge runner finishes only when `final.json` exists.
