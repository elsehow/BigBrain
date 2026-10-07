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
| `harbor.ts` | The shell: the person's login environment minus the host's `BIGBRAIN_*`, tagged `BIGBRAIN_AGENT_DESKTOP=<id>` in its own process group, inside the desktop's sandbox; finds servers by tag and port; stops by group, TERM then KILL |
| `sandbox.ts` | The sandbox every command runs in: a Seatbelt profile per command (`sandbox-exec`, macOS). Refuses to run anything it can't confine |
| `proxy.ts` | The egress proxy: commands reach beyond this machine only through it, to allowlisted hosts |
| `tools.ts` | `read`, `ls`, `write`, `edit`, `bash`, `stop_job`, `start_work`, relative to the workspace. No redirection, no command classification; `write` and `edit` never reach a `.git` folder; `bash` and writes ask the host first, and it hears what each file read or write held |
| `events.ts` | One durable, sequence-numbered event stream per desktop |
| `agent.ts` | `Agents.open(id, { modelRuntime, model, instructions, tools, wrapStream, preface, shell, write, file, untrusted })`, then `send`, `steer`, `stop`, `changes`, `servers`, `snapshot`, `archive`; `Agents.diff`, `Agents.land` and `Agents.discard` |
| `run.ts` | Run a program to completion and collect its output |

The boundary is enforced by lint (`.oxlintrc.json`): nothing here imports
`lib/`, `bin/`, `web/` or `integrations/`. The host passes what the agent
needs through `open()`. `wrapStream` lets it attach credentials to each
model request, so the package never holds them.

Commands run as their person, with their environment, inside a sandbox
(`sandbox.ts`) that the host shapes with a `SandboxPolicy`: they write only
the desktop's own folder, its temp folder, projects it may edit in place
(none once it has read untrusted material) and toolchain caches; never a
repository's hooks or config. They can't read what the host denies
(credential stores, its vault), reach the host's ports or other programs'
servers, or reach beyond this machine except through the egress proxy.
Off macOS there is no sandbox yet, so `bash` refuses. Land shows the
commits and diff first (`diff`) and pushes only the commit reviewed.

Try it: `bigbrain agent run "<task>"` (`bin/agent.ts`), or `⌘N` in v2.

The tests (`packages/agents/test`) build an invented project in a lived-in
state (a tag, another worktree, a stash, uncommitted edits, nested
dependencies, a venv). The fidelity test runs git commands through the
agent's shell and in the checkout, and requires identical answers. Process
discovery uses macOS tools (`ps -E`, `lsof`), so Harbor's tests run on macOS
only, as do the sandbox's (`sandbox.test.ts`), which run real commands in it.
