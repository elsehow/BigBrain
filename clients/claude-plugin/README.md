# The BigBrain Claude Code plugin

A local MCP connection, search/save skills, and a session-start memory preload.
See [agent memory connections](../../docs/agent-memory.md) for setup and migration.

`bigbrain connect` installs the bundled plugin. Start a new session after updating.
The plugin requires BigBrain and its vault on this computer. Skills use the MCP
server's four public tools; no HTTP shell commands or shell-approval hook remain.
The startup hook calls `bigbrain mcp memory` through the same local launcher.
It stays silent on failure, bounds the working set, and labels it as reference data.

Skills, launcher and hooks are generated from `clients/shared/` and
`clients/adapters/claude/`. Run `bun run plugins:build` after editing those sources.
Every behavior change bumps the generator version and updates the content pin.
The desktop app refreshes installed copies through the existing plugin lifecycle.

`bun test test/plugin.test.ts test/mcp.test.ts` exercises both generated packages
with real local MCP clients and scratch vaults. No model call is made.
