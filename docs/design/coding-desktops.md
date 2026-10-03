# Desktops that work on code

Status: proposed (2026-10-03). Nothing here is built yet.

A **desktop** in v2 (`/v2`) is one **agent**: its chat, with views tiled
beside it (`lib/pilotDesktop.ts`). `⌘N` makes a new one. Today a desktop's
agent can read the vault and show notes. This design lets it **work on
code**: edit projects, run commands, start a dev server and show it beside
the chat. It does so without bringing back the brokered workers that #23
removed, and without a regress into designing environments and permissions
first.

The proposal is one new package, `packages/agents` (the name is
provisional). It runs each desktop's agent and the folders it works in.
BigBrain uses it; it knows nothing about vaults. What BigBrain has called
"Pilot" becomes BigBrain's configuration of an agent, not a second chat
engine.

## Vocabulary

| Term | Meaning |
|---|---|
| **Workspace** | The folder BigBrain owns for code: `~/bigbrain/` by default, named in `vault.yaml`. Shared by every desktop. |
| **Project** | A canonical checkout in `workspace/projects/<name>/`. The vault records it as an entity. |
| **Canonical checkout** | A project's one main copy, on its default branch. Agents read it but never edit it; their changes happen in worktrees that branch from it. |
| **Desktop** | One agent with its chat and views, plus its own folder `workspace/desktops/<id>/` once it changes a project. |
| **Agent** | What you talk to on a desktop: a pi session. BigBrain decides what it knows and can do (instructions and host tools); the package runs it. One per desktop. |
| **Attachment** | A project a desktop works on, through its own git worktree inside the desktop's folder. |
| **Server** | A long-running process an agent started in a worktree, such as a dev server. |
| **Host tools** | Tools BigBrain hands an agent: vault search and read, `open_view`, `notify_user`. |

"Pilot" leaves the vocabulary: the v2 UI and these docs say **agent**. Code
names (`lib/pilot*`, `/api/pilot/chat`, the `pilot-…` ids of saved
conversations) change when the agent moves onto the package (phase 5), so
saved conversations keep opening.

```
~/bigbrain/
  projects/                 canonical checkouts; BigBrain owns this organisation
    orrery/
    tide-tables/
  desktops/
    7f3a9c/                 a desktop's folder, named by a stable id; the agent's cwd
      orrery/               a git worktree of projects/orrery on branch desktop/7f3a9c
  .agents/                  the package's own state: per-desktop event logs, pid files
```

Folders are named by the desktop's stable id. Titles change (Quick re-names
them, and so can you), and the title is only a label.

The vault keeps the record, and the workspace keeps the working copies.
Code never goes inside a vault. A vault is a code-free content repo that the
engine commits to and backs up. Nesting checkouts there would put private
code into its history, and a large tree would flood its watcher.

## Why a separate package

- **Its hard problems are its own.** They are filesystem and process
  problems: a half-made worktree, a branch checked out in two places, a
  dirty tree at archive time, an agent that died mid-edit, an orphaned
  server still holding a port, two desktops racing on one project. None of
  them touches the gardener or the graph. They deserve their own tests and
  their own fixtures.
- **Conversation is an application, not the engine** (design principle 4).
  The package is that application layer's runtime.
- **One runtime, not two.** Coding desktops and today's knowledge-only
  desktops need the same machinery: turns, queueing, steering, streaming, a
  durable event log, and resuming after a restart. Two copies would mean two
  sets of reconnect and queue bugs, and a UI that talks to both.
- **It is the only code that runs shells.** Keeping it small and separate
  makes it the one place to review for safety.

It lives in this monorepo as `packages/agents/`, with its own
`package.json`, README and tests. A lint rule forbids it from importing
`lib/`, `web/` or `bin/`, so the boundary holds. If it proves general,
extracting it later is easy. Root `bun run lint` names the new directory
explicitly (see CLAUDE.md, Linting).

## Projects

- A project is a folder under `workspace/projects/` holding a git checkout.
  BigBrain records each one as a vault entity: its folder, remote, purpose,
  and which desktops worked on it.
- **Adopting an existing checkout** means moving it in and leaving a symlink
  at the old path, so tools and sessions still pointing there keep working.
  A repo with a remote can instead be cloned fresh. Never copy a checkout
  that other sessions are using: a copy would drag their worktrees along.
- The canonical checkout stays on its default branch, and desktops branch
  from it. Who updates it (`git fetch`, fast-forward) is an open question
  below.

## Attaching projects

**Reading is free; writing attaches.** An agent can read anything under
`workspace/projects/`, so "how does the orrery compute ratios?" just works,
and you never declare projects up front. The first time the agent writes to
a project or runs a command in it, the package **attaches** that project:

1. Create the desktop's folder if needed, then the worktree
   `desktops/<id>/<project>` on a new branch `desktop/<id>` from the
   canonical checkout's `HEAD`.
