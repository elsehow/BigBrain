# Desktops that work on code

Status: proposed (2026-10-03). Nothing here is built yet. The mechanisms
marked *measured* were tested on real projects on one Mac (APFS).

A **desktop** in v2 (`/v2`) is one **agent**: its chat, with views tiled
beside it (`lib/pilotDesktop.ts`). `⌘N` makes a new one. Today a desktop's
agent can read the vault and show notes. This design lets it **work on
code**: edit projects, run tests, start a dev server and show it beside the
chat. It does so without bringing back the brokered workers #23 removed,
and without per-project setup recipes or a permissions regress.

The approach is one new package, `packages/agents` (the name is
provisional), built on two mechanisms:

- **Fork:** each desktop works in a copy-on-write clone of the whole
  project, environment and all.
- **Harbor:** BigBrain runs the agent's shell, so it can see every process
  a desktop starts and find its dev servers on its own.

BigBrain uses the package; the package knows nothing about vaults. What
BigBrain has called "Pilot" becomes BigBrain's configuration of an agent.

## Vocabulary

| Term | Meaning |
|---|---|
| **Workspace** | The folder BigBrain owns for code: `~/bigbrain/` by default, named in `vault.yaml`. |
| **Project** | A git repo under `workspace/projects/<name>/`. The vault records it as an entity. |
| **Home copy** | That folder: the project as you use it, with its branch, `node_modules`, `.venv` and `.env`. |
| **Desktop** | One agent with its chat and views, plus its folder `workspace/desktops/<id>/`. |
| **Agent** | What you talk to on a desktop: a pi session. BigBrain decides what it knows and can do; the package runs it. One per desktop. |
| **Fork** | A desktop's copy-on-write clone of a project's home copy. |
| **Host tools** | Tools BigBrain hands an agent: vault search and read, `open_view`, `notify_user`. |

"Pilot" leaves the vocabulary in favour of **agent**. Code names
(`lib/pilot*`, `/api/pilot/chat`, the `pilot-…` ids of saved conversations)
change when existing desktops move onto the package (phase 5), so saved
conversations keep opening.

The vault keeps the record; the workspace keeps the code. Code never goes
inside a vault: a vault is a code-free content repo that the engine commits
to and backs up.

## The agent's world

A desktop's folder mirrors the projects folder, and it is the agent's
working directory:

```
~/bigbrain/
  projects/                  home copies
    orrery/
    orrery-site/
  desktops/
    7f3a9c/                  the agent's cwd; named by a stable id, titles are labels
      orrery/                a fork: an APFS clone of projects/orrery, everything included
      orrery-site -> ../../projects/orrery-site     not forked yet: a link to the home copy
  .agents/                   the package's state: per-desktop event logs
```

- **Every project appears under its own name.** A project the desktop
  hasn't changed is a link to its home copy, which it can read. That also
  keeps sibling paths working: one tested project's dev server reads
  `../<sibling>/…`, and failed in a clone that had no sibling beside it.
- **Forking happens on first change.** The first time the agent edits a
  project or runs a command inside it, the package replaces the link with a
  fork. The agent's paths don't change: `orrery/ratios.ts` is the same name
  before and after, now pointing at a private copy. Nothing is redirected,
  so there is nothing for the agent to be confused by.
- **The agent never sees a second path for the same project.**

### Fork (*measured*)

A fork is `cp -c -R` of the home copy: APFS `clonefile`, which shares
storage until a file changes.

- **A 7.3 GB Python project with 37,000 files** cloned in 5.9 s, using
  71 MB of new disk. Its tests passed from the clone, against the clone's
  code.
- **A Node site** cloned in 0.3 s. Its tests and build ran unchanged from
  the clone, and its dev server served from the clone once its sibling was
  in place.
- **A fork is a complete repo:** same history, same `origin`, its own
  branch `desktop/<id>`. It has the home copy's `node_modules`, `.venv`,
  `.env`, build output and data. There is no setup recipe, because the
  environment already exists.

Two adjustments, both mechanical:

- **Python virtualenvs carry absolute paths** in the first line of their
  scripts (`#!…/projects/orrery/.venv/bin/python3`). The package rewrites
  that first line in `.venv/bin/*` after cloning. *Measured:* after the
  rewrite, `pytest` in the clone runs on the clone's environment. Don't run
  `uv sync` as a "repair": in the test it made the environment match the
  lockfile exactly and removed `pytest`, which that project installs outside
  its default dependencies.
