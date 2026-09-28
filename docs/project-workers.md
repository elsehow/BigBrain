# Project workers

BigBrain's workers run through the embedded Pi session service. Connect a Claude
or ChatGPT subscription in Models; no Pi, Claude Code, or Codex CLI installation
is required for app-owned tasks. The requesting Pilot supplies the selected model
and a bounded context packet. Worker tool execution requires the macOS or Linux
sandbox; failure to start it blocks execution.

In **Agent Orchestration**, authorize a project once and choose:

- **Read and propose:** read the project and selected reference folders; write
  proposals in private task scratch. No commands or project edits.
- **Work in this project:** edit files, delete local files, and run commands.
  Git repositories use an independent checkout of committed HEAD. Uncommitted
  source changes are not copied, and nothing is merged or published automatically.
  The task shows the checkout folder for reviewing and applying changes.
  Non-Git folders are edited directly.

Network access defaults off. Exact named domains can be approved for a task or
remembered for the project. These grants permit sending data to those destinations;
local services, private network addresses, host credentials, the vault, and other
workers' scratch remain unavailable. Linux may also supply private temporary
storage; it does not expose writable host temporary directories. Connected source
accounts can be selected separately for read-only host tools, which recheck the
account's current live-access setting and retain credentials on the host.

Pilot can start a task using a saved project or request a new folder. New access
waits in the task card for **Allow for this task**, **Remember for this project**,
or **Decline**. Pilot can answer context questions; only the user can answer task
decisions and grant access. A task without a selected project has private scratch
only. Source text and project instructions cannot create permission grants.

The task card shows scope, working folder, operation outcomes, questions, and
follow-ups. Interrupt stops execution and descendants. Revoking project access
stops affected work; expanding saved access does not silently widen existing tasks.
After app restart, public messages, evidence, and operation receipts remain; no
operation is replayed. Uncertain outcomes need inspection before a new follow-up.
Old native agent conversations are read-only archives.

Linux requires bubblewrap and socat. Ubuntu's AppArmor policy must permit the
sandbox's capability-bearing user namespaces; the application never disables
that policy or falls back to unsandboxed execution. Dependencies are pinned in
the engine package. The macOS and Linux CI jobs exercise actual containment.

## Pilot follow-through

Pilot owns the requested outcome after delegation. On a completed or failed
worker report, it reads the task and results, checks the user's completion
criteria, and can send a concrete continuation to that reporting worker. Report
turns cannot launch another worker or message an unrelated task. Existing action
receipts prevent duplicate delivery; ownership, pending-request, stop, and project
revocation checks still apply. Access and task decisions still require the user.
Reports are evidence, not new authorization: deciding whether a follow-up remains
within the original task is Pilot's responsibility, while worker capabilities
remain bounded by the app's grants.

Status answers should explain whether work is progressing, waiting for the user,
or stopped, and what happens next. A request for user action should name an
available card or control and what it unblocks. Pilot should perform available
preparation first and explain unsupported access honestly, rather than promise a
request it cannot create. It must not claim ongoing execution after work stops.

Regression tests in `test/agentOrchestrator.test.ts` exercise continuation,
receipt reuse, status follow-ups, and access boundaries with scripted models.
They verify orchestration, not natural-language quality. A live-model evaluation
should use invented tasks and check these conversations across multiple turns:

- A document-formatting worker finishes edits but omits requested verification:
  Pilot sends a verification follow-up before claiming work is continuing.
- A worker needs a new source account: Pilot identifies the existing approval
  card and the concrete action required when asked whether the user must act.
- A worker needs unsupported runtime access: Pilot explains the stopped work and
  a supported alternative without inventing an approval control.
- Verification is complete, or a blocker recurs without new evidence: Pilot
  reports the result or actionable blocker rather than repeatedly restarting work.
