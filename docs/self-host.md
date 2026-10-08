# Running BigBrain on your own machine — the runbook

The engine, viewer, intake API, and gardener orchestration run on your
machine. Model requests use your connected provider; there is no
BigBrain-hosted backend. **Support is limited**: this is as-is, with no SLA.

One rule shapes the rest (decided 2026-08-22, #492): **if you run your own
backend you run the frontend too.** There is no hosted UI over your vault.
Remote integrations can use the authenticated HTTP API. Current agent
plugins use local MCP and require access to the vault on the same machine.
See the [architecture guide](architecture.md) for the process and data map.

**The desktop app is the install** (2026-08-31, #645). It carries its own
engine and supervises it; a `--role host` CLI install used to render
launchd/systemd jobs instead, and that path is retired. If you want the
engine without the app, run `bun bin/desktop.ts` from a checkout — the
same supervisor, in your terminal.

## Install

```sh
curl -fsSL https://bigbrain.exe.xyz/install.sh | sh
```

(`site/build.ts` renders that URL into the page and the script; `bigbrain.cool`
points at the same site.) It fetches the current build, checks its sha256, puts `BigBrain.app` in
`/Applications` (or `~/Applications`) and opens it. No sudo. The `.dmg` on
the same page works too, at the cost of one Gatekeeper dialog per version
— the build is ad-hoc signed, not notarized (#576).

On first launch, choose or create a vault and connect a model provider.
From then on the app supervises the engine — quit it and nothing gardens.

## What runs

One supervisor process (`bin/desktop.ts`) owns these services and jobs.
The two HTTP services bind to loopback:

| job | what | when |
|---|---|---|
| `api` | intake + read API, `127.0.0.1:4748`, drop-token auth | always |
| `web` | the viewer, `http://127.0.0.1:4747`, loopback only, this launch's session required | always |
| `tend` | gardener and memory jobs through the selected provider and role-scoped tools | every 5 min; exits in milliseconds when nothing is due |
| `publish` | `git push origin main` — offsite copy, **opt-in** | every 15 min; a no-op with a one-line note when the vault has no `origin` |

plus one tick per enabled integration. The intervals are `CADENCE` in
`lib/desktopSchedule.ts`. A machine that slept gets one catch-up fire per
overdue job on waking, not one per missed interval.

Logs: `<vault>/.state/logs/{api,web,tend,publish}.log`. Every gardener run
is journaled at `<vault>/journal/tend/<month>/<run>.json` with model, auth,
turns, tokens and cost when reported. Unknown cost is retained as unknown.

## Prerequisites

- An Apple-silicon Mac; other platforms are not end-to-end verified. (A
  shared vault for several people runs on a Linux server instead:
  [deploy/shared-vault/README.md](../deploy/shared-vault/README.md).)
- Working git. On macOS, install Apple Command Line Tools with
  `xcode-select --install` and finish its installer before creating a vault.
  Verify `git --version` works; full Xcode is not required. If setup reports
  this prerequisite, finish installing the tools, then choose the folder again.
- A model connection: connect Claude or ChatGPT in the app through embedded Pi,
  or another supported Pi provider. No Claude Code, Codex CLI, or separate Pi
  installation is required. See [provider setup](pilot-providers.md) for
  credential ownership and saved-configuration compatibility.
- A machine that stays awake to tend. Laptops that sleep catch up on wake.

## Say who the vault is about

The app asks this during first run, alongside vault and provider setup.
From a checkout there is no app to ask, so:

```sh
bigbrain whoami --declare "Ada Lovelace"
bigbrain whoami --declare "Ada Lovelace" --alias "Ada" --alias ada@example.org
bigbrain whoami                            # what the record says
```

It matters more than it looks. A personal vault has exactly one subject who
never emerges from the record — named in every meeting and clip, asserted by
none of them. Until someone says who, the gardener is handed the sentence
"No vault-owner identity labels were supplied" on every run, the graph draws
the self node it exists to hide, and the memory pass re-derives the person
from raw record each time.

The declaration is two immutable log events: your own words as an arrival,
and one assertion citing them. The email comes from the vault's git
`user.email`, else the signed-in Claude Code account, and becomes the
declaration's account id and first alias — asserted, not verified, which on
your own machine is the same grade of evidence. Declaring again is not an
edit: each declaration is immutable, the newest wins, and it says the whole
alias list.

A vault from the hosted era may still carry the editor's answer — an
`entities/` dossier flagged `human_user: true`, with the aliases the record
turned up. Nothing reads that flag any more. `bigbrain whoami` says when the
dossier still holds labels the declaration lacks, and

```sh
bigbrain whoami --adopt-dossier
```

restates the declaration with them folded in — one more immutable event,
the same name and entity; the dossier file itself is left alone.

Declaring again is not an edit. Each declaration stands and the newest wins;
the name becomes an entity label and ids are `hash(label)`, so a changed name
is a new entity. `bigbrain entity supersede` moves the old one's assertions
across.

## Connect your agents to memory

Open **Settings → Connected Clients → New connection**, or run
`bigbrain mcp config`, to get local stdio MCP configuration. Public tools load
memory, search, read notes, and save contributions. Optional Claude Code and
Codex plugins add search/save skills and bounded memory preload.

Model login and external memory access are separate. Current plugins do not use
HTTP tokens or upload conversations automatically. See [agent connections](agent-memory.md)
for setup and [provider runtimes](pilot-providers.md) for the models that run
BigBrain's own jobs.

## Conversation and execution

Pilot reads your knowledge, answers questions, and prepares context. It cannot
launch agents or execute project tasks. Use your own external agent application
for commands, project edits, browsing, and remote work; connect it through
**Settings → Connected Clients** for BigBrain knowledge access.

The former Connected Agents / Agent Orchestration settings and approval cards
have been removed. Existing worker transcripts and operation history remain
readable, with no resume or follow-up controls. See [retired project workers](project-workers.md).

## Connect the browser extension

Pairing (#486): in the viewer, **settings → integrations → PAIR A
BROWSER** shows a ten-minute, single-use code. In the extension's options
page, leave the address at `http://127.0.0.1:4748` (the intake API on
this machine — over a tunnel, forward that port too) and enter the code.
The engine mints the browser its own `person-device` credential, named
`<browser> on <machine>`, which the same card then lists with its last
capture; REVOKE there is the whole of "disconnect". The extension builds
are listed at https://bigbrain.exe.xyz/plugins until the stores carry them.

## Gardening on your connected model

Choose model preferences in **Settings → Models**. Background jobs use the
shared execution contract with role-scoped tools: the gardener submits
validated decisions, and the memory pass writes through mediated memory tools
with scope, budget, and content checks. Retrieved arrivals are reference data.
Provider-specific setup and execution details live in [provider runtimes](pilot-providers.md).

Run a bounded pass by hand with `bigbrain tend --rounds 1`; `--force` can start
a first memory pass. Run journals record provider/model attribution and usage.

## Other machines

- **HTTP integrations**: put a TLS proxy in front of `127.0.0.1:4748`
  ([HTTP setup](../deploy/HTTP.md)) and use a scoped credential. Local MCP
  plugins do not provide a remote-vault transport.
- **The viewer outside the app**: every viewer route needs the session the
  app creates at each launch, kept in `~/.config/bigbrain/viewer-session-4747`
  (owner-only). In a browser on the same machine, run `bigbrain open`. From
  another machine, use `ssh -L 4747:127.0.0.1:4747 <host>`, run
  `bigbrain open --print` on the host, and open the printed link locally
  within a minute; it works once, sets the session cookie and redirects
  to the viewer. The cookie ends when that browser quits, and every app
  launch starts a new session. SSH can connect over a private network such as
  Tailscale. The viewer accepts only loopback Host values and its own
  browser origin; a machine-name or Tailscale-address URL is refused. Do
  not publish it through a reverse proxy or share the forwarded port: a
  session has the owner's authority. Local scripts send
  `Authorization: Bearer $(cat ~/.config/bigbrain/viewer-session-4747)`, and
  for writes `Content-Type: application/json`, including an empty JSON
  object for actions without arguments. The authenticated `:4748`
  integration API has a separate contract and is unchanged.

Report vulnerabilities privately via [SECURITY.md](../SECURITY.md).

## Update

The app updates itself: it checks on launch and offers the new version.
`curl -fsSL https://bigbrain.exe.xyz/install.sh | sh` again does the same
thing by hand.

From a checkout, `git pull && bun install && bun run web:build`, then
`bigbrain install` — which no longer loads anything, but refreshes the
vault's generated files (`CLAUDE.md`, `.claude/`, `.gitignore`), points
`~/.local/bin/bigbrain` at that checkout, and warns when `web/ui/dist` is
stale. On a machine running the app, the app owns `bigbrain`: every launch
rewrites the command as a shim running the engine inside the app, and
`install` leaves that shim alone (`desktop/README.md`, "Which engine
runs").

### Upgrading an install from before the rename (2026-08-27)

The engine was born as `s-tier`; everything is `bigbrain` now — `BIGBRAIN_*`
env vars, `~/.config/bigbrain/`. The engine read the old names for one
release; that ended 2026-09-03. An install that still carries them exports
`S_TIER_*` in a shell rc and keeps its stores under `~/.config/s-tier/`:
rename the exports, move the directory, and run the one-liner again.

### Upgrading an install from before 2026-08-31

If you ever ran `bigbrain install --role host`, that machine still has
launchd jobs (or systemd units) nothing owns. They will fight the app for
`:4747` and `:4748` and double-run the gardener. Remove them once:

```sh
for j in api web tend publish granola email agent-chat; do
  launchctl bootout "gui/$(id -u)/com.bigbrain.$j" 2>/dev/null
done
rm -f ~/Library/LaunchAgents/com.bigbrain.*.plist
# Linux: systemctl --user disable --now 'bigbrain-*' && rm -f ~/.config/systemd/user/bigbrain-*
```

`launchctl list | grep bigbrain` should then print nothing.

## Backup

Back up the entire vault directory, including ignored files (Time Machine,
restic, or another file backup). In particular, git does not contain
**`.blobs/`** (raw PDFs, transcripts, and clips), **`.spool/`** (pending
integration arrivals, polling checkpoints, conversations, worker state, and
application action receipts), or **`.env`** (local
credentials). Git history alone does not restore a complete vault. Quit the app before making
a consistent recovery copy or rebuilding caches. Preserve `.spool/` unchanged:
receipts prevent duplicate effects, and interrupted actions may remain uncertain.
Restoring history is not permission to replay them. Pi credentials live separately
in `~/.pi/agent/auth.json` (or `PI_CODING_AGENT_DIR`); reconnect subscriptions if
restoring onto a new machine. Machine settings and the vault pointer are outside
the vault too. See [action recovery](application-actions.md).

`.state/` holds rebuildable indexes and ephemeral process state. Memory's
schedule and observed-event checkpoint recover from `journal/memory/`.
Starting with 0.2.0, the engine preserves older `.state/stage/` data and
the email checkpoint in `.spool/` on first access; let the updated engine
access staging or poll email before discarding an older cache.

For an offsite copy of the git side, add a private remote and the
`publish` job takes over: `git -C <vault> remote add origin <url>`.

## Uninstall

Quit the app and drag `BigBrain.app` to the trash, then:

```sh
rm -f ~/.local/bin/bigbrain ~/.config/bigbrain/vault ~/.config/bigbrain/telemetry.json
rm -rf ~/.config/bigbrain/tokens ~/.config/bigbrain/client-tokens.json ~/.config/bigbrain/reads
claude plugin uninstall bigbrain@bigbrain
```

The vault directory is yours and is left alone.

## What leaves the machine

- Model requests → your selected provider: prompts, selected evidence, and
  tool results for gardener, memory, Quick briefings, and Pilot. The scheduled
  gardener makes no model request when nothing is due.
- Enabled integrations contact their own services; provider read-state actions
  can update those services when explicitly requested.
- The app's update check → wherever it is published, on launch.
- `git push origin main`, if and only if you configured an origin.
- Optional usage and performance summaries → PostHog US, only after you
  enable sharing in Settings → Diagnostics. Sharing defaults off. Reports
  contain numeric summaries and a random installation ID, never vault
  content, prompts, queries, paths, or logs. Opting out clears unsent
  reports and stops future delivery; it does not delete reports already
  delivered. See [the telemetry specification](performance/telemetry.md)
  for fields, retention bounds and measurement limits.

Reviewed against engine `38b78005` on 2026-09-26.

## Known gaps

- macOS only: the app has no Linux or Windows build, and `bun
  bin/desktop.ts` on Linux is unexercised on the assertion-native
  substrate.
- Acceptance for this runbook is a stranger completing it on a clean
  machine without asking; that has not happened yet.

## Integration activation and remembering

Email, Granola, and That Tracks require activation in Settings → Integrations:
save credentials first, check account access, then activate. Existing saved credentials alone do not count as consent.
After upgrading to this contract, previously enabled integrations need this
one-time activation; their credentials, cursors, pending material, and already
admitted evidence remain intact. Changing account credentials/settings requires
a fresh access check and activation.

Pollers stage material; it is admitted unless the worth gate passes it
(`gate:` in vault.yaml, `bigbrain gate`). Granola's first poll still starts at
now. Disabling an integration stops new polling and live tool access and
prevents admission of its pending material. It preserves the evidence;
reactivation checks access again.

Pilot uses host-mediated live source tools. Gardener
curates staged and landed material and has no live-account access. Public MCP
uses its own external-client grants. Email is the first live adapter. See [agent connections](agent-memory.md)
for external-client credentials and grants. These grants govern BB's source
credentials, not a connected agent's filesystem, terminal, or native approvals.

## The read log

Every call Pilot or a connected MCP client makes to a live integration tool
(`inbox_list`, `email_search`, `granola_read`, …) is recorded on this machine,
outside the vault: `~/.config/bigbrain/reads/<vault-hash>/YYYY-MM.jsonl`, one
JSON line per call, a file per month (UTC), owner-only (the folder 0700, the
files 0600). `<vault-hash>` is the token store's: the first 12 hex characters
of the sha256 of the vault's path. Files for months that ended more than 90
days ago are deleted as new calls are written. `firsts.jsonl` beside them
remembers each caller's first read of each integration and is not pruned.
`BIGBRAIN_READ_LOG` points the log at another folder.

A line records when the call began; the caller (`pilot` or `token:<id>`) and
its name at the time; the integration, account and tool; the arguments in
summary (at most 20, strings clipped to 200 characters, objects and lists by
their size, refs kept, credential-shaped text replaced with `[withheld]`);
the outcome (`ok`, `refused` or `error`) and the error, clipped and screened
the same way; the duration; for a call that succeeded, the size of what came
back in bytes and items, how many credentials were screened out of it and how
many fresh sign-in messages were held to their headers; whether it was the
caller's first read of that integration; and, for `bigbrain mcp`, the pid and
command name of the program that started it.

It never records what came back (no message, note or transcript text) and
never a token, password or key. Discovery (`integration_capabilities`) is not
recorded. Writing the log never fails a read: when it cannot be written, the
process says so once on stderr and the read goes on.

Settings shows it: each account's **Recent reads** lists its last 50 calls,
marking a caller's first read of the integration, and each connection in
**Connected clients** shows when it last read. Pilot and coding desktops are
denied `~/.config/bigbrain`; other programs running as you can read the log.
