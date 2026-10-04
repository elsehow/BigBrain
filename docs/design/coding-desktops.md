# Desktops that work on code

Status: built (packages/agents, #56–#58), and revised after first use (this
version). The mechanisms marked *measured* were tested on real projects on
one Mac.

A **desktop** in v2 (`/v2`) is one **agent**: its chat, with views tiled
beside it. `⌘N` makes a new one. Its agent can read the vault and work on
the person's code: answer questions about it, edit it, run tests, start a
dev server and show it beside the chat. It does so without bringing back the
brokered workers #23 removed.

The runtime is one package, `packages/agents`. BigBrain uses it through host
tools (`lib/agentHost.ts`, `lib/codingDesktops.ts`); the package knows
nothing about vaults.

## The principle: the agent works in the person's world

**An agent sees exactly what its person sees, and anything it does
differently is explicit and visible.**

The first design gave every desktop a hidden copy of a project, created
implicitly the first time a command touched it. On its first real use, a
read-only question ("do we have a worktree for…?"):
- forked two projects behind a bare "Working…", for 46 s;
- answered wrongly, because the copy had dropped the repo's worktree
  records.

The pattern behind it is that any substitute world drifts from the real
one, and a heuristic that decides when to substitute guesses wrong in both
directions. So:

- **Agents work in place by default.** Their working folder is the
  workspace; the person's projects are at `projects/<name>`, their real
  checkouts. Questions, searches and commands see the real state.
- **Isolation is a step the agent takes, not one inferred for it.**
  `start_work(project)` gives the desktop its own git worktree. The step is
  visible in the chat, with its time.
- **No command is classified, and no path is redirected.** The agent works
  where it says it works.

## Vocabulary

| Term | Meaning |
|---|---|
| **Workspace** | The folder BigBrain owns for code: `~/bigbrain/` (`BIGBRAIN_WORKSPACE`). |
| **Project** | A git repo at `projects/<name>`: the person's checkout. The vault records it as an entity. |
| **Desktop** | One agent with its chat and views. |
| **Agent** | What you talk to on a desktop: a pi session. BigBrain decides what it knows and can do; the package runs it. |
| **Worktree** | A desktop's own `git worktree` of a project, at `desktops/<id>/<name>` on branch `desktop/<id>`, made by `start_work`. |
| **Lease** | A desktop's claim on editing a project in place, so two don't edit one checkout at once. |
| **Host tools** | Tools BigBrain hands an agent: vault search and read, `open_view`, `show_page`, `notify_user`. |

```
~/bigbrain/
  projects/                  the person's projects; agents work here in place
    orrery/
  desktops/
    d-7f3a9c/
      orrery/                a worktree of projects/orrery on branch desktop/d-7f3a9c
  .agents/                   the package's state: event logs, sessions, worktree records, leases
```

Code never goes inside a vault. A vault is a code-free content repo that the
engine commits to and backs up.

## Working in place, and leases

The agent reads, searches and runs commands in `projects/<name>` as the
person would. Small, clear fixes can be made in place.

Editing a file there with `write` or `edit` takes that project's **lease**.
If another desktop holds it, the edit is refused with the remedy: call
`start_work` and work in your own worktree. That catches the one real hazard
of working in place: concurrent sessions in one checkout have destroyed each
other's uncommitted work before. Leases are released when a desktop is
archived.

Shell commands can still change anything, as in the person's terminal. The
instructions say to use `start_work` for anything non-trivial. Nothing
pretends to police the shell.

## Worktrees on request (*measured*)

`start_work(project)` runs `git worktree add desktops/<id>/<name> -b
desktop/<id>` from the project's own repo.

- **One repo, so one set of facts.** A worktree shares the repo's database.
  Branches, stashes, tags, remotes and other worktrees are the same on both
  sides, and the person sees `desktop/<id>` in their own repo.
- **It runs immediately.** What git ignores but the project needs is cloned
  in from the person's checkout, at any depth: `node_modules`, `.venv`,
  `venv`, `.env`, `.env.local`, `.envrc`. On APFS this is `cp -c`, which
  shares storage until a file changes; elsewhere it's a plain copy.
- **Virtualenvs are fixed up.** A cloned venv's scripts name their
  interpreter by absolute path, so their first lines are rewritten to the
  worktree's own. Don't "repair" a venv with `uv sync`: in testing it matched
  the lockfile exactly and removed `pytest`, which that project installs
  outside its default dependencies.
- **It's quick.** Starting a worktree of a fixture with nested dependencies
  takes well under 2 s. The test suite holds it there.

## Harbor: processes and previews (*measured*)

