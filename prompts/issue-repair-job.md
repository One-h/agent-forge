# Agent Forge Issue Repair

You are running in `{{WORKSPACE_ROOT}}`. Follow the workspace `AGENTS.md`.

## Task

Investigate, repair, validate, commit, push, and open a Gitea PR for this issue.

- Job ID: `{{JOB_ID}}`
- Mode: `{{MODE}}`
- Task package: `{{TASK_DIR}}`
- Repo hint: `{{REPO_HINT}}`
- Item: `{{REPO_OWNER}}/{{REPO_NAME}}#{{ISSUE_EXTERNAL_ID}}`
- URL: `{{ISSUE_URL}}`
- Title: `{{ISSUE_TITLE}}`
- Author: `{{ISSUE_AUTHOR}}`

```markdown
{{ISSUE_BODY}}
```

## Instructions

1. Collect enough evidence to identify the target repo and smallest safe fix.
2. Create or update the task package under `{{TASK_DIR}}`.
3. Before changing code, stop and output `blocked` if the evidence is insufficient, the target repository is uncertain, the acceptance criteria are unclear, the requested behavior may require product judgment, or multiple plausible repair directions would change user-visible behavior differently.
   - In that case, do not create a code worktree, do not edit files, do not commit, do not push, and do not open a PR.
   - Write `final.json` with `status: "blocked"`, `pr_url: null`, `worktree_path: null`, and `branch_name: null`.
   - Put the concrete missing information and clarification questions in `summary` and `residual_risk`.
   - Include any evidence already checked in `verification`.
   - Post a comment on the original Gitea issue before finalizing. Mention the issue author if `{{ISSUE_AUTHOR}}` is not empty, explain that Agent Forge is blocked, and list the specific missing details or decision points.
   - Use `tea comment {{ISSUE_EXTERNAL_ID}} -r {{REPO_OWNER}}/{{REPO_NAME}} <body>` or an equivalent shell-safe command.
4. Follow the target repository's checkout rules. When isolation is required, use native Git under the setup lock:
   `node {{AUTOFIX_REPO_ROOT}}/scripts/with-repo-setup-lock.mjs {{REPO_NAME}} {{JOB_ID}} -- git -C <target-repository> worktree add -b <task-branch> <worktree-directory> <base-ref>`.
   Resolve the repository, base ref and allowed directory from evidence; no external workspace helper is required.
5. Implement the fix, run relevant verification, commit, push, and create the Gitea PR.
6. Do not merge, deploy, write production data, mutate online databases, force-push, or run destructive git commands.
7. Finish by writing `final.json` through the runner-provided completion helper. Include the created PR URL as `pr_url`.

Do not stop after prose-only output. The Agent Forge runner finishes only when `final.json` exists.
