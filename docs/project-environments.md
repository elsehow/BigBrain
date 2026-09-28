# Project environments

Connected Agents settings owns reusable project environments. A launch for an
unknown folder waits without starting a model. Pilot uses read-only
`inspect_agent_environment` discovery and proposes `launch_agent.environment`
in conversation. The inline card shows the actual requested access and model;
the user can ask for changes, then allow and launch from the conversation.
`revise_agent_environment` replaces a pending initial proposal (and optionally its
model), resolving its old notification and invalidating stale approval buttons.
Proposals and conversational replies never grant access themselves. A missing
token is entered through a dedicated inline password control, not chat.

The task card and settings retain the advanced setup form: inspect the folder and available tools, choose file-only or
development access, network access, command credentials, and a default model.
Save environment and launch approves that task and saves the configuration.
Later tasks select the environment by project ID or its canonical folder.

Existing saved projects keep their previous network policy and credentials (none);
they are never silently widened. New setup forms offer public internet, visibly,
for the user to review before saving. Local/private addresses remain blocked.
Read-file mode cannot run commands; development mode permits edits and commands.
Git tasks use an independent checkout of committed HEAD and preserve a credential-
free origin URL for ordinary repository tools. Non-Git tasks edit the folder directly.

`list_agent_models` exposes the connected model catalog. `launch_agent.model`
overrides the environment default, which overrides the launching Pilot's model.
Pilot validates an explicit choice against that catalog and returns the actual
model identity along with task status. An unavailable explicit choice is an error,
never a silent substitution. The setup card also has the normal model picker.

## Credentials and readiness

The initial version connects **tokens as named command environment variables**,
not service-specific OAuth integrations. For example, GH_TOKEN is usable by gh,
and NPM_TOKEN by tools configured to consume it. The user supplies the token and
is responsible for its account/repository permissions. The app does not infer
repo-scoped authorization from a token name and does not validate arbitrary tokens
against their services. Readiness checks detect installed tools and whether named
credentials are present, without executing project scripts.

Values are stored in `.spool/project-credentials.json`, mode 0600, outside all
worker roots. Project records, worker records, UI reads, and model launch context
contain only names. The host sends selected values to that worker's executor over
its private pipe; other workers do not inherit them. Commands intentionally have
access to selected tokens and can expose them if instructed to print them; this
is not a credential-brokering or redaction system. No ambient shell environment,
login configuration, or credential directory is inherited. Runtime-control
variables cannot be connected as credentials. Connecting stores immediately;
canceling the form does not disconnect an already connected token.

Disconnecting removes the token and its saved grant and interrupts dependent
workers. Deleting an environment revokes its tasks and removes its credentials.
Reconnecting/rotating a token affects future executor starts; it does not replace
an already running process's environment. Settings widening does not widen running
tasks. Access does not authorize publishing, sending messages, or deployment.

## Requests and notifications

Initial setup, later access requests, and user decisions create deterministic,
durable notifications in the owning Pilot, with inline access approval and a link to the task card. Context
questions still go to Pilot for an answer. Notifications deduplicate on restart
without starting a model and resolve when the user answers or cancels the request.
Typing into Pilot or calling resolve_notification cannot approve or resolve an
outstanding worker decision.

## Verification and preview

- `bun test test/workerProjects.test.ts test/agentOrchestrator.test.ts test/workerSandbox.test.ts`
- Set `BIGBRAIN_TEST_PUBLIC_NETWORK=1` for the optional actual HTTPS probe.
- `test/support/projectEnvironment.browser.cjs` exercises the real AppShell and
  setup form using synthetic API data, including model choice, credential setup,
  launch, editing, and deletion.
- `test/support/conversationalEnvironment.browser.cjs` covers conversational scope
  revisions, inline approval, credential input, and decline in production AppShell.
- Add `&environment-chat` to the preview URL and open Atlas planning to try
  conversational setup. The synthetic response to “leave the network off” replaces
  the pending proposal; other text gets the normal sample-vault response.
- `/sidebar-workbench.html?connected-agent=setup` previews the advanced first-run flow.
  Open Agents, enable Show orchestrations, and open Atlas implementation.

The local preview identifies its version, commit, and divergence in its provenance
badge. It never connects credentials or launches a real worker.
