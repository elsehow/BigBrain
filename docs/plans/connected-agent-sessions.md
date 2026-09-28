> Superseded terminology: this document describes the original experiment.
> See [Connected Clients and Agent Orchestration](clients-and-orchestration.md)
> for the settled names and current implementation contract.

# Pilot and Connected Agents

Pilot assembles the context for work, answers questions from the vault, and can ask
the user when the available evidence does not settle a decision. A Connected Agent
(CA) executes the delegated task under its own native configuration and permissions.
Pilot reads the vault and writes only to its private scratch. It contributes via
`drop` or requests changes via `directive`, like other contributors; the gardener
owns vault changes. Pilot access never becomes a grant to a CA.

The agreed settings structure is:

- **Vault → Models:** all models BigBrain runs, including Pilot.
- **Vault → Pilot:** Pilot behavior and optional additional read-only directories,
  such as Downloads and Projects. The vault is read-only; private scratch is writable.
- **Connected Agents:** adapters and their launch location/configuration; local
  Codex first, Claude Code next. Execution permissions belong to those agents.

The Connections panel and Pilot shell/browser/GitHub permission machinery are
removed. Pilot uses narrow file tools (`list_directories`, `list_files`, `read_file`,
`write_scratch`) alongside vault, notification and coordination tools. Any execution
is delegated to a connected agent. Native approvals stay in its terminal.

## First adapter

The Codex adapter starts an authenticated loopback app-server using the installed
Codex executable and the user's native config and login. It supplies `ask_pilot` as
a dynamic tool. Pilot can reply only to that tool's outstanding context question;
all native approvals and native user-input requests stay in the Codex terminal.
Automatic report turns can read context, answer context questions and notify the
user. They cannot launch work, execute commands or mutate vault evidence.

The square CA appears beside triangular Pilots in the graph and Agents list. Its
text tab shows the public conversation, current state, Open in terminal, Interrupt,
and Back to Pilot. Opening attaches `codex resume --remote` to the same live thread;
leaving the tab does not stop it. No native approval response endpoint exists in BB.

The engine owns app-server lifetime. Restarting preserves public history and marks
unfinished work interrupted. It does not replay tasks. Opening an existing agent
resumes its native thread without submitting a turn. Native attachment currently
requires macOS and was checked with Codex CLI 0.155.1. These app-server and remote
attachment interfaces remain experimental. Other adapters and machines are not
yet implemented. Public capabilities currently expose attach, interrupt, follow-up,
status, messages and context questions; private transport credentials stay backend-only.

Sessions live in `.spool/external-agents`, separate from the retired worker archive
and its migration into Pilot. Runtime files and tokens are private local files.

## Verification

The regression tests cover production Pilot launch/context replies, escalation to
a human and resumption, automatic-turn restrictions, native approval separation,
parallel questions, interruption races, durable restart and action route origin
checks. The sample scene is `/sidebar-workbench.html?connected-agent=waiting`;
`test/support/agentOrchestration.browser.cjs` exercises the production AppShell.

A live scratch check with Codex 0.155.1 completed through the production manager:
Codex asked the scripted Pilot callback for a release label and returned `Juniper`.
The Pilot callback was scripted for that protocol check; it was not a human reply.
The earlier experiment in PR #916 separately verified two model threads, native
terminal attachment and a pending native approval handled solely in that terminal.

Pilot file-tool tests verify scratch writes, read-only vault/configured folders,
symlink and hard-link escapes, protected paths, IO bounds, and revoked folders.
Legacy Settings write grants become read-only without requiring moved folders to
exist at migration time. Per-session grants and pending approvals are retired;
saved conversations remain readable. No unrestricted Pilot mode remains.

## Codex settings

Connected Agents → Codex shows installation status, inherits native configuration,
and offers Test connection and Configure Codex. Test connection starts a temporary
native interface, reads account/configuration state, and closes it without a model
turn. It returns only selected public fields, never account tokens, account email,
or raw configuration. An unspecified native setting is displayed as Codex default.
Configure Codex opens its user config.toml in the system text editor on macOS; it
preserves existing contents and creates an empty file only if none exists.

The launch form saves the executable and optional default working folder in BB's
local settings. A task can select a different project folder. New sessions snapshot
the launch settings; existing sessions retain theirs. Settings currently target
this machine and its default terminal. Remote runners and other adapters remain
future work.

Session tabs show Codex-reported sandbox, approval policy/reviewer, permission
profile, network access, and writable roots when available. The adapter listens to
thread/settings/updated so native changes are reflected. Change in Codex attaches
to the same terminal session, where /permissions owns changes and approvals.

Models and Pilot readable folders have separate pages under the Vault group.
Connections is removed from the navigation; its legacy direct route is retained
while the remaining Pilot connector machinery is retired.

Protocol references: [app-server](https://learn.chatgpt.com/docs/app-server) and
[Codex configuration](https://learn.chatgpt.com/docs/config-file/config-basic).
