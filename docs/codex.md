# Legacy Codex runtime and external plugins

For current setup, see [provider runtimes](pilot-providers.md) and
[local MCP memory connections](agent-memory.md). The Codex execution details
below are historical implementation notes, not current setup instructions; new ChatGPT execution uses Pi. Plugin connections are deprecated: use Settings → Connected Clients and follow the replacement instructions in [agent memory](agent-memory.md#replace-a-legacy-plugin).


BigBrain can use either connected agent to run its gardener and memory pass.
In **Settings → Vault**, one **Curation model** selection controls both,
including memory trimming and entity-fold proposals. The menu groups models
by agent: Claude Code's current aliases and Codex's account-visible models.
You can also enter a model ID for either agent.

Connecting another agent does not change an existing selection. If the
selected agent is signed out or unavailable, its runs fail with an error;
BigBrain does not switch providers or models automatically.

## Try the connection from a worktree

```sh
bun run preview:codex
```

This builds the UI, opens your browser at the agent connection screen, and
starts the real setup and intake APIs. Sign in with ChatGPT, then click
**Connect Codex**. The launcher supplies a scratch vault and separate Codex
profile, so there is no manual vault setup, cloning, or worktree-guard
exception. It runs no gardener in the background and makes no paid model
calls automatically. Signing in here is separate from your normal Codex login.

Ctrl+C stops the servers and deletes the preview, including its credentials
and plugin copy. The regular vault and installed agents are unchanged.
`--no-open` prints the URL without opening a browser.

## Connect Codex

Install Codex CLI **0.153.4 or newer**, then open **Settings → Agents → Codex**.
Sign in with ChatGPT and click **Connect Codex**. An API-key login through
Codex's CLI works too. BigBrain uses Codex's own authentication; it does not
copy OpenAI credentials into the vault.

On a new vault where Codex is the first agent, connecting selects the default
model reported by Codex. For an existing vault, choose the curation model in
Vault settings. Claude Code and Codex can both stay connected for search,
notes, and memory preload regardless of which runs curation.

The CLI equivalent is:

```sh
codex login
bigbrain connect --agent codex
```

Start a new Codex thread after installing. Review BigBrain's hooks with
`/hooks` in Codex to enable memory preload. Search/add skills work without hooks.
External chat capture has been retired; plugins no longer upload transcripts.
Previously captured conversations remain in the record. Custom integrations
can explicitly submit material through `/v1/drop`.

Legacy HTTP credentials remain separate. Current plugins use local MCP;
revoking an HTTP token does not revoke local filesystem access.

## Configuration and compatibility

The persisted selection is:

```yaml
curation:
  agent: codex
  model: YOUR_CODEX_MODEL_ID
```

For Claude, use `agent: claude` with an alias or model ID. Existing
`gardener.model` and `memory.model` values still work until a shared selection
is saved. If they differ, the UI explains that and waits for an explicit
choice. `curation` then takes precedence for both passes; the old fields are
retained for compatibility. Their intervals and other settings stay intact.
The legacy `auth: max|api` setting applies only to Claude.

Codex runs through the local `codex app-server` protocol. A machine run has
an ephemeral thread in a scratch directory, a permission profile denying
direct vault access, and a small set of BigBrain tools. The gardener uses
the existing intake/assertion handlers. Memory gets mediated reads and
Markdown writes under `memory/`, with traversal and symlink checks. Existing
memory validation, budget enforcement, scope checks, and rollback still run.
Inherited MCP servers, plugins, hooks, shell, web search, and other unrelated
capabilities are disabled. Machine thread IDs are registered before work
starts so they cannot become captured owner conversations.

Codex token usage is journaled with its agent and model. When Codex does not
report dollar cost, that value is unknown, not zero; economic totals identify
those runs. Claude's subscription meter remains specific to Claude.

## Shared plugin sources

Edit `clients/shared/skills/`, `clients/shared/scripts/`, and
`clients/shared/hooks/`, then run:

```sh
bun run plugins:build
bun run plugins:check
```

`bin/build-agent-plugins.ts` renders both committed plugin packages. The
shared source owns the MCP search/save recipes, local launcher, and bounded
memory preload. Small adapters own manifests, MCP registration, and hook paths.
There are no HTTP shell scripts or special shell-approval hooks.

The Codex package includes its local marketplace at
`clients/codex-plugin/.agents/plugins/marketplace.json`. Both packages ship
inside the desktop engine bundle. CI checks generated content and removed
source files for drift. Bump the generator's plugin version when changing
shipped behavior, and update the Claude content pin in
`test/pluginVersion.test.ts`. Do not edit generated skills or scripts.

Development worktrees deliberately cannot repoint the user's installed
plugin. Test installation with a disposable `CODEX_HOME`, or install after
merging into a stable checkout. This preserves the existing Claude worktree
guard.

## Validation

`bun test` covers config compatibility, isolated credentials, generated
MCP round trips through a scratch vault, retired-capture compatibility,
revocation, and bounded machine tools. `bun run typecheck`, `bun run lint`,
and `cd web/ui && bun run check` cover engine and UI code.

With Codex installed, run:

```sh
BIGBRAIN_TEST_CODEX=1 bun test test/codexProtocol.test.ts
```

This uses the actual CLI with a disposable Codex home, dummy authentication,
and a loopback mock Responses endpoint. It verifies mediated memory writes,
refusal of direct vault edits, disabled inherited MCP servers, and unknown
cost reporting without a paid model call. It does not validate a live
ChatGPT OAuth callback or the quality of a live curation pass.

Protocol references: [app-server](https://learn.chatgpt.com/docs/app-server),
[authentication](https://learn.chatgpt.com/docs/auth),
[skills](https://learn.chatgpt.com/docs/build-skills),
[plugins](https://learn.chatgpt.com/docs/build-plugins), and
[hooks](https://learn.chatgpt.com/docs/hooks).