- **Nested worktrees aren't copied** (such as `.claude/worktrees/`), and the
  fork runs `git worktree prune`. A fork must not inherit other sessions'
  checkouts.

What a fork shares with its home copy is deliberate: it runs as you, with
your `.env`. Disk grows only as the fork diverges (an `npm install` in the
fork is the usual cost). Discard reclaims it.

## Harbor: processes and previews (*measured*)

The package runs the agent's shell commands itself, through pi's tool list
and its `tool_call` hook. Every command runs with
`BIGBRAIN_DESKTOP=<id>` in its environment, in its own process group.

- **Long-running commands return on their own.** If a command is still
  running after a few seconds and a process carrying that tag is listening
  on a loopback port, the tool returns: "still running as job 2, listening
  on 127.0.0.1:5174". The package emits `server.started`, and the desktop
  can show it. The agent just types `npm run dev`; there is no `serve` tool
  to remember.
- **Finding a desktop's servers needs no cooperation.** *Measured:*
  `ps -E` shows the tag on the listening process, and `lsof` maps listeners
  to processes. Processes that hand themselves to launchd escape the tag;
  that is rare.
- **Ports are discovered, not assigned.** Vite, Next and Astro move to the
  next free port by default. A server with a fixed port fails with
  `EADDRINUSE` (*measured*). The package then reports which desktop holds
  the port, so the agent or you can stop that one or change the port.
- **Stopping is by process group, with escalation.** *Measured:* one dev
  server outlived `SIGTERM` to its own pid but stopped when its whole
  process group got `SIGTERM`. The package sends `SIGTERM` to the group,
  then `SIGKILL` after a grace period. Archive and app relaunch stop
  everything carrying the desktop's tag.
- **Previews embed `http://127.0.0.1:<port>` directly** as a loopback-only
  web view, so hot reload works. Routing by `*.localhost` hostname isn't
  used: macOS's resolver and WKWebView don't resolve it.

## A desktop's life

| Verb | Who | What happens |
|---|---|---|
| **Fork** | automatic, on first change to a project | Clone the home copy into the desktop's folder, and branch `desktop/<id>` |
| **Archive** | you, or after a day idle | Stop the desktop's processes. **Files stay.** Reopening is instant |
| **Land** | you | Bring a fork's work home: open a PR from the fork, or fetch its branch into the home copy (`git -C projects/orrery fetch <fork> HEAD:refs/heads/desktop/<id>`) for you to merge |
| **Discard** | you | Delete the desktop's forks |

- **Nothing is committed automatically, ever.** A fork's uncommitted work
  stays in the fork, just as it would in a checkout you left open.
- **Nothing is deleted on a timer.** Forks cost almost nothing at rest, so
  only Land and Discard change what's on disk, and both are your decision.
- The conversation is filed into the vault as it is today. The project
  entity lists its desktops, so forks you haven't landed or discarded stay
  visible.

## Working in the home copy (optional)

For a quick fix you want to watch live in your editor, a desktop can work
directly in a project's home copy instead of forking it, by your choice. It
then holds a **lease**: a second desktop that wants that project gets a fork
instead, and is told who holds the home copy. In the home copy the agent
commits but never switches branches, and a short list of destructive
commands is refused (`git reset --hard`, `git clean -f`, `git checkout --`,
`git push --force`, `rm -rf` of a project root). This is a guard against
accidents, not permission brokering.

Forking is the default. Concurrent sessions in one shared checkout have
destroyed uncommitted work before, and the fork makes that impossible
rather than merely unlikely.

## What this is not

Pi's own security guide says a working folder "does not prevent commands
from accessing other paths". Agents run as you, like `pi` in your terminal
or Ficus's `host` runtime. A fork protects your home copy from accidents
made through the agent's own paths. A shell command can still reach any
file you can, including a home copy through its link, before that project
is forked. The package checks home copies for unexpected changes after each
command and reports them. Where commands run is one swappable piece inside
the package, so a sandbox per project can come later without changing
desktops.

## The interface BigBrain uses

```ts
open(desktop, { model, tools: HostTool[], instructions })
send(desktop, text, { inputId })          // queued when busy
steer(desktop, text)
stop(desktop)
answer(desktop, questionId, text)
snapshot(desktop)                         // everything needed to draw it after a reload
events(desktop, sinceSeq)                 // replay missed events
changes(desktop)                          // per fork: branch, ahead/behind, dirty files, diffstat
diff(desktop, project, path?)
servers(desktop) / stopServer(id) / logs(id, tail)
paths(desktop)                            // fork paths, for "Open in editor / Terminal"
archive(desktop) / land(desktop, project, how) / discard(desktop, project)
```

