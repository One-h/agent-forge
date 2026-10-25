# Agent Forge Codex Companion

This workspace embeds the Agent Forge React `/todos` page in a dedicated ChatGPT/Codex window without modifying or re-signing the desktop application.

## Lifecycle

The repository-level `npm run dev` command builds and watches the embed bundle, serves the loopback companion on `127.0.0.1:4734`, and attaches the injector to an existing dedicated Codex renderer on `127.0.0.1:9237`.

Open the dedicated window from any terminal:

```bash
npm run forge:open
```

`npm run forge:open` is the branded entry point; `npm run codex:open` remains available for compatibility. It checks the combined tmux service and starts it only when the named session and ports are free, then opens or focuses the dedicated window and enters Agent Forge Todo. An existing unhealthy session is preserved for diagnosis instead of interrupting active tasks.

The dedicated profile is stored at `/private/tmp/autofix-codex-companion-profile`. The first launch may require signing in.

## Security boundaries

- CDP and the companion server bind only to loopback addresses.
- The iframe keeps an opaque sandbox origin and uses an in-memory `localStorage` fallback.
- The companion handles `/api/*` preflight locally for POST, PUT, PATCH, DELETE, and private-loopback requests before proxying the actual request to the Agent Forge API.
- The host bridge accepts only `codex://threads/{UUID}` messages from the current companion iframe.
- Opening Agent Forge covers Codex thread-summary floating content; switching a native Codex task closes the overlay.
- The companion proxies `/api` to the local Agent Forge API and does not add any background Todo mutations.

## Configuration

- `AUTOFIX_CODEX_CDP_PORT` defaults to `9237`.
- `AUTOFIX_CODEX_PROFILE` overrides the dedicated profile path.
- `AUTOFIX_TODO_URL` defaults to `http://127.0.0.1:4734/todos`.
- `AUTOFIX_API_ORIGIN` defaults to `http://127.0.0.1:4731`.
- `AUTOFIX_CODEX_SKIP_LAUNCH=1` attaches without opening another window.
- `AUTOFIX_CODEX_ONESHOT=1` injects once for diagnostics and exits.
