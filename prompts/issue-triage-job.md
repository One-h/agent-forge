# Agent Forge Issue Triage

You are running in `{{WORKSPACE_ROOT}}`. Follow the workspace `AGENTS.md`.

## Task

Analyze this Gitea issue in read-only mode. Produce a triage result and a development plan, but do not implement code.

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

1. Collect enough read-only evidence to identify the likely target repo, smallest safe scope, risks, and validation path.
2. Do not edit files, create a worktree, commit, push, post comments, open PRs, mutate databases, deploy, or run destructive commands.
3. Write `{{TASK_DIR}}/context-manifest.md` with:
   - issue summary and acceptance interpretation
   - evidence reviewed
   - target repo and likely files/modules
   - triage decision and four scores
   - blockers or questions
4. Write `{{TASK_DIR}}/development-plan.md` with:
   - proposed minimal implementation
   - concrete steps
   - expected files/modules
   - verification plan
   - risks and rollback notes
5. Classify the issue as exactly one of:
   - `easy-direct`: isolated, low-risk, clear acceptance, focused verification available.
   - `mid-human-review`: feasible but needs human review of scope, behavior, blast radius, or validation before implementation.
   - `hard-human-handoff`: unclear, high-risk, production/data/auth/billing/schema/deployment/cross-repo sensitive, or needs human ownership.
6. Score each dimension from 1 to 5: `difficulty`, `workload`, `importance`, and `complexity`.
7. Finish by writing `final.json` through the runner-provided completion helper.

Use `status: "triaged"` in `final.json`. Include `triage` and `development_plan`.

Do not stop after prose-only output. The Agent Forge runner finishes only when `final.json` exists.
