# packages/agents

Runs each desktop's agent: a pi session that works in the person's projects,
in place by default, with its own git worktree when it asks for one. It knows
nothing about vaults. BigBrain (the host) decides who the agent is
(instructions, host tools, the model and its credentials) and keeps the
record. Design: `docs/design/coding-desktops.md`.

```
~/bigbrain/                 BIGBRAIN_WORKSPACE overrides; the agent's working folder
  projects/<name>/          the person's projects: agents work here in place
  desktops/<id>/<name>/     a desktop's worktree (start_work), on branch desktop/<id>
  .agents/<id>/             events.jsonl, pi sessions, worktree records
  .agents/leases/           which desktop is editing which project in place
```

| Module | Job |
|---|---|
| `workspace.ts` | Folders, the project list, leases on in-place edits |
| `worktree.ts` | `start_work`: `git worktree add` from the project's repo, plus clones of ignored dependency folders and env files (any depth; venv shebangs rewritten); Land and Discard |
| `harbor.ts` | The shell: each command a job of the desktop's guest, in its own process group; returns early once it listens; finds servers by the job's ports; stops by group, TERM then KILL. Spawns nothing itself |
| `guests.ts` | Where a desktop's files and commands run. `LocalGuests`: `bigbrain-guest --serve` per desktop, confined by the sandbox, replaced when what the desktop may change changes (the old one drains its jobs). The person's login environment minus the host's `BIGBRAIN_*`, tagged `BIGBRAIN_AGENT_DESKTOP=<id>`; lsof/ps discovery for busy ports and the sweep after a restart |
| `guest.ts` | The host's client of the guest protocol (`PROTOCOL.md`): bounded frames, closed schemas, cleaned strings |
| `machine.ts` | One desktop's machine (contained desktops, in progress): its disk, the macOS helper (`packages/vm`), its guest |
| `sandbox.ts` | The sandbox a desktop's guest runs in: a Seatbelt profile (`sandbox-exec`, macOS). Refuses to run anything it can't confine |
| `proxy.ts` | The egress proxy: commands reach beyond this machine only through it, to allowlisted hosts |
| `tools.ts` | `read`, `ls`, `write`, `edit`, `bash`, `stop_job`, `start_work`, relative to the workspace, all through the desktop's guest. No redirection, no command classification; `write` and `edit` never reach a `.git` folder, and `edit` writes only over what it read; `bash` and writes ask the host first, and it hears what each file read or write held |
| `events.ts` | One durable, sequence-numbered event stream per desktop |
| `agent.ts` | `Agents.open(id, { modelRuntime, model, instructions, tools, wrapStream, preface, shell, write, file, untrusted })`, then `send`, `steer`, `stop`, `changes`, `servers`, `snapshot`, `archive`; `Agents.diff`, `Agents.land` and `Agents.discard` |
| `run.ts` | Run a program to completion and collect its output |

The boundary is enforced by lint (`.oxlintrc.json`): nothing here imports
`lib/`, `bin/`, `web/` or `integrations/`, and `tools.ts` and `harbor.ts`
import neither `node:fs` nor `node:child_process`: what the agent names is
opened and run by its guest, never by the engine. The host passes what the agent
needs through `open()`. `wrapStream` lets it attach credentials to each
model request, so the package never holds them.

Commands run as their person, with their environment, inside a sandbox
(`sandbox.ts`) that the host shapes with a `SandboxPolicy`: they write only
the desktop's own folder, its temp folder, projects it may edit in place
(none once it has read untrusted material) and toolchain caches; never a
repository's hooks or config. They can't read what the host denies
(credential stores, its vault), reach the host's ports or other programs'
servers, or reach beyond this machine except through the egress proxy.
The same sandbox confines the desktop's guest, so the file tools are held
to it too. Off macOS there is no sandbox yet, so the guest doesn't start and
the tools refuse. A checkout needs the guest built once (`bun run
guest:build`); the app bundles it. Land shows the
commits and diff first (`diff`) and pushes only the commit reviewed.

Try it: `bigbrain agent run "<task>"` (`bin/agent.ts`), or `⌘N` in v2.

The tests (`packages/agents/test`) build an invented project in a lived-in
state (a tag, another worktree, a stash, uncommitted edits, nested
dependencies, a venv). The fidelity test runs git commands through the
agent's shell and in the checkout, and requires identical answers. Off
macOS the tests run the guest unconfined. Process discovery uses macOS
tools (`ps -E`, `lsof`), so the tests of holders and the restart sweep run
on macOS only, as do the sandbox's (`sandbox.test.ts`), which run real
commands in it. `guest.test.ts` is the protocol's conformance suite;
`machine.test.ts` boots a real machine when asked (`BIGBRAIN_VM_TESTS`).
