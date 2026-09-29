# Models and conversations

BigBrain bundles Pi for all app-owned model work: Pilot, Gardener, memory, and Quick.
Pi owns authentication, the model/tool loop, private transcripts, and compaction. BigBrain owns role tools, public conversations,
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
work instead of changing billing. Pilot retains its selected model for conversation.

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
and knowledge conversation. It cannot launch agents, run commands, or edit projects.

Use your own external agent application for task execution. BigBrain does not
launch workers or broker their permissions. Connected Clients/MCP supplies
knowledge to those applications under separate grants.

## History and recovery

Saved Claude, Codex, and Responses selections normalize to Pi at the saved-state
boundary. Provider-native model IDs replace old Claude aliases. Reconnect a
subscription when needed; native-client credentials are never copied.

Public messages, attachments, evidence, and action receipts remain readable.
Obsolete private native/Responses continuations are discarded. A provider or
permission-contract change starts a fresh Pi transcript using bounded application
context; old tool effects are never replayed. Native and Pi worker histories are
read-only archives. Old access requests and
queued follow-ups cannot resume execution. Interrupted operations are shown as
uncertain; their original records remain on disk. Pending worker reports never
start automatic Pilot turns.

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

The suite exercises actual Pi conversations with scripted provider responses,
knowledge tools, cancellation, and restart. Retirement checks verify that old
execution tools and mutation routes are unavailable, retained worker history is
read-only, and pending reports cannot dispatch a model. Browser tests mount the
production AppShell for settings, archived history, and continued conversation.
A scratch-home smoke test runs app-owned model roles without native CLIs.