2. Emit `project.attached`. BigBrain records it on the project entity.
3. Continue the write in the worktree, never in the canonical checkout.

Writes through pi's file tools (`edit`, `write`) are guarded by a
`tool_call` hook. A path inside `projects/<name>/` triggers attachment, and
the write is redirected to the same relative path in the desktop's worktree.
The agent's instructions also say to work under its desktop's folder once a
project is attached. A desktop can attach any number of projects, and each
one is the same shape: one worktree in the desktop's folder. A desktop that
never changes a project never gets a folder.

## A desktop's folder over time

The folder is disposable; the work never is.

| What | Where | Lifetime |
|---|---|---|
| The conversation and views | BigBrain's session store, then filed into the vault | Permanent |
| The work | Commits on branch `desktop/<id>` in each project it touched | Permanent, part of the project's history |
| The working copies | `workspace/desktops/<id>/`, one worktree per project | Temporary; rebuilt from the branch when needed |

Cleanup follows the lifecycle desktops already have: active, dormant after
ten idle minutes, filed away after a day, or archived by you.

- **Active or dormant:** the folder stays, so picking it back up is instant.
- **Archived or filed away:** for each attached project,
  1. commit uncommitted changes to the desktop's branch as a work-in-progress
     commit, so nothing is lost;
  2. stop its servers;
  3. remove the worktree.

  Once every worktree is gone, the folder goes too.
- **Reopened:** recreate each worktree from its branch, and carry on.
- **Branches:** a desktop branch merged into the default branch is deleted
  automatically. Unmerged ones are listed on the project entity, so you can
  review or drop them.
- **Strays:** on startup, any folder whose desktop no longer exists gets the
  same treatment, followed by `git worktree prune`.

States the package must recover from, each with a test:

- **The worktree folder is missing** because someone deleted it by hand.
  Recreate it from the branch, or report that it can't.
- **The branch is checked out elsewhere,** for example in the canonical
  checkout. Refuse the attach and say where it is checked out.
- **The canonical checkout is dirty.** Attaching still works, because
  worktrees don't share a working tree. Report it, because it usually means
  something wrote to the canonical checkout directly.
- **The agent died mid-edit.** On resume, the worktree is the truth. Report
  its dirty files before the next turn.
- **Two desktops attach the same project.** Each gets its own branch and
  worktree, so they cannot collide.

## Agents

- **The engine is pi, through its SDK** (`@earendil-works/pi-coding-agent`,
  already a BigBrain dependency; see `lib/run/piSession.ts`). Each desktop's
  agent has a persistent `SessionManager` file, so it resumes after an
  engine restart.
