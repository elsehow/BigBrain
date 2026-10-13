# Contained desktops

Status: plan, 2026-10-12. Supersedes the sandbox sections of
`docs/design/coding-desktops.md` once Phase 3 lands; until then that doc
describes what runs.

A desktop's agent keeps working on the person's code, but everything that
touches project files or runs code moves into a small Linux virtual machine
of its own. The agent loop, the model credentials and the vault tools stay in
the engine. Between the two there is one typed channel that carries bytes and
never a path the host resolves. The only ways out of the machine are the ones
this plan names: Land, previews, the egress proxy and `request_host`.

Vocabulary this plan uses and has NOT been approved (flag for the person): a
desktop's **machine** (the VM behind it), its **copy** of a project (the clone
inside the machine), **Sync** (refresh the copy from the checkout), **contained**
(a desktop with a machine) against **sandboxed** (today's Seatbelt desktop).
"Desktops" stays the user-facing noun; "VM", "container" and "guest" never
appear in copy.

## Why

Today's desktops (`docs/design/coding-desktops.md`, "The sandbox") confine
each shell command under Seatbelt, deny writes by default, read everything
but a denylist, and reach the internet only through an allowlisting proxy.
Its own "What this is not" says the rest: "The allowlisted hosts take uploads
as well as downloads, a trusted desktop writes shared toolchain caches, and
what it commits reaches the person when they land it. Narrower limits need a
different place to run (a container or VM per project, given only the
credentials listed for it)."

The classes that motivate the move, at the level of architecture:

- **Host-side tools that act on agent-chosen paths.** The agent's file tools
  and the host's git run in the engine process, outside any sandbox, on paths
  the agent names. (Phase 0 below is the present fix, tracked separately.)
- **Deny-list reads.** Commands read everything but what the host names
  (`lib/desktopNetwork.ts:32-34`, `lib/workPermissions.ts:16-19`): wrong by
  omission.
- **Allowlisted hosts accept uploads.** The proxy checks host and port, not
  method or path (`proxy.ts:138-143`).
- **Shared caches and in-place writes reach code the person later runs
  unconfined.** A trusted desktop writes `~/.npm`, `~/.cache/uv` and the rest
  (`sandbox.ts:87-91`) and edits `projects/<name>` in place.
- **The login-shell environment passes through** (`harbor.ts:96-114`), less a
  withheld list: a denylist again.

A machine per desktop replaces each denylist with an empty set: no host
folders, environment, network or processes. What comes back out is a small,
typed, reviewed set.

## Decisions

**D1. Backend: Virtualization.framework, through a small Swift helper of our
own.** The app's minimum is macOS 12 (`desktop/src-tauri/tauri.conf.json:38`);
the framework's Linux boot loader, virtio block, vsock, console and entropy
devices are all macOS 11+, on Intel and Apple silicon, and the
`com.apple.security.virtualization` entitlement needs no Apple approval: an
ad-hoc signature carries it (vfkit ships that way). Rejected: *Apple's
Containerization package* (its README requires macOS 26, Apple silicon and
Xcode 26, "older versions of macOS are not supported"; 0.1.0 with stability
only within minor versions; a gRPC/OCI stack we would use a fraction of; its
EXT4 writer and kernel config are worth reading, Apache-2.0); *Docker, Lima,
colima, podman* (separate installs; the app is the install); *the framework
from the Tauri shell through Rust bindings* (the engine must run from a
checkout without the shell, and the entitlement needs a signed binary
anyway); *hardening Seatbelt further* (keeps every class above).

**D2. The helper is a dumb bridge, one process per running machine.**
`bigbrain-vm` boots one VM from a JSON config on stdin, exposes two Unix
sockets, reports state on stdout, and interprets nothing the guest says. A
crash takes one desktop; the supervisor's process-group shutdown
(`bin/desktop.ts`, Lifetime) takes every helper with the engine.

**D3. The guest agent is a static Rust binary, PID 1, booted from an
initramfs.** Rust is already a build requirement (Tauri). Rejected: bun in
the guest (no `AF_VSOCK`, weak process-group control, 90 MB on the boot path);
Go (a third toolchain); systemd (seconds of boot, and an agent would still be
needed). In the initramfs rather than on the disk, a protocol change ships a
new initramfs, never a rootfs, and every desktop boots the agent its engine
expects.

**D4. The guest OS is Debian stable, minimal, with the distro's cloud kernel
and its modules bundled in the initramfs.** glibc, because prebuilt Node,
uv's Python builds and most wheels assume it. Rejected: Alpine (musl friction
for exactly those); stock cloud images booted by EFI (macOS 13+, systemd and
cloud-init on the boot path, no agent injection without a second disk); our
own kernel config with everything built in (no module logistics and a smaller
kernel, but a kernel build in CI on every update and kernel security updates
become ours; Containerization's `kernel/` config is the reference if this is
revisited).

**D5. A desktop's disk is an APFS clone of the base image.** `cp -c` of a
sparse raw ext4 image shares blocks until written. Rejected: overlayfs over a
shared read-only base (pivot logic in init, two devices, and a base update
changes the floor under a live desktop). Non-APFS volumes get a full copy.

**D6. No network device.** Egress is a guest-side forwarder to the host's
existing proxy (`proxy.ts`) over vsock; previews are host-to-guest vsock
forwards. Rejected: a NAT device with host firewall rules (policy on the host
over traffic the guest controls, and the LAN one rule away).

