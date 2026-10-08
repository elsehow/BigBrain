# Connect your agents to BigBrain

BigBrain uses the AI subscriptions you already have. Connect your other agents
to its memory through MCP.

Model connections and memory connections are separate. Pi and Claude Code run
BigBrain's internal agents; see [provider runtimes](pilot-providers.md). An
external agent does not need to become a BigBrain runtime to use its memory.

## Local MCP

Open **Settings → Connected Clients → New connection**, choose the client, and
name the connection. Run the command in its pending row (or copy the JSON for
a generic MCP client). Restart the client's MCP connection. The row changes
from **Waiting for connection** to **Connected** after the client authenticates,
and the setup block disappears. Configure → Setup can show it again.

`bigbrain connect --agent claude` (or `codex`) prints the same named MCP setup.
`bigbrain mcp config` prints generic MCP configuration; `bigbrain mcp register`
can register it in supported desktop clients. These use the same local MCP
transport and per-client credentials, rather than plugins.

Configuration pins the selected vault and executable. The credential stays in
a private local file; the command contains only its ID. Disconnect revokes
subsequent MCP calls, including existing sessions. A local process still has
its operating-system account's filesystem permissions.

A connection lapses after 30 days unused; any use restarts the clock. A lapsed
connection's tools all answer "This BigBrain connection expired after 30 days
unused. Renew it in BigBrain → Settings → Connected clients.", and when a
client tries one the app shows a notice with **Renew** (several share one
notice, which opens Connected clients). Renewing keeps the connection's ID,
configuration and access, so nothing in the client changes.

The public tools are `load_memory`, `search_vault`, `read_note`, and `drop`.
Contributions are attributed to the named credential. This does not grant
internal gardener operations or integration access.

## Replace a legacy plugin

Existing Claude Code and Codex plugin connections are deprecated, including
the older HTTP plugin credential `bigbrain connect` once made (`claude code on
<machine>`), which is listed here too. Choose **Replace connection** on the
legacy row and complete the replacement's MCP
setup. The plugin remains authorized until the replacement authenticates;
then its old credential is revoked. Canceling a pending replacement does not
revoke the plugin. New plugin connections cannot provision credentials.

After the replacement connects, remove BigBrain from your client's installed
plugins and restart the client. This removes the old plugin's MCP entry,
skills, and startup hooks. The named MCP entry remains; agents can use
`load_memory` directly. Existing vault evidence is retained.

Email and That Tracks are temporarily absent from the integrations screen
pending MCP replacements. Their saved configuration and evidence are retained.

## Implementation

`lib/vaultTools.ts` owns shared schemas, validation and handlers. Pilot and
background jobs select their own tool sets from it. `lib/mcp.ts` selects and
dispatches the four vault tools plus explicitly granted integration reads. Claude's embedded SDK MCP adapter and
Pi's native tool adapter remain independent of the external stdio transport.

Edit shared plugin sources in `clients/shared/`, then run `bun run plugins:build`.
Bump the generator's plugin version and the content pin in
`test/pluginVersion.test.ts` when shipped behavior changes.

Codex MCP launch configuration uses `cwd: "."` with a relative script path;
plugin hook variables are not interpolated in MCP arguments. This follows the
[Codex plugin config parser](https://github.com/openai/codex/blob/main/codex-rs/codex-mcp/src/plugin_config.rs).

## Rebuild after a major memory update

Existing users should run `bigbrain memory --from-scratch` after the September
2026 memory prompt revision. This reselects context from the source record,
without carrying forward the previous summary's topics or emphasis. The old
memory is saved under `journal/memory/pre-native-backup-<timestamp>/`.

Settings → Diagnostics shows “Memory update available” when the current tree
was built under an older memory protocol. Rebuilding is your choice; ordinary
scheduled updates continue and do not clear the notice. A successful fresh
rebuild clears it. Failed rebuilds restore the backup and retain the notice.

Maintainers: bump `MEMORY_PROTOCOL_VERSION` in `lib/memory.ts` only for changes
that warrant reselecting memory from the record, not for routine prompt edits.
Successful fresh builds record the version in the checkpoint and run journal,
so it survives deletion of the local `.state` cache. Unversioned memory is v0;
newer versions are not downgraded by an older engine. `--keep-tree` does not
qualify as a fresh rebuild and does not clear an outstanding notice.
