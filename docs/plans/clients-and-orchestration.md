# Connected Clients and Agent Orchestration

Implementation follows the settled product contract, replacing the older
Connected Agents terminology. This work continues PR #922 from f4edc116 on top
of fetched main beb54dc4 in an isolated worktree. Installed app: dafcebc8.

## Contract

- Settings: General (including models and Pilot), Integrations, Connected Clients,
  Agent Orchestration. Connected Clients heading: Manage access to BigBrain from
  other AI clients.
- A client connection is an authenticated MCP configuration reused across chats,
  not a verified physical device. First supported setup flows: Claude Code and
  Codex; generic configuration remains available. Desktop clients follow later.
- An agent runner configures execution launched by Pilot. An agent session is one
  launched conversation. Native execution permissions belong to the runner.
- Each source type supports separate account instances with independent credentials,
  automatic remembering rules, and a shared live-access switch.
- Live access: Off / On for vault agents, Connected Clients and orchestration.
  Tools describe their read/write effects. Reading or writing does not implicitly
  remember evidence; capability is not task authorization.
- Automatic remembering: independently Off / On with a nonblank natural-language
  rule. Adding a new integration enables remembering and supported live access;
  upgrading or checking an existing account preserves its choices.
- New clients receive vault search/read/contribute and access to enabled live sources.
- Disconnecting accounts or revoking clients retains evidence/history. Stopping
  remembering preserves pending material and rules. Revocation covers BB MCP calls,
  not filesystem authority the client independently holds.
- Existing configuration is read tolerantly without expanded access. Preserve
  credentials, cursors, pending material, logs, and sessions; ambiguous settings
  require review. Unsupported access levels/runner actions stay unavailable.

## Implementation sequence and acceptance

1. Rename orchestration code, UI, and docs while retaining legacy route/settings
   compatibility. Create a separate Connected Clients surface.
2. Split verified account connection, live read/write grants, and remembering policy.
   Exercise two independent email accounts and inactive/changed/revoked states.
3. Authenticate every external MCP call, attribute contributions to verified clients,
   provide Claude Code/Codex/generic setup and last-used/revoke controls. Wire runner
   connections without exposing credentials to model prompts or public sessions.
4. Implement Claude Code as a second runner using capabilities, with context question
   round trips, native approval separation, interruption, follow-up, and restart history.
5. Verify on disposable vaults and production AppShell fixtures, check migration and
   revocation boundaries, commit/push reviewable changes. No production installation
   or real vault writes as part of verification.

## Implemented experiment