**D7. Projects enter by value.** A git bundle plus files the person ticks.
Nothing is mounted. Rejected: a virtio-fs share of `projects/<name>`, even
read-only (in place again, hooks and secret files included).

**D8. Our own framing: length-prefixed frames, JSON control plus raw data,
one request per connection.** Rejected: gRPC (codegen in three languages),
newline JSON with base64 bodies, ssh (a daemon, keys, a second trust model).

**D9. Taint gates egress, not the shell.** The machine is the containment,
so a desktop that read mail may run commands; what it must not do is send
what it read to an allowlisted host, which takes uploads until Phase 4. A
tainted contained desktop keeps its shell and loses the network: the proxy's
per-connection `hosts(desktop)` (`proxy.ts:60-61`, `lib/desktopNetwork.ts:
90-91`) answers an empty list for it and its open tunnels are closed, until
the person allows it (`allowNetwork`, re-pointed from `allowShell`,
`lib/codingDesktops.ts:374-380`). Phase 4 relaxes that: read-only hosts stay
open after taint. Taint is also shown at Land. `taint.refused` holds the
refused host instead of a command; the `written.jsonl` ledger and the
`shell`/`write`/`file`/`untrusted` hooks of `Agents.open` retire (`:477-552`).

**D10. No suspend/resume in v1.** Saving machine state is macOS 14+; the
spike's boot target (≤ 2 s) makes stop/start enough.

**D11. Today's Seatbelt mode survives only as a labelled weaker mode** for
Macs where the machine is not yet cleared to run (Intel, until its spike
passes) and as a test double. Retiring it outright is the person's call.

## Architecture and the trust boundary

```
engine (bun, host)                          bigbrain-vm (Swift, host)      machine (Linux, one per desktop)
  agent loop, model credentials               boots VZ from a config      bigbrain-guest, PID 1
  vault tools (read-only)                     guest.sock  ─── vsock ───▶  :7470 exec / jobs / read / write / list / stat / ports / connect
  Harbor: jobs, settle, forwards  ──unix──▶   egress.sock ◀── vsock ───   :7471 ◀── 127.0.0.1:3128 (HTTP_PROXY in every command)
  EgressProxy (proxy.ts)          ◀──unix──                               /work/<project>  the copy, on the machine's own disk
  review repos + Land: host git, fsck on                                  toolchains and caches on that disk
  previews: 127.0.0.1:<hostport> ─▶ connect op ─▶ guest 127.0.0.1:<port>  no network device
```

Invariants, each with the test that proves it (Phase 3 unless marked):

- **I1. The engine never opens a path the agent names.** `tools.ts` and
  `harbor.ts` import nothing from `node:fs` or `node:child_process` (an
  `.oxlintrc.json` override beside the one at lines 14-33); `agent.ts` keeps
  `node:fs` for the desktop's own state folder (`agent.ts:14`), whose paths
  the host chooses. The tool suite runs against a recording fake `Guest` and
  every file and shell operation appears in its log. (Phase 1.)
- **I2. Everything from the guest is hostile data.** Frames are bounded
  before they are parsed, control frames validate against closed schemas
  (unknown keys refused), strings are decoded lossily and stripped of control
  characters before they become labels or events. A conformance test feeds
  oversized, truncated, recursive, non-UTF-8 and unknown-op frames and expects
  a typed refusal and a live client. (Phase 1.)
- **I3. No guest string is a host path.** The `Guest` client sends paths to
  the guest and receives none back that the host resolves; response types
  carry no path field, only names inside listings. Review rule, plus I1's lint.
- **I4. The machine has no network device and no shared file system.**
  `bigbrain-vm --dump-config` lists its devices; the test accepts only block,
  vsock, console, entropy and balloon. Inside: `ip link` shows `lo` alone.
- **I5. No host environment reaches the guest.** A command's environment is a
  fixed base (`PATH`, `HOME`, `USER`, `LANG`, `TERM`, `TMPDIR`, the proxy
  variables) plus per-project granted values. A canary variable set on the
  engine is absent from `env` in the guest.
- **I6. Beyond the machine there is only the proxy, and taint closes it.**
  `curl` to any address fails (no route); through the proxy, a non-allowlisted
  host and a private address are refused (`proxy.ts:45-53` tests stay); the
  moment a desktop is tainted its credential reaches no host and its open
  tunnels are closed, until the person allows it.
- **I7. Nothing unreviewed enters the person's repo.** The bundle is
  verified and fetched with `fetch.fsckObjects` into a host-owned bare review
  repo under the desktop's state folder; the commit list and diff the person
  sees are computed there by host git; Land fetches exactly the reviewed sha
  into `desktop/<id>` in the person's repo. The test lands one bundle and
  checks the person's repo gained that ref and its objects and nothing from a
  second, unreviewed bundle.
- **I8. Host-side git runs only in the person's repo, the review repos, and
  on files the host wrote.** Bundles and review repos live under the desktop's
  state folder at host-chosen paths; no host git command takes a
  guest-supplied path.

## The guest interface

Normative text lives in `packages/agents/PROTOCOL.md` (Phase 1 writes it).

**Transport.** `AF_VSOCK`. The guest agent listens on port 7470; the host
reaches it through the helper's `guest.sock`. The guest's forwarder on
127.0.0.1:3128 connects to host port 7471, which the helper bridges to
`egress.sock`, which the engine's proxy answers. Each machine has its own
`egress.sock`, so the proxy knows the desktop from the socket a connection
arrives on, not from a secret the guest holds; the proxy-URL credential
(`sandbox.ts:315-320`) remains for sandboxed mode only. One request per
connection.
The same protocol over a Unix socket is the sandboxed helper of Phase 1.

