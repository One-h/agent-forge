# Optional deployment adapter

Deployment is optional and has no bundled company or cluster integration.
Configure an absolute path to your own Node.js adapter in Settings under
"本机部署适配脚本". It is stored only in the local database. Empty paths disable
execution; ordinary chat, issues, reviews and todos do not need an adapter.

The host runs `node <adapter>` in the configured workspace with arguments:

```text
--repo <repository> --app <comma-separated-apps> --timeout <seconds>
[--expected-revision <inspected-revision>] [--execute]
```

Without `--execute`, the adapter must only inspect. With `--execute`, it must
honor the exact approved target and perform its own rollout verification.
Authentication, cluster mappings and deployment rules belong to the operator's
adapter, not this repository. The host never installs or downloads an adapter.

Write one JSON object to stdout, diagnostics to stderr, and exit nonzero on
failure. Inspection should include `sourceRevision` and the concrete target.
Deployment verification must be explicit (`verified: true`), or use
`fresh: true` with a `deployed`/`verified-noop` result after actual verification.
Otherwise a successful command is reported as executed, not verified.

Restart the Forge host after first configuring an adapter so it can register
the optional deployment tools. Every invocation still reads current settings;
clearing the path immediately blocks execution, including from old tool lists.

Host callbacks require `LARK_AGENT_HOST_TOKEN`; the matching token must be
configured on Lark Agent. Runtime capability registration and invocation require
`LARK_AGENT_RUNTIME_TOKEN`; Forge uses the same value as `LARK_AGENT_TOKEN`.
Keep these credentials in the deployment's ignored local configuration.