The first implementation is on `feat/clients-and-orchestration`, stacked on
`feat/external-agent-sessions` (#922). It includes authenticated client setup,
last-used/revoke/reconnect, independent account policies and credentials, email
read/unread writes, and Codex/Claude Code runner adapters. Public MCP authenticates
every call. Plugins bootstrap a named configuration once; revocation is sticky.
Orchestration configures its own client identity without embedding bearer tokens
in model context or public session records. Old routes and durable session paths
remain readable. The old activation form and standalone MCP configuration card
are removed.

Claude Code uses native settings with no BB approval surface. It supports Pilot
questions during SDK execution, interruption and follow-ups. Terminal opening is
a handoff: SDK execution stops first, the native child is canceled with its Pilot
or when the engine exits, and BB reloads history when the terminal closes. Questions
and approvals during that handoff happen in the terminal. Codex retains live
attachment. This difference is visible in the UI and adapter capabilities.

Validation: 2,058 tests pass; root TypeScript, Svelte checks and lint are clean.
Production UI build passes. Production AppShell browser checks cover client
setup/revocation, two independent inboxes, runner settings and agent navigation.
Previews use synthetic data at version 0.7.27, branch checkpoint 51423ded plus the
follow-up fixes, diverging from main by the #922 experiment and this branch.
The installed desktop remains dafcebc8. No production vault was changed.

A real signed-in native-model task remains a rollout smoke test: automated runner
tests exercise the production adapters through controlled transports, not paid
model calls. Remote runner hosts and Desktop-client-specific setup remain later
capabilities; generic setup here is local. Granola and That Tracks have no live
read/write adapter yet, and correctly expose no such grants.

## Granola MCP follow-up (2026-09-24)

Granola now connects through its upstream MCP endpoint with browser OAuth/PKCE.
Each account owns a private credential and verified account/workspace identity;
changing that identity requires reconnecting. API-key setup and the scheduled
REST poller are retired. Live tools share one account-level on/off switch across
vault agents, authenticated Connected Clients, and orchestrated agents. Client
revocation still blocks every call. Old per-caller records remain readable for
compatibility; saving the new account control replaces those grants.

Automatic remembering remains independent of live access. Its checkbox reveals
the rule; switching it off preserves the rule and staged material. The MCP poller
stages notes and transcripts for the Gardener, preserving speaker labels and
recording context. Live reads never stage or admit evidence. The Gardener triages
staged bodies without a separate live-access grant.

The first poll starts at the present time unless an explicit `--since` is given.
Later polls overlap the previous 48 hours and deduplicate unchanged content;
changes outside that window are not automatically revisited. The observed vendor
list tool has no pagination parameters; incomplete lists fail without advancing
the checkpoint. Checkpoints live under `.spool/integration-cursors`, independently
of rebuildable caches. Provider format changes fail for retry rather than guessing.

Validation: 1,989 tests pass, plus production AppShell browser checks for account
isolation, shared live access, hidden/preserved remembering rules, and removal of
per-client access controls. Root TypeScript, Svelte and lint checks pass; the
production build passes. Real browser sign-in and real tool schemas, meeting notes,
and transcripts were verified; two-account isolation and remembering were tested
with synthetic MCP providers. The signed-in scratch account remains connected with
live access and automatic remembering off; no real meeting was staged.

Preview provenance: desktop version 0.7.27, this experiment based on main
23adb950, running the production shell at localhost:4839. The installed desktop
remains dafcebc8 and is not this preview. Gmail MCP evaluation and That Tracks
MCP support/deprecation remain under #935.

## Setup and source availability follow-up (2026-09-24)

New desktop-created vaults now continue from vault/identity/provider setup to
Integrations and Connected Clients, then finish. The optional steps share the
production settings components, can be skipped by continuing, and persist progress
under `.spool/setup-progress.json`. Existing vaults without this marker do not
re-enter onboarding. Orchestration remains a Settings-only capability. The separate
telemetry choice remains after setup when required by the installation.

Gmail/Google access is deferred by the user. Google's official MCP setup requires
an OAuth client and Cloud project; its documentation still specifies developer
preview membership. Claude's directory lists the same Gmail MCP endpoint, so a
working built-in Claude connection does not resolve the app-registration/eligibility
requirements for BigBrain. BigBrain needs its own OAuth registration, not a Cloud
project per end user; a paid Workspace subscription alone is not the prerequisite.
Gmail is absent from onboarding and new IMAP inbox setup is removed. Existing IMAP
accounts remain available and labelled legacy; data and credentials are preserved.

The user confirmed That Tracks has no MCP yet (support is coming). Its existing
REST accounts remain labelled legacy, with no new-account UI. It is hidden from
fresh vaults. This is deprecation, not deletion of saved data or existing pollers.

Granola's real scheduled smoke passed under `bin/desktop.ts`: the scratch vault
was planned with a 60-second Granola job and recorded an `ok` poll at
2026-09-24T16:41:14Z. No historical backfill was requested. The supervisor was then
stopped and the standalone scratch UI restored. Browser fixtures verify optional
setup navigation, failed saves, reload/resume, back navigation, and completion.

References: https://developers.google.com/workspace/gmail/api/guides/configure-mcp-server
and https://claude.com/connectors/gmail. Gmail remains follow-up #935; setup #934
now has an implementation on this experiment branch. One-click installation of a
Connected Client's configuration is still separate from provider sign-in.

## Four-step wizard study (2026-09-24)

`/setup-workbench.html` is a component-only interactive study: Vault → Providers
→ Clients → Integrations. It reuses the production folder picker with an in-memory
callback and simulates provider connections. Every step waits for an explicit
Next/Skip/Finish action, including vault selection and connecting both providers.
Forward and back navigation use a short directional slide, disabled for reduced
motion preferences. Client access is opt-in through checkboxes. The integration
library offers Browser extension and Granola, with configuration after adding.
Back, Skip, Finish, and Restart are interactive; all connection state is local to the
page. It does not replace production first-run or the Integrations settings screen.
The study uses the user's requested short copy verbatim. Production implementation
still needs real installed-client detection/configuration and the new setup ordering.

Wizard refinements: step headings navigate when vault/provider prerequisites permit
Next or Skip; no connection automatically advances. Client copy is now “Let your
agents to access BigBrain. (This is where the magic happens!).” Adding Granola
starts both Live access and Automatic remembering enabled. This is the intended
default for integrations supporting those capabilities; production defaults have
not yet changed with this component study.

## Production wizard and upgrade behavior (2026-09-24)

The approved study now runs in the production `AppShell` through `FirstRun`:
Vault (including owner identity) → Providers → Clients → Integrations. Every
transition is explicit, including after connecting both providers. Step links
honor prerequisites; directional motion respects reduced-motion preferences.
The separate privacy choice follows when needed. Orchestration remains in Settings.

Clients detects installed Claude Code and Codex. Checking a client installs a
vault-specific stdio MCP entry using that client's CLI, with a private credential
reference rather than a token in the config. Reconnecting replaces only the entry
this vault owns. Other vaults, plugins, and manually configured servers are kept.
The integration library is shared with Settings: Add, then Configure. New Granola
accounts start with remembering and live access enabled; first OAuth sign-in keeps
those choices. Replacing a previously verified account identity still clears access
until reviewed. Browser pairing retains its existing page-capture behavior.

Upgrade requires no content migration or bulk settings rewrite:

- Configured existing vaults without an onboarding marker open directly. No wizard
  is forced on them. Incomplete setup resumes from its saved step; older step names
  remain readable.
- Existing model choices, account policies, client credentials, imported evidence,
  sessions and integration cursors remain in place. The library discovers existing
  accounts and browser pairings without granting access or rewriting them.
- Granola API-key installations need a fresh MCP browser sign-in. Their imported
  transcripts remain in the vault. Existing explicit Off values and custom rules
  are not replaced by the defaults for new additions.
- Existing Email/IMAP and That Tracks accounts retain their legacy controls. Neither
  is offered as a new library integration; Gmail MCP remains deferred under #935.

Verification: 1,994 unit/integration tests pass. Production-shell browser coverage
checks provider connection without automatic advance, client registration,
integration defaults/save, reload/resume, failed-save recovery, legacy account
controls and existing-vault bypass. TypeScript, lint, Svelte and plugin freshness
checks pass. The new first-run browser regression is included in CI. GitHub Actions
currently cannot start because of account billing/spending limits; local checks
do not override the repository's no-red-merge rule.

Candidate provenance: version 0.7.27 on `feat/clients-and-orchestration`, based on
main 23adb950, including the architecture experiment and this production wizard.
The local installed desktop update is explicitly authorized by the user; scratch
vaults and synthetic production-shell fixtures are used for verification.