**Frame.** `kind: u8`, `length: u32 BE`, payload. Kinds: 0 control (UTF-8
JSON, ≤ 256 KiB), 1 stdout, 2 stderr, 3 stdin, 4 data (≤ 1 MiB). Any other
kind, or a length over the cap, closes the connection; the desktop gets an
`error` event naming the op.

**Clock.** Every control frame from the host carries `now` (ms since the
epoch). When it differs from the guest's clock by more than 1 s the guest
steps to it. `hello` is the first step; a machine that ran through the Mac's
sleep is corrected by the next request, whatever it is.

**Requests** (the first control frame, from the host) and what they answer:

| op | request | answer |
|---|---|---|
| `hello` | `protocol`, `tz` | `protocol`, `agent`, `image`, `arch`, `booted` (ms). A protocol mismatch is `machine-out-of-date` on the host. |
| `exec` | `argv` (≤ 256), `cwd`, `env` (≤ 64), `user`, `stdin` (bool) | `job`, `pid`; then kind-1/2 frames as produced, blocking on backpressure (the host keeps the last 200 KB as `harbor.ts:57` does); then `{"event":"exit","code","signal"}`. Closing the connection first kills the job's process group, TERM then KILL after `grace`, unless detached. |
| `detach` | `job` | the job outlives its connection |
| `job.stop` / `job.list` / `job.output` | `job`, `grace` / – / `job`, `since` | – / `[{job, argv, started, exited, ports}]` / data frames from the guest's 256 KiB ring, then `end` |
| `ports` | – | `[{port, pid, job}]`: listening TCP sockets, from `/proc/net/tcp{,6}` and each job's process group |
| `connect` | `port` | `ok`, after which the connection is a raw byte pipe to guest 127.0.0.1:`port` |
| `stat` | `path`, `hash` | `kind` (file, dir, link, other), `size`, `mtime`, `mode`, `sha256` when asked and ≤ 64 MiB |
| `list` | `path` | `entries: [{name, kind}]`, ≤ 10,000 |
| `read` | `path`, `offset`, `length` | `size`, `sha256`, then data frames; whole files only up to 64 MiB |
| `write` | `path`, `size`, `mode`, `ifMatch` (sha256, or null for "must not exist"), `parents` | data frames from the host totalling `size`; then `sha256`. Temp file and rename; ≤ 256 MiB (bundles). `conflict` when `ifMatch` fails. |
| `shutdown` | – | the guest stops every job, syncs, powers off |

Errors are `{"ok":false,"error":<code>,"message"}` with codes `bad-request`,
`not-found`, `is-directory`, `not-directory`, `too-large`, `conflict`,
`no-such-job`, `limit`, `internal`; the message reaches the agent after I2's
filtering, never the person verbatim. **Limits the host enforces before
sending:** path ≤ 4,096 bytes, no NUL; argv ≤ 1 MiB; ≤ 64 open connections
and ≤ 64 live jobs per machine. **Timeouts:** `hello` within 15 s of start,
else the machine is stopped and the desktop told "The desktop's machine did
not start"; a first answer frame within 30 s of any request; `exec` has no
overall timeout (Harbor returns it as a job, `harbor.ts:177-178`).
**Cancellation:** the tool's `AbortSignal` closes the exec connection;
`stop_job` is `job.stop`.

**Today's tools over it** (`tools.ts`): `read` (88-105) is `read`, numbered
on the host; `ls` (107-116) is `list`; `write` (118-132) is `write` with
`parents`, the `.git` refusal kept as a check on the agent's string and
`landing()`'s realpath walk (62-70) dropped, since the guest resolves links
on its own disk; `edit` (134-156) is `read`, the replacement on the host,
`write` with `ifMatch` from the read, and `conflict` becomes "the file
changed; read it again"; `bash` (158-182) is `exec` of `/bin/bash -lc` in
`/work/<cwd>` as `work`, with Harbor's settle/ports/detach loop
(`harbor.ts:162-183`) keyed by guest job ids; `stop_job` is `job.stop`;
`start_work` (195-205) retires (Projects).

**Seams.** `Launcher` (`sandbox.ts:74-76`) assumed the engine spawns the
command; it is replaced by `Guest` (the client) and `Machines` (lifecycle).
`Harbor` keeps its job table, settle loop and port discovery, over `Guest`;
`loginEnv`, `lsof` and `ps -E` discovery and `scopeOf` tags (`harbor.ts:96-114,
194-225`) go. `Agents.open` keeps `modelRuntime`, `model`, `instructions`,
`tools`, `thinkingLevel`, `wrapStream`, `elsewhere`, `preface`; the hooks in
D9 go; `Agents` takes a `Guest` factory at construction. The pi session's
`cwd` (`agent.ts:132,154,192`) becomes the desktop's state folder.
`WORKING_INSTRUCTIONS` (`agent.ts:62-68`) is rewritten around `/work/<name>`.

## The machine image

**Contents.** Debian stable minbase; `git`, `bash`, `ca-certificates`,
`curl`, `ripgrep`, `jq`, `build-essential`, `python3` and `uv`, Node LTS and
`bun`; user `work` (uid 1000, passwordless sudo); the proxy variables and
`NODE_EXTRA_CA_CERTS` et al. in `/etc/profile.d` (Phase 4 fills the CA). No
sshd, no systemd, no agent (D3). Anything else the agent installs with `apt`
through the proxy (`deb.debian.org` joins `DEFAULT_HOSTS`, `sandbox.ts:79-83`,
for contained desktops only).

