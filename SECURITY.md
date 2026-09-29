# Security

## Report a vulnerability privately

Email **security@bigbrain.cool**. Do not open a public issue or pull request
containing exploit details, credentials, or private vault content.

Include the BigBrain version/engine commit, operating system, affected feature,
expected and observed behavior, and minimal reproduction steps using invented
data. Describe the access an attacker needs and the resulting impact. Send
redacted logs only; do not send a vault export, provider key, token, or diagnostic
bundle containing personal material. Coordinate any further evidence privately.

This is a small, experimental project with no guaranteed response or fix time.
Security fixes target current main and the latest release; older releases have
no guaranteed backports. Reproduce on the latest release when practical, but
report suspected vulnerabilities even if an update is not possible.

## Security model

- BigBrain is a single-user application running as your OS account. The viewer
  and first-run server bind to loopback and have no user login. Local programs
  running as your account are trusted. Do not expose these servers through a
  public reverse proxy or share their forwarded ports with untrusted users.
- The separate integration HTTP API uses scoped, revocable bearer tokens.
  Local MCP clients use individual credentials. A memory-reading grant permits
  reading the vault's memory; this is not a multi-user or per-note access system.
- Imported pages, messages, files and model output are untrusted content.
  Sanitized rendering and host-enforced tool permissions provide separate
  protections. Prompt wording alone is not a security boundary.
- Pilot can read the vault and configured folders, with restricted credential
  paths, and write to its own scratch area. It cannot launch agents or execute
  project commands. External agent applications connected through MCP run under
  their own harness permissions; BigBrain does not sandbox their independent
  filesystem, terminal or network access.
- Provider requests send selected content to your configured model provider.
  Local storage, Git history and backups are not encrypted by BigBrain. Protect
  your OS account, disk and backup destinations, and review access before
  connecting agents or integrations.

See [the boundary review](docs/audits/2026-09-25-security-boundaries.md) for
reviewed code paths, checks and remaining limitations. A focused review is not
an independent security audit or a guarantee that all vulnerabilities are known.
