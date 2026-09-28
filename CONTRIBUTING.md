# Contributing to BigBrain

Development happens in https://github.com/elsehow/BigBrain. Start branches from
this repository's main branch and open pull requests here. Read CLAUDE.md for
architecture, isolated worktrees, and validation commands.

This repository began with a reviewed source snapshot on 2026-09-27. Earlier
private development history and discussions were intentionally not imported.
Historical issue numbers and commit hashes in retained design documents refer
to that earlier history and may not resolve here.

Never merge, mirror, or push the earlier private repository's branches or tags
into this repository. Port unfinished changes as reviewed patches onto a fresh
branch based on public main. Confidential work must also start from public
history; publish only reviewed changes.

Use fabricated fixtures and disposable scratch vaults. Keep real vault contents,
credentials, transcripts, and private debugging evidence outside the repository.
See docs/development-data.md. Preserve existing licenses and third-party notices.

Run the checks appropriate to your changes; bun run ci:checks is the broad
source check, bun run ci:browser covers browser interactions, and sh bin/ci-native.sh
covers the native desktop lifecycle. See the repository verification skill for
isolation requirements. Release through reviewed pull requests and the existing
release tooling; do not import historical release archives.
