# Agent Forge PR Review

You are running in `{{WORKSPACE_ROOT}}`. Follow the workspace `AGENTS.md`.

## Task

Code-review the existing Gitea pull request and post the review back to that PR. Use a workspace review skill when available; otherwise use the configured Gitea API or authenticated tea CLI and local Git evidence.

- Job ID: `{{JOB_ID}}`
- Mode: `{{MODE}}`
- Task package: `{{TASK_DIR}}`
- PR: `{{REPO_OWNER}}/{{REPO_NAME}}#{{ISSUE_EXTERNAL_ID}}`
- URL: `{{ISSUE_URL}}`
- Title: `{{ISSUE_TITLE}}`
- Current head SHA: `{{ISSUE_HEAD_SHA}}`
{{PR_REVIEW_CONTEXT}}

```markdown
{{ISSUE_BODY}}
```

## Instructions

1. If `{{WORKSPACE_ROOT}}/skills/tea-pr-review/SKILL.md` exists, follow that workspace review workflow. Otherwise read PR metadata, base/head changes and prior comments using the configured API/CLI, inspect the relevant code and tests, and report actionable findings with file/line evidence. Verify that the posted comment belongs to this PR.
2. Review only this existing PR. Do not create a branch, worktree, commit, push, or new PR.
3. If an incremental review context is provided above, treat it as authoritative and narrower than the generic skill workflow: use the previous reviewed head as the base for the main review, inspect only the incremental diff plus prior unresolved findings, and do not re-review unchanged files unless needed to verify a specific prior finding.
4. Save the posted review body to `{{TASK_DIR}}/review.md`.
5. Include a `triage` object in `final.json`. For review-only PR jobs, use `decision: "mid-human-review"` with scores that reflect review complexity, and summarize the review risk briefly.
6. Record the key evidence and comment-post result in `{{TASK_DIR}}/verification.md`.
7. Finish by writing `final.json` through the runner-provided completion helper. Use the original PR URL as `pr_url`.

Do not stop after prose-only output. The Agent Forge runner finishes only when `final.json` exists.
