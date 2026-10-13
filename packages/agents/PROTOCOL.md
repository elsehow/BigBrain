# The guest protocol

How the engine talks to `bigbrain-guest`, the agent inside a desktop's
machine (`docs/plans/2026-10-12-contained-desktops.md`). This text is
normative: `packages/guest/` (the guest) and `src/guest.ts` (the host's
client) implement it, and the conformance suite (`test/guest.test.ts`) holds
both to it. Change all three together, and bump `PROTOCOL` when an old peer
would misread the new one.

Protocol version: **1**.

## Transport

A machine's guest listens on vsock port 7470; the host reaches it through
the helper's `guest.sock`. Run as `bigbrain-guest --serve --unix <path>`, the
same guest answers on a Unix socket instead (tests, and the sandboxed mode).

**One request per connection.** The host connects, sends one request, and
reads the answer; the guest closes the connection when the answer is done.
`exec` and `connect` hold their connection for as long as they run.

## Frames

Every byte on a connection, but after `connect`, is a frame:

| field | size | |
|---|---|---|
| kind | u8 | 0 control, 1 stdout, 2 stderr, 3 stdin, 4 data |
| length | u32, big-endian | of the payload |
| payload | length bytes | |

A control payload is one UTF-8 JSON object, at most 256 KiB. Any other
payload is at most 1 MiB. A frame of an unknown kind, or longer than its
cap, ends the connection: the reader stops at the header and never reads or
allocates the payload.

## Requests

The first frame on a connection is the request: a control frame with `op`,
`now` (the host's clock, ms since the epoch) and the op's own fields.
Schemas are closed: a key the op does not name is `bad-request`, as is a
missing one or a value of the wrong type.

Every answer begins with one control frame, `{"ok": true, …}` or
`{"ok": false, "error": <code>, "message": <text>}`.

**Clock.** When `now` differs from the guest's clock by more than a second,
a guest running as PID 1 steps its clock to it before answering. A guest
serving a Unix socket never touches the clock.

**Paths** are absolute, at most 4,096 bytes, without NUL. The guest resolves
them on its own disk, following links. An answer never carries a path, only
names inside a listing.

| op | request fields | answer |
|---|---|---|
| `hello` | `protocol` (int), `tz` (string) | `protocol`, `agent` (version), `image` (string, `""` when unknown), `arch`, `booted` (ms) |
| `exec` | `argv` (1–256 strings), `cwd`, `env` (object, ≤ 1,024 string values, 128 KiB in all), `user` (`"work"` or `"root"`), `stdin` (bool), `grace` (ms, optional) | `job`, `pid`; then stdout and stderr frames as the job writes; then the control frame `{"event": "exit", "code": int\|null, "signal": string\|null}` once the job's leader has exited and both pipes have closed |
| `detach` | `job` | `{}`: the job outlives its `exec` connection |
| `job.stop` | `job`, `grace` (ms) | `{}`, once the job's process group is gone: TERM, then KILL after `grace` |
| `job.list` | – | `jobs: [{job, argv, started, exited: {code, signal}\|null, ports: [int]}]` |
| `job.output` | `job`, `since` (byte offset) | `from`, `to`, then data frames carrying the job's output (stdout and stderr interleaved) between those offsets of its whole stream; the guest keeps the last 256 KiB, so `from` may be later than `since` |
| `ports` | – | `ports: [{port, pid, job\|null}]`: every listening TCP socket |
| `connect` | `port` | `{}`; then the connection is a raw byte pipe to 127.0.0.1:`port` in the guest, unframed, until either side closes |
| `stat` | `path`, `hash` (bool) | `kind` (`file`, `dir`, `link`, `other`), `size`, `mtime` (ms), `mode` (permission bits); `sha256` when `hash` and a file of at most 64 MiB. A link is reported as itself, not followed |
| `list` | `path` | `entries: [{name, kind}]`, sorted by name, at most 10,000; `truncated: true` when there were more |
| `read` | `path`, `offset`, `length` | `size` (the file's), `length` (what follows), `sha256` (the whole file's, when it is at most 64 MiB); then data frames totalling `length` |
| `write` | `path`, `size`, `mode` (optional), `ifMatch` (optional: a sha256, or `null` for "must not exist"), `parents` (bool) | (the host sends data frames totalling `size` right after the request) `sha256` of what was written |
| `shutdown` | – | `{}`; then the guest stops every job and powers off (a Unix-socket guest exits) |

### exec

The command runs in a session of its own (`setsid`), so its process group
is its job. Its environment is exactly `env` on a Unix-socket guest; in a
machine it is a fixed base (`PATH`, `HOME`, `USER`, `LOGNAME`, `LANG`,
`TERM`, `TMPDIR`, `TZ` from `hello`, the proxy variables) with `env` over
it. `user` is `"work"` (uid 1000) unless `"root"`; a Unix-socket guest runs
everything as itself and refuses `"root"`.

With `stdin`, the host's stdin frames are written to the command; an empty
one closes its stdin. Without it, stdin is `/dev/null`.

The guest writes output as it comes and blocks when the host stops reading.
It keeps the last 256 KiB of each job's output for `job.output`, and the
host keeps what it needs of the stream.

When the `exec` connection closes before the exit event, the job's process
group gets TERM, then KILL after `grace` (default 3,000 ms), unless the job
was detached.

### write

The guest writes to a temporary file beside the target and renames it into
place, so a reader sees the old file or the new one. `mode` defaults to the
replaced file's, else 0644. A missing parent folder is `not-found` unless
`parents`. In a machine, what the guest creates belongs to `work`.

`ifMatch` is checked just before the rename. A mismatch, or a file where
`null` asked for none, is `conflict`, and nothing is written. Writes are at
most 256 MiB.

## Errors

| code | when |
|---|---|
| `bad-request` | the request is malformed: unknown op or key, a missing or mistyped field, a bad path |
| `not-found` | the path, or a parent of it, does not exist |
| `is-directory` | a file op on a folder |
| `not-directory` | `list` of a file, or a path through one |
| `too-large` | a read of more than 64 MiB, a write of more than 256 MiB |
| `conflict` | `ifMatch` failed |
| `no-such-job` | the job number is not the guest's |
| `limit` | 64 connections or 64 live jobs are already open |
| `internal` | anything else; the message says what |

The message is the guest's own words. The host treats it as hostile text:
it is cut, stripped of control characters, and never shown to the person
verbatim.

## Limits

Both sides enforce them; the host before it sends.

| | |
|---|---|
| control frame | 256 KiB |
| other frames | 1 MiB |
| path | 4,096 bytes, no NUL |
| `argv` | 256 entries, 1 MiB in all |
| `env` | 1,024 entries, 128 KiB in all (a person's login environment, in the sandboxed mode) |
| `list` | 10,000 entries |
| `read` | 64 MiB |
| `write` | 256 MiB |
| open connections | 64 per machine |
| live jobs | 64 per machine |
| output kept per job | 256 KiB |

## Timeouts (host side)

`hello` answers within 15 s of a machine's start, or the machine is stopped.
Every request's first answer frame arrives within 30 s. `exec` has no
overall timeout.

## Egress

In a machine, the guest also listens on 127.0.0.1:3128 and joins each
connection to vsock port 7471 on the host, which the helper hands to the
engine's egress proxy for that desktop. Nothing is framed on this path: it
is an HTTP proxy connection end to end.
