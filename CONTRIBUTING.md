# Contributing

Agent Forge is an MIT-licensed, self-hosted developer tool. Contributions are welcome through GitHub issues and pull requests.

1. Use Node 24 (`nvm use`) and install dependencies with `npm ci`.
2. Run `npm run typecheck` and `npm test` before opening a change for review.
3. Keep credentials, local databases, task artifacts, and `.env` files out of Git.
4. Do not weaken the loopback-only server binding or trusted-sender approval model without an explicit security review.
5. Describe any changes to Codex execution, Gitea writes, Feishu messages, or deployment behavior in the change summary.
