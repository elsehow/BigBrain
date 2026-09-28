# Models, conversations, and workers

BigBrain bundles Pi for all app-owned model work: Pilot, Gardener, memory, Quick,
and orchestrated workers. Pi owns authentication, the model/tool loop, private
transcripts, and compaction. BigBrain owns role tools, public conversations,
source access, permission decisions, and operation receipts.

## Connect and choose models

Choose **Connect Claude** or **Connect ChatGPT** during first run or in
**Settings → Models → New connection**. Sign into your subscription in the browser;
no separate Pi account, Pi installation, Claude Code, or Codex CLI is needed.
The flow supports cancellation, retry, and pasting the callback URL when needed.
Credentials stay in Pi's local store (`~/.pi/agent/auth.json`, or
`PI_CODING_AGENT_DIR`). Tokens never reach the browser UI. Pi handles refresh.

Claude subscriptions use `anthropic`; ChatGPT subscriptions use `openai-codex`.
The vault's OpenAI API key is a separate Pi `openai` connection, applied in memory
without copying it to global credentials. Other authenticated Pi providers appear
in model discovery. Realtime voice remains a separate API for audio.

Recommended role selections resolve against connected models. Pinned selections
remain pinned. Dispatch never silently changes the model, account, or billing.
Claude requires subscription OAuth; changing that connection to an API key stops
work instead of changing billing. Each worker inherits its requesting Pilot's
model unless the authorized project has an explicit model choice.

Quick validates structured output and enforces a host character limit. Pi cannot
enforce a hard API dollar ceiling, so API choices requiring that guarantee are
refused before dispatch. ChatGPT subscription transport cannot enforce a hard
output-token cap; a character bound is available. Subscription tokens do not
represent an API bill.

## Authority

Model choice never grants capabilities. Quick and memory fold proposals have no
tools. Memory synthesis can read evidence and edit only memory Markdown.
Gardener can curate landed arrivals; it has no inherited live-account access.
Pilot has bounded context reads, private scratch, supported app/source actions,
and delegation. It has no general shell or project editor.

[Project workers](project-workers.md) use Pi's built-in file and command tools
through an OS sandbox. Saved project authorization controls project edits,
reference folders, exact network destinations, and selected read-only source
accounts. Only the user grants or expands access. Pilot supplies task context.
Ambient Pi extensions, skills, prompt templates, and project context discovery
are disabled; they cannot change BigBrain's tool or permission contract.

## History and recovery

Saved Claude, Codex, and Responses selections normalize to Pi at the saved-state
boundary. Provider-native model IDs replace old Claude aliases. Reconnect a
subscription when needed; native-client credentials are never copied.

Public messages, attachments, evidence, and action receipts remain readable.
Obsolete private native/Responses continuations are discarded. A provider or
permission-contract change starts a fresh Pi transcript using bounded application
context; old tool effects are never replayed. Native worker histories are archives,
not resumable runtimes. Live workers have a separate small record and lifecycle.
After restart an interrupted operation is uncertain until inspected.

Memory budget and citation checks remain enforced. Recovery follows memory writes
observed by host tools and restores pre-run bytes only while the file still matches
the run's last write. Concurrent edits and unrelated arrivals are preserved. Rename
inspection uses a private Git index; validation does not stage the user's files.
Historical journals, including old quota fields, remain readable.

## Usage and account quota

Reported request tokens and per-role usage are independent of account quota.
Optional quota observations use the exact Pi OAuth identity: direct read-only
provider endpoints, hashed account identifiers, bounded responses, and no native
CLI. Claude observations are cached; their original timestamps remain visible.
These compatibility endpoints can become unavailable. A failed reading never
blocks model work, switches accounts, or produces an estimated subscription share.

## External clients

Connected Clients/MCP remains available for users who explicitly choose external
Claude Code, Codex, or another MCP client. Those clients retain their own execution
and filesystem permissions. Their credentials and revocation are separate from
BigBrain's Pi subscriptions. Explicit local-client setup may invoke that client;
ordinary BigBrain startup, polling, monitoring, and execution do not.

## Verification

The suite exercises actual Pi sessions with scripted provider responses, bounded
role tools, real macOS/Linux worker containment, scope expansion/revocation,
questions, cancellation, restart, and non-replay. A scratch-home smoke test places
failing `claude` and `codex` executables on PATH and runs setup, discovery,
diagnostics, all roles, a file-editing worker, and restart with zero invocations.
Browser tests mount the production AppShell for onboarding and project authorization.
