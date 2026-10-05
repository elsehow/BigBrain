# BigBrain

A markdown vault your own agent keeps organized.

**What you get.** Save meetings, clips, papers, files, and contributions
from your agents. Accepted arrivals land in an immutable, append-only log.
A gardener reads what is new and writes **assertions**: one
claim each, in prose, every one citing the arrivals it came from. Those
compose into entity dossiers you can open, search, and argue with, plus
a small working set your agents load at the start of every session. You
can always ask any sentence where it came from.

Select notes in the graph to get a short, streamed **briefing** and descriptions
of their connections through your configured Quick model. Briefings use bounded
evidence samples and cache their results. They are disposable reading aids,
separate from the vault's record.

**Who keeps it.** You do. The engine runs on your machine and uses the
model provider you connect: Claude, ChatGPT, or another supported provider
through embedded Pi. Provider logins use Pi-owned
credential stores. There is no BigBrain-hosted backend; model requests go to your
selected provider. The vault is an ordinary git repo of
plain markdown and JSON — readable, greppable, and yours if every line
of this engine disappears.

**What connects.** Browser clips and YouTube (the extension), Granola
meetings, email, PDFs and files by drag-and-drop, and local agents through
MCP. Other integrations can submit over the authenticated HTTP API.
External agent conversations are saved only through explicit contributions;
automatic Claude Code and Codex transcript capture is retired.

## Get started

```sh
curl -fsSL https://bigbrain.exe.xyz/install.sh | sh
```

That fetches the current build, checks its sha256, and puts `BigBrain.app`
in `/Applications`. No sudo. On first launch, choose a vault and connect
a model provider. From then on the app *is* the engine: it
supervises the intake API, the viewer, and the gardener. Quit it and
nothing tends.

You need an Apple-silicon Mac and a machine that stays awake to tend
(a laptop that sleeps catches up on waking), with working git (Apple Command
Line Tools). Connect Claude or ChatGPT in the app; no native agent CLI is required.

Use **Settings → Models** for provider connections and model preferences.
Use **Settings → Connected Clients → New connection** to give an external
agent access to memory. These are separate connections; see
[provider runtimes](docs/pilot-providers.md) and [local MCP](docs/agent-memory.md).

The full runbook — install, connect your model provider, update, back up,
uninstall, and exactly what leaves the machine — is
[`docs/self-host.md`](docs/self-host.md). Your own colour scheme for the
app is one YAML file — [`docs/skins.md`](docs/skins.md).

## How it works

```
deliberate saves ──────────────► log/insertions/
polled candidates → .spool/ ──► gardener admits or passes
                                      │
                       assertions, declines, corrections
                                      │
five event logs ──► SQLite projection ─┼─► feed, graph, search, dossiers
                                      └─► memory pass → memory/

desktop viewer / Pilot ← shared operations → local MCP / HTTP integrations
```

Two properties hold this together. **The logs are the record**: the
SQLite projection, search index, graph, and dossiers rebuild from them.
The memory pass synthesizes the working set from that evidence.
And **work is a view, not a queue**:
an arrival is "due" exactly when no assertion and no decline cites it
yet, so nothing is enqueued, claimed, or lost, and the same due set
comes back after a crash.

Vault settings live in `vault.yaml`; secrets and machine-specific settings
have separate stores. `bigbrain install` refreshes the vault's generated
files after an engine update. Optional `bigbrain publish` backs up the git
record to your own remote.

The frontend uses the local viewer's HTTP service on `:4747`. A separate
authenticated HTTP service on `:4748` serves extensions and integrations
with scoped, revocable tokens; see [HTTP](deploy/HTTP.md). Current agent
plugins use local stdio MCP. Pilot is the app's conversational layer over
these same vault operations and your connected model.

The [architecture guide](docs/architecture.md) maps the processes, storage,
read/write paths, permissions, and recovery contracts to their code owners.
The [design principles](docs/design-principles.md) explain the decisions.

## Design rules

- **the logs are the record** — indexes, dossiers, and memory derive from
  them; raw payloads and pending arrivals are retained separately
- **every claim cites its evidence** — an assertion with no source is a
  bug, not a shortcut
- **atomic publication** — immutable events cannot overwrite each other;
  mutable files are replaced with complete writes
- **watch-is-a-hint** — filesystem events trigger checks, never carry data
- **writes go through explicit capabilities** — contributions use the intake
  tools; curation uses validated host tools; Pilot commands use its access policy
- **no code in the vault** — the record outlives the software that
  tends it

Secrets go in the vault's `.env` (gitignored; see `.env.example`);
rebuildable caches in `.state/`; pending integration arrivals and their
source checkpoints, conversations, and action receipts in `.spool/`. Back up `.spool/` and `.blobs/` along with
the git record (see [Backup](docs/self-host.md#backup)). The
app is macOS-only; `bun bin/desktop.ts` runs the supervisor from a checkout.
Other platforms still need end-to-end verification. A **shared vault** —
one record several people and their agents use — is the exception that runs
on a Linux server: [deploy/shared-vault/README.md](deploy/shared-vault/README.md).

Licensed [AGPL-3.0](LICENSE).

## Development

This is the active development repository. See [CONTRIBUTING.md](CONTRIBUTING.md)
for the pull-request workflow and the fresh-history boundary.