**Kernel and modules.** `linux-image-cloud-<arch>`, its `vmlinuz` shipped
beside the rootfs. VM-oriented distro kernels build what this plan needs as
modules: Alpine's `linux-virt` 6.12 config has `VIRTIO=y`, `VIRTIO_PCI=y`,
`VIRTIO_CONSOLE=y` and `VIRTIO_BLK=m`, `VIRTIO_MMIO=m`, `VSOCKETS=m`,
`VIRTIO_VSOCKETS=m`, `HW_RANDOM_VIRTIO=m`, `VIRTIO_BALLOON=m`, `EXT4_FS=m`,
`CRYPTO_CRC32C=m`; Debian's cloud config is assumed the same until the spike
reads it. The build resolves the set (`virtio_blk`, `virtio_mmio`, `ext4`
with `jbd2`, `mbcache`, `crc16`, `crc32c`, `vsock`,
`vmw_vsock_virtio_transport` and `_common`, `virtio_rng`, `virtio_balloon`)
with `modprobe --show-depends` against the package's `modules.dep`, copies
those `.ko` files into the initramfs in that order, and writes the order to a
manifest the agent reads.

**Boot (PID 1).** The kernel runs the initramfs's `/init`, the agent, with
`console=hvc0` and no `root=`. It mounts `proc`, `sysfs`, `devtmpfs`, `devpts`
and tmpfs on `/run` and `/tmp`; loads the modules in manifest order with
`finit_module(2)`; brings `lo` up; mounts `/dev/vda` (ext4, `data=ordered`)
at `/newroot`; copies itself to `/newroot/run/bigbrain-guest`; moves `proc`,
`sys` and `dev` under the new root, `pivot_root`s, unmounts the old root and
`exec`s itself from `/run`. From then on it reaps every child (`SIGCHLD`,
`waitpid(-1)`), runs each job in its own session (`setsid`) as `work` with
`cwd` under `/work`, tracks exits for the job table, and serves vsock.
`shutdown`: TERM then KILL to every job, `sync`, remount `/` read-only,
`reboot(RB_POWER_OFF)`. Root in the guest is not a boundary the design relies
on (the machine is), so `work`'s passwordless sudo costs nothing.

**Build.** `bun run vm:image` (`packages/agents/image/`) runs on Linux: in
CI on `ubuntu-24.04-arm` (arm64) and `ubuntu-24.04` (x86_64), beside the
existing `ubuntu-latest` jobs (`.github/workflows/ci.yml`, `docs/ci.md`), or on
any Linux box. It runs `debootstrap --variant=minbase` into a directory and
`apt install` of the list in a chroot; `apt download`s the kernel package and
extracts `vmlinuz` and the module set; builds `packages/guest/` natively with
`cargo build --release --target <arch>-unknown-linux-musl`; writes the
initramfs (cpio: `/init`, the `.ko` files, the manifest); populates the sparse
8 GiB image with `mkfs.ext4 -d <dir>`, no loop mount; gzips; prints sha256s
and keeps `dpkg -l` as an artifact so two runs compare. No VM is booted and
no Mac is involved; integrity rests on apt's signatures and the recipe's
pinned versions. Rejected: an Alpine-netboot builder VM on the maintainer's
Mac (a build-time NAT exception; an x86_64 image only from an Intel Mac).

**Versioning and release.** `packages/agents/machine.json` pins `{protocol,
arch, kernel: {url, sha256, size}, initramfs: {…}, rootfs: {…}}`; the PR that
bumps it carries the sha256s CI printed. A protocol change bumps the
initramfs, toolchain changes the rootfs, the kernel rarely. The maintainer
downloads CI's artifacts, checks them against `machine.json`, and publishes
them with a `machine` mode of `bun run site:deploy` beside `extensions`
(`site/README.md`) to `/srv/releases/machine/<arch>/<sha256>/{vmlinuz,
initramfs.cpio, rootfs.img.gz}`, immutable paths. The engine downloads on the
first contained desktop, verifies against the pinned sha256, writes
atomically under `~/.local/share/bigbrain/machine/<sha256>/`, and prunes an
image no desktop references. gzip, because bun has it.

**Budget.** Download ≤ 300 MB; rootfs allocated ≤ 1.2 GiB in an 8 GiB
sparse image; kernel ≤ 40 MB; initramfs ≤ 16 MB with modules. If the
toolchain list breaks it, `build-essential` and Node become on-demand `apt`
installs first.

## Lifecycle

`Machines` (`packages/agents/src/machines.ts`) owns it; `Harbor` asks it for
a `Guest`.

| verb | what happens |
|---|---|
| **ensure image** | download, verify, unpack; a progress event the UI shows ("Preparing the desktop machine, 180 MB") |
| **create** | `cp -c` of the rootfs to `~/bigbrain/.agents/<id>/vm/disk.img`; `machine.json` records image sha256, protocol, created |
| **start** | spawn `bigbrain-vm` with the config (kernel, initramfs, `console=hvc0`, CPUs, memory, disk, vsock, console to `vm/console.log` rotated at 1 MB); wait for `running` on stdout and `hello` on the socket |
| **stop** | `shutdown` op; the helper exits when the VM halts; SIGKILL after 10 s |
| **delete** | stop; remove `vm/`, `out/` and `review/`; drop forwards |
| **status** | `stopped`, `starting`, `running`, `stopping`, `failed` (exit code and the last 20 console lines), `out-of-date` (protocol mismatch) |

