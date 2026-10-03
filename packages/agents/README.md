# packages/agents

Runs each desktop's agent: a pi session that works on your projects in its
own folder. It knows nothing about vaults. BigBrain (the host) decides who
the agent is (instructions, host tools, the model and its credentials) and
keeps the record. Design: `docs/design/coding-desktops.md`.

```
~/bigbrain/                 BIGBRAIN_WORKSPACE overrides
  projects/<name>/          home copies
  desktops/<id>/            a desktop's folder and its agent's cwd
    <name> -> ../../projects/<name>     not changed yet: a link
    <name>/                 a fork: an APFS clone of the whole project
  .agents/<id>/             events.jsonl, pi sessions, fork records
```

| Module | Job |
|---|---|
| `workspace.ts` | Folders, project list, and the desktop folder's mirror of links |
| `fork.ts` | `cp -c -R` clone on first change: drops nested worktrees, rewrites venv shebangs, branches `desktop/<id>`, refuses linked worktrees |
| `harbor.ts` | The shell: tags every command with `BIGBRAIN_DESKTOP=<id>` in its own process group, notices when it becomes a server, stops by group (TERM, then KILL) |
| `tools.ts` | `read`, `ls`, `write`, `edit`, `bash`: paths relative to the desktop's folder; a change or command in a project forks it first |
| `events.ts` | One durable, sequence-numbered event stream per desktop |
| `agent.ts` | `Agents.open(id, { modelRuntime, model, instructions, tools, wrapStream })`, then `send`, `steer`, `stop`, `changes`, `servers`, `snapshot`, `archive`, `discard` |

The boundary is enforced by lint (`.oxlintrc.json`): nothing here imports
`lib/`, `bin/`, `web/` or `integrations/`. The host passes what the agent
needs through `open()`. `wrapStream` lets it attach credentials to each
model request, so the package never holds them.

Not a sandbox: agents run as you, like `pi` in a terminal. A fork protects
a home copy from accidents made through the agent's own paths, and a change
to a home copy behind the agent's back is reported (`homecopy.changed`).

Try it: `bigbrain agent run "<task>"` (`bin/agent.ts`).

Tests (`packages/agents/test`) build invented projects in temp folders and
drive a real pi loop on pi-ai's faux model. Forks and process discovery use
macOS tools (`cp -c`, `ps -E`, `lsof`), so those tests run on macOS only.