The package runs the agent's shell commands itself. Every command runs with
`BIGBRAIN_AGENT_DESKTOP=<id>` in its own process group, in the person's login
environment.

- **The environment is the person's.** Their login shell's environment
  (`$SHELL -ilc env`) is captured once, so commands see the same PATH,
  version managers and exports as the person's terminal. The host's own
  `BIGBRAIN_*` settings are stripped: an agent working on BigBrain itself
  must not run its code as the app, or against the host's vault.
- **Long-running commands return on their own.** If a command is still
  running after a few seconds and a tagged process is listening on a
  loopback port, the tool returns with that address, and the desktop can
  show it (`show_page`).
- **Ports are discovered, not assigned.** A fixed-port collision reports
  which desktop holds the port.
- **Each engine only touches its own processes.** Commands also carry
  `BIGBRAIN_AGENT_SCOPE`, a hash of the workspace. Discovery, stops and the
  restart sweep only touch their own scope, so a developer's scratch engine
  can't stop the app's agents' servers. It did once, before this rule.
- **Stopping is by process group,** SIGTERM then SIGKILL after a grace
  period. Archive stops everything tagged with the desktop. An engine
  restart stops anything tagged, because no agent survives a restart.
- **Pages the agent writes** (`show_html`) are semantic HTML with no CSS or
  scripts. v2 dresses them in the person's live theme
  (`web/ui/src/lib/pageTheme.ts`) and shows them in a frame with no scripts.
  The same style is written to `bigbrain.css` in the workspace and served
  at `/api/desktops/theme.css`, which pages an agent serves itself link: a
  page on a loopback port can't load a `file://` stylesheet.
- **Served pages reload themselves.** Agents are told to serve with a
  server that reloads on change (the project's own, or `npx vite <folder>`),
  so an edit needs no restart and no second `show_page`. BigBrain builds
  no reload machinery of its own.
- **Previews embed `http://127.0.0.1:<port>`.** The engine's CSP allows
  framing loopback pages only.

## What this is not

Agents run as the person, like `pi` in their terminal. That means:
- they have the person's GitHub access (SSH agent, `gh`'s keychain login);
- they can read anything the person's account can;
- the instructions and the Land button shape what an agent does, but they
  don't limit what it can do.

Real limits need a different place to run:
- a container or VM per project, mounting only that project and given only
  the credentials listed for it;
- credentials scoped for agents.

Where commands run is one swappable piece of the package, for when agents
run unattended, on untrusted code, or with narrower credentials than their
person.

## A desktop's life

| Verb | Who | What happens |
|---|---|---|
| **Work in place** | the agent | Reads and commands in `projects/<name>`; edits take the lease |
| **start_work** | the agent | A worktree of the project on `desktop/<id>`; shown in the chat |
| **Archive** | you, or after a day idle | Stops its processes, releases its leases. Files stay; reopening resumes |
| **Land** | you | A worktree's commits come home: a pull request when the project is on GitHub, otherwise its branch, already in your repo, ready to merge |
| **Discard** | you | Deletes the desktop's worktree and its branch |

Nothing is committed automatically, and nothing is deleted on a timer.

## The interface BigBrain uses

```ts
open(desktop, { model, tools: HostTool[], instructions, wrapStream })
send(desktop, text, { inputId }) / steer(desktop, text) / stop(desktop)
changes(desktop)                          // per worktree: branch, commits, uncommitted files, diffstat
servers(desktop) / snapshot(desktop) / events(desktop, sinceSeq)
archive(desktop) / land(desktop, project, how) / discard(desktop, project)
```

One ordered, persisted event stream per desktop:
- `status` and `input`;
- `message.delta` and `message.done`;
- `tool.start` and `tool.end`, each with a plain label. The UI shows the
  running step from `tool.start`, never a bare "Working…".
- `work.started`, with its time;
- `server.started`, `server.exited`, `project.landed`, `work.discarded`
  and `error`.

## Tests that guard the principle

- **Fidelity.** In a fixture project with a tag, another worktree, a stash
  and uncommitted edits, the same git commands give the same output through
  the agent's shell as in the checkout. Each command takes under 2 s. It
  would have caught the first design's bug before a person did: on that
  design, 2 of 5 commands differed.
- **Worktree.** The person sees the desktop's branch, the worktree sees
  their stash and worktrees, dependencies are in place, and their checkout
  is untouched.
- **Leases, path boundaries, Land, Discard, Harbor, the login environment**,
  and a full agent loop: a question answered in place, then a change in its
  own worktree.

## Open questions

- **Filing coding conversations** into the vault (#60).
- **Views of stopped servers** (#61).
- **Linux:** worktrees work as they are; dependency clones are plain copies
  there.
