# Agent Forge Agent Rules

These rules apply to the entire repository.

## Repository Changes

- Preserve unrelated local files and inspect `git status --short` before staging changes.
- Keep changes scoped to the requested behavior and validate them with the narrowest meaningful checks.
- Do not create a PR, merge, deploy, or modify remote/production state unless the user explicitly requests it.

## Local Service Lifecycle

- Use one combined development service in tmux. Reuse the session already bound to this checkout; for a new checkout use `agent-forge-dev` or `AGENT_FORGE_TMUX_SESSION`.
- Run `npm run dev` from the repository root. It owns API port `4731`, web port `4732`, and companion port `4734`.
- Do not leave separate long-running API, web, or companion services running alongside the combined service.
- Before restarting, inspect the named tmux session and port owners. Stop only processes that are confirmed to belong to this repository.
- After service operations, verify the tmux session, all three ports, and `http://127.0.0.1:4731/api/health`.

## Database Safety

- Treat `apps/api/data/autofix.sqlite` and the configured Lark Agent database as persistent user data. Never delete, replace, truncate, reset, copy a fixture over, or run test cleanup against these files or their `-wal` / `-shm` companions.
- Run API tests only through `npm test` or `npm --workspace apps/api test`. The test runner creates a unique database under the operating system temporary directory and removes it after the test process exits.
- Do not point `DATABASE_PATH`, `LARK_AGENT_DATABASE`, test fixtures, migrations, or ad hoc scripts at an existing runtime database. Tests that need seeded state must create their own temporary database.
- Any test helper that performs broad `DELETE`, `DROP`, restore, or reset operations must first enforce the temporary-test-database guard. A filename such as `test.sqlite` by itself is not sufficient proof of isolation.
- Before database migration or recovery work, inspect the resolved database path and preserve the existing file. Destructive recovery requires an explicit user request naming the exact disposable database.