- **Start is lazy:** on the first `exec`, file op or `open_project` after an
  open. Archive (by hand or after a day idle, as today) stops the machine.
- **Resources:** CPUs `min(4, max(2, physical/2))`; memory 2 GiB (Settings:
  1 to 8); disk 8 GiB virtual. At most 3 machines run at once (Settings); a
  fourth start stops the least recently used idle one, with an event saying
  so. Three failed starts in an hour leave it `failed` until the person
  retries.
- **Crash:** the helper exiting unexpectedly is an `error` event with the
  console tail; jobs and forwards are cleared; the next command starts it
  again. ext4 journaling covers the disk; uncommitted work in `/work` survives.
- **App restart:** no helper survives (process-group SIGTERM, `bin/desktop.ts`
  Lifetime); nothing starts on launch. **Survives:** the disk, the record, the
  event log, the review repos. **Does not:** jobs, previews, forwards' port
  numbers (reallocated on the next start; the event says so).
- **Out of date:** a protocol mismatch at `hello` stops the machine and marks
  the desktop; `Rebuild` makes a fresh disk from the current image and
  re-copies the project (uncommitted guest work is lost; the UI says so and
  offers Land first). A newer initramfs alone needs no rebuild.

## Projects

The in-place principle of `coding-desktops.md:17-40` came from a hidden copy
that drifted. The remedy here is not to work in place again but to make the
copy explicit, visible and refreshable, and to give the agent a true answer
about the real checkout when it asks.

- **open_project(name)** (agent tool; also chosen at creation): host git in
  `projects/<name>` makes `git bundle create --all` (over 1 GiB, the current
  branch and tags, and says so), the host `write`s it to
  `/work/.in/<name>.bundle`, the guest clones it to `/work/<name>`, checks out
  the person's current branch, and branches `desktop/<id>` from it. Git
  identity in the copy is the person's `user.name`/`user.email` (data, not a
  credential). Event `project.opened {project, base, branch, ms, bytes}` and a
  chat line: "Copy of orrery at a1b2c3 (main), 1.4 s". Uncommitted and
  untracked files are not copied unless ticked (Q4).
- **The header says what the copy is:** "Copy of orrery at a1b2c3 (main) ·
  taken 10:42 · your checkout is 2 ahead", from host git in the person's repo
  on each detail read (`lib/codingDesktops.ts:265-276`).
- **sync_project(name)** (agent tool and header button): a fresh bundle,
  fetched in the copy; the agent's branch rebases only if the agent asks.
  Event `project.synced {from, to}`.
- **project_state(name)** (host tool, read-only): branch, HEAD, `status
  --porcelain` (counts and names, capped), stashes, worktrees, remotes, tags,
  `log -20`, from host git in `projects/<name>`: the typed answer to "do we
  have a worktree for…", so the fidelity test's intent survives.
- **Dependencies** are installed in the machine (`bun install`, `uv sync`)
  through the proxy; the APFS clone of `node_modules` (`worktree.ts:78-90`)
  cannot cross into Linux and goes. Caches live on the desktop's disk (Q2).
- **Worktrees and leases retire.** Every desktop has its own copy; two
  desktops on one project meet at Land, as two branches. `workspace.ts:57-86`,
  `worktree.ts:55-117` and `.agents/leases/` go; `workDiff` and `landWork`
  (`worktree.ts:125-160`) keep their shape over a review repo.

## Land, previews, network

