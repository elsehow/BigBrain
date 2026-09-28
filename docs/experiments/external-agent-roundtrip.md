> Historical experiment. The native probe was retired by the Pi-everywhere migration. See [project workers](../project-workers.md) for the shipped contract.

# External agent round-trip experiment

The live Codex experiment succeeded: an external worker asked a separate pilot
for context, the pilot answered from fabricated evidence, and a missing decision
was escalated to a simulated human. A native terminal then attached to the same
running worker, displayed its already-pending approval, and resolved it. BB
observed completion without implementing or answering the approval. A follow-up
typed in that terminal successfully called the pilot again.

This is an opt-in CLI experiment, not a shipped adapter or an app preview. The
pilot here is a separate Codex thread with supplied fixture evidence, not the
production Pilot backend. No real vault is read, no UI has changed, and no
production permission code has been removed.

## Reproduce

Requires Codex installed and logged in. Uses the configured default model with
low reasoning effort; this is real model usage. Tested with Codex 0.155.1 and
gpt-6-astra on macOS, from origin/main `f51f734` on 2026-09-22.

```sh
bun install --frozen-lockfile
bun bin/external-agent-probe.ts --smoke
```

The smoke run uses real pilot and worker model calls, but supplies a clearly
attributed `fixture-human` answer to the escalated question. Omit `--smoke` in an
interactive terminal to answer that question yourself. The script prints its
temporary evidence folder, native session ID, and terminal attachment command.
It fails if the initial task does not exercise both context answering and human
escalation. It also reconnects a second protocol client and sends a follow-up in
the original worker session.

For the native approval and attachment probe:

```sh
bun bin/external-agent-probe.ts --smoke --hold --approval-probe
```

Run the printed `codex resume --remote ... SESSION_ID` command in another
terminal. The worker requests native approval for exactly
`printf probe > approval-marker.txt` inside its disposable workspace. BB logs
the request and leaves it unanswered. Choose the one-time approval or decline
in the native UI. Do not choose a persistent policy amendment for this test.

After that turn, type this in the native terminal:

> Ask the pilot, using ask_pilot, what output format this demo requires. Then
> report its answer.

Watch the callback and answer arrive in the probe's event log while the native
terminal displays the worker's answer. `/exit` detaches the terminal; Ctrl-C in
the probe stops the runtime. Evidence and native session history are retained.
The printed remote command works only while this runtime is alive.

## Observed results

The [recorded evidence](external-agent-roundtrip-evidence.json) contains the
actual fixture conversation and native request-resolution events. Local paths
and unrelated runtime telemetry are omitted. The experiment operator was the
development agent driving the native TUI, not Nick; the one-time approval only
created the disposable marker, whose observed contents were `probe`.

| Check | Observed |
|---|---|
| Worker gets context from pilot | Juniper release name and Markdown format, citing `fixture/project.md` |
| Missing decision reaches human channel | Pilot escalated the unchosen launch date |
| Answer attribution survives delegation | Worker explicitly called the date fictional and from `fixture-human` |
| Second client reconnects | Same worker ID and prior turn history |
| Follow-up retains context | Recalled Juniper and October 1, 2026 |
| Late native terminal attachment | Rejoined the live worker and displayed the already-pending approval |
| Native approval resolves without BB response | Request 2 resolved; marker command completed; BB observed both events |
| Native terminal can keep using pilot | Request 3 reached the original pilot callback and returned its cited answer |
| Terminal exit | Reported detachment with running work continuing on the server |

The key distinction is **attach to the same runtime**, not launch another
process that happens to load the same saved conversation. The CLI supports that
through `resume --remote`. There was no second worker, task replay, or permission
translation during attachment.

## Consequences for the adapter contract

Keep session execution in the external runtime. BB needs a persistent session
handle, event subscription, follow-up/interrupt operations, and a native open
action. The Codex action can identify `attach` semantics and carry an endpoint
and thread ID. Other adapters must declare whether their open action attaches,
resumes, or merely opens a transcript; those are different capabilities.

Give workers an explicit `ask_pilot` tool. Its replies preserve author and
evidence. In this probe, only that tool routes to the pilot. Native requests,
including native questions, remain with the native client: some connector
approvals use question-shaped requests. This avoids inferring authority from
the wording of a question.

The square agent tab can initially display title, destination, observed status,
messages, and Open in terminal. The native runtime can service an approval even
if the terminal opens after the approval was requested. BB only needs to show
that attention is required and provide the attachment action.

## Limits and next implementation slice

- The WebSocket interface is experimental and version-specific. This probe
  binds only to loopback and is not a remote deployment recipe. A shipped local
  adapter should use a private socket or authenticated listener.
- Two clients coexisted on a live runtime. Process-crash recovery, reconnecting
  the tool owner after disconnection, simultaneous steering, and event replay
  after BB restart were not established by this run.
- The runtime lasts as long as this probe. A production adapter needs an
  explicit lifetime owner and must distinguish detaching, interrupting a turn,
  and shutting down the runtime.
- Pilot context is a fixture and its human escalation is a terminal prompt,
  not a production BB notification. The default smoke response is simulated.
- Claude Code, Pi, remote machines, and Tau have not been exercised. Do not infer
  native attachment support from their session-resumption APIs.

The next slice is the Codex adapter connected to a real Pilot callback and the
existing square agent tab, with durable runtime/session references and a native
attachment action. Permission removal comes after that integrated path works.

## Verification

```sh
bun test test/externalAgentProbe.test.ts
bun run typecheck
bun run lint
```

The offline tests cover request routing, native-approval isolation, duplicate
requests, disconnect/cancellation cleanup, attribution, early completion, and
interruption. The live results above establish behavior those fixtures cannot.

Protocol reference: [official Codex App Server documentation](https://learn.chatgpt.com/docs/app-server).
The installed CLI's generated 0.155.1 schema and `codex resume --help` were also
checked before the live run.