- **Turns:**
  - `send` starts a turn, or queues one if a turn is running.
  - `steer` redirects the running turn (pi's `steer()`).
  - `stop` aborts it (pi's `abort()`).
  - Every input carries a client `inputId`, so retries are safe.
- **The host supplies identity and credentials.** `open` takes the model
  runtime (BigBrain keeps model connections and credentials; the package
  never holds them), the instructions, and the host tools.
- **The package supplies the working tools:** pi's file tools and shell,
  scoped to the desktop's folder, plus `serve` (below).

### What this is not

Pi's own security guide says it plainly: a working folder "does not prevent
commands from accessing other paths", and watching transcripts or reviewing
changes "do not create a security boundary". The same holds here. Agents
run as you, like `pi` in your terminal or Ficus's `host` runtime.

The attach-on-write rule prevents **accidents**, such as writes landing in
the canonical checkout or two desktops clobbering each other. It is not a
sandbox: the shell can still write anywhere you can. Where commands run is
one swappable piece inside the package: on this Mac today, and a container
or VM per desktop later, mounting only that desktop's worktrees, when a
project warrants it. A "confirm before shell commands" setting can come
before that.

## Servers

- **Starting:** `serve({ project, command, port? })` starts a long-running
  command in the project's worktree. It waits for a loopback port to accept
  connections, then emits `server.started` with a `http://localhost:<port>`
  URL. The desktop can show it as a web view, embedding loopback addresses
  only.
- **Supervision:** the package owns the process group and records a pid
  file under `.agents/`, then:
  - polls health and emits `server.health`;
  - keeps a bounded log;
  - kills the process group on `stopServer` or when the desktop winds down;
  - on startup, sweeps orphans whose desktop no longer exists.

## The interface BigBrain uses

Designed backwards from what a desktop must show and do.

```ts
open(desktop, { model, tools: HostTool[], instructions })
send(desktop, text, { inputId })          // queued when busy
steer(desktop, text)
stop(desktop)
answer(desktop, questionId, text)
snapshot(desktop)                         // everything needed to draw it after a reload
events(desktop, sinceSeq)                 // replay missed events
changes(desktop)                          // per project: branch, ahead/behind, dirty files, diffstat
diff(desktop, project, path?)
servers(desktop) / stopServer(id) / logs(id, tail)
paths(desktop)                            // worktree paths, for "Open in editor / Terminal"
closeCheck(desktop)                       // what winding down will commit, stop and remove
close(desktop)                            // wind down: commit, stop, remove (see above)
```

One ordered event stream per desktop, sequence-numbered and persisted:

| Event | What it drives |
|---|---|
| `status`: idle, working, waiting, failed, stopped | The desktop's glyph in the bar and the activity line |
| `message.delta` / `message.done` | Streaming text in the chat |
| `tool.start` / `tool.end`, each with a plain label ("Edited ratios.ts", "Ran tests: 42 passed") | Readable activity. The UI never parses pi's tool calls. |
| `project.attached` | "Now working in orrery", and the vault record |
| `changes.updated` (debounced) | A live "3 files changed" summary per project |
| `server.started` / `server.health` / `server.exited` | Offering the dev server as a view, and dead-server indicators |
| `question` | The desktop asking you, plus a notification |
| `error` (kind, recoverable) | A clear message, and resume when recoverable |

Guarantees:

- **Nothing is lost on reload or restart:** events replay and agents resume.
- **Work is never discarded:** winding down commits before it removes
  anything, and `closeCheck` says what it will do.
- **One turn at a time per desktop,** and every command is safe to retry.
- **Servers bind to loopback,** and their URLs come back ready to embed.
- **Not exposed:** pi's objects, raw shells, or any way to write outside an
  attached worktree through the file tools.

## Today's agent code, split

What BigBrain has called Pilot splits along this line.

**The machinery moves to the package:** turns and transitions
(`pilotTransitions.ts`), persistence (`pilotChatPersistence.ts`), the
provider conversation and transcript (`pilotConversation.ts`,
`pilotTranscript.ts`), lifecycle timing (`pilotLifecycleConfig.ts`), and
running pi (`lib/run/piSession.ts`).

**What the agent knows and can do stays in BigBrain:**

- the instructions;
- vault tools (`pilotAccess.ts`), context and mentions;
- notifications, Quick naming (`pilotTaskName.ts`), and filing finished
  conversations into the vault (`pilotChatIngestion.ts`);
- categories, the desktop's views (`pilotDesktop.ts`), and the HTTP routes.

These lists are a starting map; the extraction verifies each file.

A knowledge-only desktop is then an agent with no projects attached. A
coding desktop is the same agent once it has changed a project.

Today's agent code is load-bearing, so the move is staged. Coding desktops
ship on the package first. Existing desktops move only once the runtime has
proven itself, and saved conversations keep opening throughout.

## Phases

1. **This document and its issue.**
2. **Package core:** workspace, projects, attach-on-write worktrees, and
   agents. Add a CLI first (`bigbrain agent run <project> "<task>"`), so it
   is used on real work before any UI. Tests run against scratch repos with
   the scripted pi provider the suite already uses.
3. **Servers and durable events:** `serve`, supervision, winding down,
   orphan sweeps, and event replay.
4. **Coding desktops in v2:**
   - project entities in the vault;
   - a loopback-only `url` view kind, which means opening the engine's
     `frame-src` to loopback addresses only.
5. **Existing desktops move onto the package,** and code names drop
   "Pilot".
6. **Later, if wanted:**
   - a sandboxed runtime per project;
   - agents that start helper desktops for sub-tasks, where a manager
     becomes meaningful. Ficus's `packages/shared/src/workflow-runtime.ts`
     is worth porting then.

## Open questions

- **Updating the canonical checkout:** does the package fetch and
  fast-forward the canonical checkout, or leave that to you?
- **Shell writes:** can the shell's writes to a canonical checkout be
  caught cheaply, for example by checking `git status` after each command,
  or are they only reported?
- **Filing coding transcripts:** coding transcripts can contain code and
  secrets from projects. Should filing them into the vault be opt-in per
  project, as Ficus's conversation export is?
- **The package's name:** `agents` is provisional.

## Prior art

- **Ficus** (github.com/ficushq/tau, AGPL-3.0, like BigBrain):
  - its `host` runtime ("no sandbox", which its own docs say plainly);
  - per-squad workspace folders with a git worktree per work stream;
  - local deployments: supervised dev servers behind a proxy;
  - a declarative workflow runtime.

  Its manager is a prompt that drives Ficus's CLI over a Postgres-backed
  scheduler, so it can't be lifted out, but the patterns carry over.
- **Claude Code:**
  - projects are implicit: whatever folder you launch in, with each
    project's `CLAUDE.md` loaded as files are touched;
  - isolation is opt-in through worktrees.

  "Reading is free; writing attaches" keeps the first and makes the second
  automatic.
- **#23** removed app-owned workers, which ran other agents in native
  terminals with BigBrain brokering their permissions. Here nothing is
  brokered: one agent per desktop, its folders, and you in its chat.