**Land (minimal, Phase 3b).** Review: the host asks the guest to `git bundle
create /work/.out/<name>.bundle <base>..desktop/<id>`, `read`s it to
`.agents/<id>/out/<name>.bundle`, and verifies and fetches it into a bare
**review repo** the host owns at `.agents/<id>/review/<name>.git`, created
with `objects/info/alternates` naming `projects/<name>/.git/objects` (so the
bundle's basis resolves and only new objects land) and `fetch.fsckObjects=
true`. The commit list and diff are computed there by host git (I7). The
review panel adds two flags: files matching `AUTORUN`
(`lib/codingDesktops.ts:94`), "runs code on its own"; and the desktop's taint
sources, "it read material from outside you". Land: in the review repo
`git update-ref refs/heads/desktop/<id> <reviewed>`; in the person's repo
`git fetch <review.git> desktop/<id>:desktop/<id>`; then push and PR as
`landWork` does now (`worktree.ts:151-159`), with the person's credentials,
on the host. Discard removes the review repo. **Seam for later:** `Outbox`,
items typed `bundle | patch | file`, each reviewed and accepted separately;
v1 implements `bundle`.

**Previews (Phase 3c).** When `ports` reports a listener in a job's group,
Harbor opens a host loopback listener on an ephemeral port and bridges each
connection to a `connect`; `server.started` gains `hostPort`; the bash result
says "listening on :5173, shown at http://127.0.0.1:61234". `show_page` keeps
`loopbackUrl` (`lib/pilotDesktop.ts:152-158`) and translates a guest port it
knows; the CSP (`lib/httpx.ts:77`) already frames loopback; a served page
loads `theme.css` from the engine because the webview, not the guest, fetches
it. Forwards close with the job.

**Network (minimal, Phase 3a).** `proxy.ts` unchanged but for the taint gate
of D9 through `hosts(desktop)` and a `drop(desktop)` that closes a tainted
desktop's open tunnels. The desktop is known by its machine's own
`egress.sock` (Transport), so no credential rides in the guest's
`HTTP_PROXY`; hosts are `DEFAULT_HOSTS`
plus `deb.debian.org`, the person's list and `request_host` answers
(`lib/desktopNetwork.ts`). **Phase 4, policy:** a per-install CA
(`~/.config/bigbrain/machine-ca/`, 0600) trusted by the image at first boot;
the proxy terminates TLS for allowlisted hosts and applies rules: registries
`GET`/`HEAD` only; GitHub `git-upload-pack` yes, `git-receive-pack` and API
writes no; a host the person adds is read-only unless marked "may upload";
"tunnel only" per host for a service that pins certificates. Taint then
closes only hosts that take uploads: a tainted desktop still installs and
fetches. Tests: `git push` from the guest refused; `git fetch` and `bun
install` allowed; `POST` to a registry refused; a tainted desktop fetching
but not pushing.

## What the person sees

Named here, designed in the workbench (`/field-workbench.html`):

- **Desktop header** (`web/ui/src/components/V2View.svelte:1609-1620`): the
  copy line with Sync, Land… and Discard replaces the `forks` row; a machine
  pill (Starting…, Running, Stopped, Failed with why, Out of date · Rebuild);
  "Sandboxed, not contained" on a desktop in the weaker mode (D11).
- **Review panel** (`:1621-1630`): host-computed commits and diff, the two flags.
- **Network-off panel** replaces the shell-off panel (`:1639-1647`): "This
  desktop read [sources], so its commands reach no site until you allow it",
  the refused host, **Allow network** (route `allow-network` replaces
  `allow-shell`, `lib/codingDesktopRoutes.ts:51`). The request-host panel
  (`:1648-1659`) is unchanged.
- **First contained desktop:** "Preparing the desktop machine (180 MB)" with
  progress and Cancel; a failure names the reason.
- **Settings › Desktops:** memory per desktop, running at once, the machine
  image (version, size, Check for update, Delete unused), the network list
  with read / may upload / tunnel only per host (Phase 4).

## Migration

- **Records** (`.spool/coding-desktops/<id>.json`) gain `machine: {mode:
  "contained" | "sandboxed", image, protocol, created}`; absence means a
  desktop from before this plan. Additive, tolerant read.
- **Existing desktops with worktrees** keep Land and Discard over the
  existing host-git path (`worktree.ts:125-170` stays for them) and lose new
  commands and edits; their chat says "This desktop predates contained
  desktops: land or discard its work, then start a new desktop."
- **Intel Macs:** the x86_64 image builds in CI from the same recipe and the
  framework runs there, so the question is performance alone; sandboxed,
  labelled, until a spike on an Intel Mac clears the thresholds (Q3).
- **Linux hosts:** the shell refuses as today (`sandbox.ts:289-293`). The
  image, agent and protocol are Linux-neutral; a KVM or Firecracker helper
  is the only platform piece, and is not in this plan.
- **Vaults** are untouched: everything here lives in the workspace and `.spool`.

## Phases

**Phase 0 — the present host-side weakness.** Tracked separately.

**Phase 1 — the guest interface, and today's desktops through it.**
`packages/agents/PROTOCOL.md`; `packages/agents/src/guest.ts` (the `Guest`
client: framing, closed schemas, limits, a recording fake); `packages/guest/`
(Rust: `bigbrain-guest --serve --unix <path>` for the helper, `--init --vsock
7470` for PID 1; every op in the table); `SandboxedGuest`, the native build
under `sandbox-exec` with today's profile (`sandbox.ts:186-272` reused),
restarted when confinement changes; `tools.ts`, `harbor.ts` and `agent.ts`
over `Guest`; I1's lint override. The world model (in place, worktrees,
leases, taint) is unchanged in this phase. Build: the crate builds with the
Rust toolchain the app needs; `desktop/build-resources.sh:27-32` copies
`bigbrain-guest-<triple>` as a second `externalBin` (`tauri.conf.json:24-26`).
**Dev loop (person, Q9):** a checkout's desktops need `bun run guest:build`
once; without the binary every desktop tool refuses with "Build the guest
helper: bun run guest:build", as the shell refuses off macOS today.
Tests: the conformance suite (I2); the tool suite on the recording fake (I1);
`packages/agents/test/agents.test.ts` unchanged in intent on the lived-in
fixture (`:22-46`), the fidelity test (`:48-58`) still identical and under
2 s; `sandbox.test.ts` unchanged. Acceptance: all suites green on macOS; no
`node:fs` in `tools.ts` or `harbor.ts`; `bigbrain agent run` and `⌘N` behave
as before.

**Phase 2 — the spike.** `packages/vm/` (Swift package, `bigbrain-vm`: boot,
sockets, `--dump-config`, stdin control, ad-hoc signed with
`packages/vm/vm.entitlements`); the image recipe and its CI job; a driver
`packages/agents/test/machine.spike.ts` (never in CI). Results are appended
to this document under "Spike results" the way `lenses-and-servers.md`
records E1–E5. Go/no-go below.

**Phase 3a — the machine behind a desktop.** `machines.ts`, `VmGuest` over
`guest.sock`, image download and pruning, `open_project`, `sync_project`,
`project_state`, the taint gate on egress (D9, `drop`), `allowNetwork`,
Discard; no Land yet. Events `machine.started`, `machine.stopped`,
`project.opened`, `project.synced`, `project.discarded` (proposed names;
`work.started`/`work.discarded`, `events.ts:18-19`, retire). Signing: add
`com.apple.security.virtualization` to `desktop/src-tauri/entitlements.plist`;
Tauri's bundler signs every `externalBin` with the app's entitlements file
(its `sign.rs` passes one `entitlements_path` to each target), so the helper
gets it, and the shell and bun carry an entitlement they never use, which
grants no data; a dev checkout signs the helper itself (`codesign -f -s -
--entitlements packages/vm/vm.entitlements bigbrain-vm` in `bun run
vm:build`). Tests: I3–I6; a VM suite gated by `BIGBRAIN_VM_TESTS=1` (boot and
`hello`; exec with streaming and cancellation; a 50 MB `write`/`read` round
trip; the helper killed mid-job and the next command recovering; `ip link`
and the env canary; the running-at-once cap; the clock stepped by a request
after a forced skew; taint closing egress), local-only since GitHub's arm64
macOS runners cannot nest virtualization. Acceptance: a contained desktop
opens the fixture project, installs its dependencies through the proxy, runs
its tests, and answers a checkout question through `project_state`; the
person's checkout never changes.

**Phase 3b — review and Land.** The review repos, the bundle round trip,
host-computed review with the two flags, Land as branch and PR, Discard
removing the review repo; `worktree.ts` reduced to the legacy path. Tests:
I7, I8; the agent-loop test becomes "a question answered from the copy, a
change on `desktop/<id>`, reviewed and landed as a branch in the person's
repo, which gained that ref and nothing else". Acceptance: a change made in
the machine arrives as a reviewed branch and PR.

**Phase 3c — previews.** Forwards, `server.started.hostPort`, `show_page`
translation, teardown with the job. Tests: a server found by `ports`, reached
through its forward, stopped by `stop_job`; a page beside the chat loads
`theme.css`. Acceptance: a dev server started in the machine is shown beside
the chat.

**Phase 3d — what the person sees.** The header, pill, panels and Settings
above; the record migration and the legacy-desktop path; `coding-desktops.md`
rewritten (the principle, the vocabulary table, "Working in place, and
leases", "Worktrees on request", "The sandbox", "A desktop's life", the
interface listing); `docs/self-host.md` and `desktop/README.md` gain the
helper, the entitlement and the image. Tests: browser scenes in `fakeApi.ts`
for every machine state, the network-off panel and a legacy desktop; the
record tolerant-read test. Acceptance: every state is reachable in the
workbench; the browser suite is green.

**Phase 4 — egress policy.** The CA, TLS termination, method and path rules,
the per-host setting, taint narrowed to upload-capable hosts, the tests
named above.

**Phase 5 — the rest.** Intel contained desktops once their spike passes;
retiring sandboxed mode (Q6); the `Outbox`; suspend/resume if boot time
disappoints; a host-seeded read-only package cache.

## Spike: measurements and thresholds

On the maintainer's Apple silicon Mac, with the fixture project of
`agents.test.ts` extended into a small real Node project (about 50 packages,
a vite dev server, a test script) under an invented name. Intel repeats the
first ten rows on an Intel Mac before Phase 5.

| measure | how | go | no-go |
|---|---|---|---|
| ad-hoc signed helper boots a VM | `bigbrain-vm` from `swift build`, signed with `-s -` | boots | any refusal: the plan stops here |
| modules | the bundled `.ko` set brings `/dev/vda`, vsock, rng and console up before `hello` | boots | a missing module: reread the kernel config |
| built-in against modules | boot time with the bundled set against a one-off kernel with them built in | within 300 ms | > 1 s: revisit D4 |
| boot to `hello` | p50 of 10 cold starts, 2 vCPU, 2 GiB | ≤ 2.0 s | > 5 s |
| idle footprint | helper RSS + VM resident after 5 min idle, `footprint`/`ps` | ≤ 400 MB | > 1 GiB |
| idle CPU | one idle machine, 5 min, Activity Monitor | ≤ 2 % | > 10 % |
| image download | compressed size | ≤ 300 MB | > 500 MB |
| disk clone | `cp -c` of the rootfs; growth after `bun install` | ≤ 1 s; sparse | > 10 s, or a full copy |
| `bun install`, cold cache, through the proxy | wall time | ≤ 60 s | > 180 s |
| test run | the fixture's tests, against the same on the host | ≤ 2× host | > 4× |
| file ops | p50 of 1,000 `stat`, `read` 4 KB, `write` 4 KB | ≤ 5 ms | > 25 ms |
| bulk transfer | 50 MB `write`, 50 MB `read` | ≥ 50 MB/s | < 10 MB/s |
| exec round trip | p50 of 100 `exec true` | ≤ 50 ms | > 250 ms |
| preview | vite page load through a forward, against host | ≤ 2× | > 5× |
| three at once | three machines, the fixture installed in each | within the cap | swap or thrash |
| bundle round trip | `--all` of the fixture, in and out, verified in a review repo | identical refs | any mismatch |
| clock | the Mac sleeps 10 min, then one request | guest within 1 s of the host after it | drift persists |

Also settled by the spike: which of the drivers Debian's cloud kernel builds
in (Alpine's virt kernel builds in only the console); whether the arm64
`vmlinuz` must be gunzipped first (vfkit refuses a compressed kernel on Apple
silicon); whether VZ presents virtio over PCI or MMIO on each architecture;
whether the balloon is worth enabling.

## Spike results

**2026-10-13, the maintainer's Mac: Apple silicon (arm64), macOS 26 (Darwin
25.6), 12 CPUs, 24 GiB; the CI-built arm64 image, the ad-hoc signed helper.
Verdict: go.**

| measure | result | verdict |
|---|---|---|
| ad-hoc signed helper boots a machine | boots (aarch64, guest 0.1.0) | go |
| modules | /dev/vda, vsock, rng and console up before hello; Debian's cloud kernel builds in virtio_pci, virtio_console and ext4, the rest load from the initramfs | go |
| built-in against modules | not measured (a one-off kernel); moot at this boot time | not run |
| boot to hello (p50 of 10) | 0.34 s | go |
| image download | 319 MB | between |
| disk clone | 0.00 s; free space fell 0 MB | go |
| bun install, cold cache, through the proxy | 0.8 s (26 MB, 42 packages) | go |
| test run | 0.24 s in the machine, 0.36 s on the host: 0.7× | go |
| preview | 0.9 ms through a forward, 0.4 ms on the host: 2.3× | between |
| file ops (p50 of 1,000) | stat, read 4 KB, write 4 KB: 0.2 ms each | go |
| bulk transfer | write 160 MB/s, read 173 MB/s | go |
| exec round trip (p50 of 100) | 0.4 ms | go |
| bundle round trip | identical refs | go |
| idle footprint (5 min) | 346 MB resident | go |
| idle CPU (5 min) | 0.2 % | go |
| three at once | 2,745 MB resident for three; no swap | go |
| clock after the Mac sleeps | by hand, still to do | not run |

Notes. The disk row read 8,192 MB allocated: the spike unpacked
`rootfs.img.gz` with `gunzip`, which writes every zero, so the base image
was not sparse (its clones share its blocks, hence 0 MB per clone). The
engine's unpack writes sparse (`image.ts`). The preview's ratio is of
sub-millisecond times. The image is 19 MB over its 300 MB budget after
dropping docs, man pages and translations; the plan's lever (build-essential
and Node on demand) is the person's call. Settled along the way: virtio is
PCI on VZ arm64 and QEMU q35, MMIO modules load but go unused; the arm64
kernel boots as Debian ships it once gunzipped; the balloon device is
harmless and left on. QEMU/KVM on Linux (nested, 2 CPUs) gave boot 2 s, exec
21 ms, file ops 4–8 ms: that path is a test harness only.

## Open questions

Each has a default so execution never blocks. **(person)** marks the
person's decisions.

- **Q1. The toolchain list** (default: the image section's list; no Go,
  Rust or Java). **(person)**
- **Q2. Defaults that stand unless changed:** 2 GiB, 2–4 vCPU, 8 GiB disk;
  3 machines at once; disks under `~/bigbrain/.agents/<id>/vm/`, images under
  `~/.local/share/bigbrain/machine/`; no shared package cache in v1;
  `desktop/<id>` branches and a PR when `origin` is GitHub; several projects
  per desktop under `/work`; `--all` bundles, current branch and tags above
  1 GiB.
- **Q3. Intel Macs:** sandboxed, labelled, until the Intel spike passes.
  **(person)**
- **Q4. Copying uncommitted work:** off by default; a checklist of changed
  and untracked files at open and Sync; files whose names match `secretName`
  (`lib/workPermissions.ts:22-23`) listed last, unticked and marked. **(person)**
- **Q5. TLS termination** on by default in Phase 4 for registries and
  GitHub, "tunnel only" per host as the escape. **(person)**
- **Q6. Retire sandboxed mode** once every supported Mac is cleared. **(person)**
- **Q7. Vocabulary:** machine, copy, Sync, contained, sandboxed, the event
  and tool names, and read / may upload / tunnel only are provisional.
  **(person)**
- **Q8. CI-built images:** GitHub's runners build what every desktop runs.
  Default: acceptable, with the recipe pinned, apt's signatures, `dpkg -l`
  kept per build, and the maintainer verifying sha256s before publishing. The
  alternative is a Linux box of the maintainer's. **(person)**
- **Q9. A Rust build in the dev loop** (Phase 1), or a prebuilt helper
  fetched by `bigbrain install`. Default: the build. **(person)**

## Sources

Apple's documentation: `VZLinuxBootLoader`, `VZVirtioSocketDevice`
(`setSocketListener(_:forPort:)`, `connect(toPort:)`) and the
`com.apple.security.virtualization` entitlement are macOS 11+;
`VZEFIBootLoader` 13+; `saveMachineStateTo` 14+. Apple forums thread 731132
and vfkit's `doc/usage.md`: no host-side `AF_VSOCK`, so vsock ports surface
as Unix sockets; a compressed kernel is refused on Apple silicon. vfkit's
`Makefile` and `vf.entitlements`: `codesign -f --entitlements … -s -`.
`apple/containerization` README: macOS 26, Apple silicon, Xcode 26,
Apache-2.0, vminitd over vsock. Tauri `tauri-bundler/src/bundle/macos/
sign.rs`: one `entitlements_path` for every sign target. GitHub's runner
documentation and `actions/runner-images#9254`: no nested virtualization on
arm64 macOS runners. `packages.debian.org`: `linux-image-cloud-arm64` 6.12 in
trixie. `dl-cdn.alpinelinux.org/alpine/v3.22/releases/aarch64/netboot/`:
`config-6.12.110-0-virt`, the module facts above. crates.io: `vsock` 0.5.
