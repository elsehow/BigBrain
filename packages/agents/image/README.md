# The machine image

What every contained desktop's machine boots
(`docs/plans/2026-10-12-contained-desktops.md`, "The machine image"):

| file | what |
|---|---|
| `vmlinuz` | Debian's cloud kernel (arm64: uncompressed, as Virtualization.framework needs) |
| `initramfs.cpio` | `/init` (the guest agent, `packages/guest`, static) and the kernel modules it loads, in `modules/order` |
| `rootfs.img` / `.gz` | Debian stable, minimal, with the toolchains, as a sparse 8 GiB ext4 image a desktop's disk is cloned from |

`bun run vm:image [out-dir]` builds all three on Linux for the machine's own
architecture (`build.sh`; pins in `pins.sh`). It needs debootstrap, sudo,
cargo with the `<arch>-unknown-linux-musl` target, and network; it boots
nothing. `manifest.txt` has the sha256s, `dpkg.txt` what is installed, so two
builds compare. `repack.sh` replaces only the initramfs's guest agent, for a
protocol change.

`qemu.sh <out-dir> <state-dir>` boots one under QEMU/KVM, shaped like the
macOS helper from outside (`guest.sock`, `egress.sock`), so the guest and
the engine's side of it can be developed and tested on a Linux box. It is a
test harness, not a Linux backend. Keep `<state-dir>` short: a Unix socket's
path is at most 104 bytes on macOS and 108 on Linux.
