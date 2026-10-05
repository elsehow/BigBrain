---
description: Ground a discussion in one BigBrain note using its MCP connection.
argument-hint: <note path or topic>
---

Use the vault-search skill to open `$ARGUMENTS`. If it is a source path, call
BigBrain's `read_note`; otherwise search first and say which result you opened.
Load memory, follow supporting citations, and window long
notes with `q` or dates. Vault paths are tool identifiers, not filesystem paths.
Give a short orientation and wait for the user to steer. Use vault-add only
when there is something worth saving; do not run maintenance.