One ordered event stream per desktop, sequence-numbered and persisted:

| Event | What it drives |
|---|---|
| `status`: idle, working, waiting, failed, stopped | The desktop's glyph in the bar and the activity line |
| `message.delta` / `message.done` | Streaming text in the chat |
| `tool.start` / `tool.end`, with a plain label ("Edited ratios.ts", "Ran tests: 42 passed") | Readable activity. The UI never parses pi's tool calls. |
| `project.forked` | "Now working on its own copy of orrery", and the vault record |
| `changes.updated` (debounced) | A live "3 files changed" summary per project |
| `server.started` / `server.health` / `server.exited` | Offering the dev server as a view, and dead-server indicators |
| `homecopy.changed` | A warning that a home copy changed underneath the agent |
| `question` | The desktop asking you, plus a notification |
| `error` (kind, recoverable) | A clear message, and resume when recoverable |

Guarantees:

- **Nothing is lost on reload or restart:** events replay, agents resume
  from pi's session files, and forks are just folders.
- **Nothing is committed or deleted without you.**
- **One turn at a time per desktop,** and every command is safe to retry.
- **Servers are found by tag and shown from loopback.**

## Why a separate package

- **Its hard problems are its own:** clones, links, process groups, ports,
  and resuming. None of them touches the gardener or the graph.
- **Conversation is an application, not the engine** (design principle 4).
- **One runtime, not two.** Coding desktops and today's knowledge-only
  desktops need the same machinery (turns, steering, streaming, resuming).
- **It is the only code that runs shells,** so it is the one place to review
  for safety.

It lives in this monorepo as `packages/agents/`, with its own
`package.json`, README and tests. A lint rule forbids it from importing
`lib/`, `web/` or `bin/`. Root `bun run lint` names the new directory
explicitly (see CLAUDE.md, Linting).

## Today's agent code, split

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

A knowledge-only desktop is an agent that hasn't forked anything. Today's
agent code is load-bearing, so the move is staged. Coding desktops ship on
the package first, and saved conversations keep opening throughout.

## Phases

1. **This document.**
2. **Package core and a CLI:**
   - the workspace and the desktop folder's mirror of links;
   - fork on first change, with the venv rewrite and nested-worktree
     exclusion;
   - agents, through pi's SDK;
   - `bigbrain agent run "<task>"`, used on real work before any UI.
3. **Harbor:** tagged commands, server discovery, group stops,
   `homecopy.changed`, and durable events.
4. **Coding desktops in v2:**
   - Archive, Land and Discard;
   - project entities in the vault;
   - a loopback-only `url` view, which means opening the engine's
     `frame-src` to loopback only.
5. **Existing desktops move onto the package,** and code names drop
   "Pilot".
6. **Later, if wanted:**
   - working in the home copy, with leases;
   - a sandboxed runtime per project;
   - agents that start helper desktops, where Ficus's workflow runtime is
     worth porting.

## Open questions

- **Large home copies:** on a home copy with hundreds of thousands of files,
  how long does a clone take? Test it before promising "instant".
- **Linux:** filesystems without `clonefile` need a fallback. `cp --reflink`
  works on btrfs and XFS; elsewhere use a worktree plus a setup step.
- **Filing coding transcripts:** coding transcripts can contain code and
  secrets. Should filing them into the vault be opt-in per project?
- **The package's name:** `agents` is provisional.

## Prior art

- **Ficus** (github.com/ficushq/tau, AGPL-3.0, like BigBrain): its `host`
  runtime, per-squad workspaces with worktrees, supervised local
  deployments, and a workflow runtime. Its manager is a prompt over a
  Postgres-backed scheduler, so it can't be lifted out.
- **Claude Code:** projects are implicit, with each project's `CLAUDE.md`
  loaded as files are touched, and isolation is opt-in through worktrees.
  Here, isolation is the default, and it costs nothing.
- **#23** removed app-owned workers that BigBrain brokered permissions for.
  Here nothing is brokered: one agent per desktop, its forks, and you in its
  chat.
- An earlier draft of this document used worktrees with write redirection
  and per-project setup recipes. Forks remove both.
