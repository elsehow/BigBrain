#!/bin/bash
# A machine under QEMU/KVM on Linux, shaped like bigbrain-vm's (the macOS
# helper's) on the outside: guest.sock reaches the guest's vsock 7470, and
# the guest's vsock 7471 reaches egress.sock. For developing and testing
# the guest and the engine's side of it on a Linux box; it is not a Linux
# backend for desktops (the plan's Migration, "Linux hosts").
#
#   packages/agents/image/qemu.sh <image-dir> <state-dir> [cid]
#
# <state-dir> gets guest.sock, egress.sock (the caller listens there) and
# qemu.pid; the disk (made once, a sparse copy of the image's rootfs) and
# the console log go there too, unless DISK and CONSOLE say otherwise.
# Prints "running" when the guest serves; stops the machine on SIGTERM.
# Needs qemu-system-x86_64 (or -aarch64), socat, /dev/kvm and
# /dev/vhost-vsock. Every QEMU guest reaches the same host vsock, so each
# machine's egress port is its own (the kernel's bigbrain.egress_port=).
set -euo pipefail
IMAGE=$(realpath "$1"); STATE=$(realpath -m "$2"); CID=${3:-$((1000 + RANDOM % 20000))}
EGRESS=$((20000 + CID))
DISK=${DISK:-$STATE/disk.img}; CONSOLE=${CONSOLE:-$STATE/console.log}
mkdir -p "$STATE"
[ -f "$DISK" ] || cp --sparse=always "$IMAGE/rootfs.img" "$DISK"
rm -f "$STATE/guest.sock"

case "$(uname -m)" in
  x86_64) QEMU=qemu-system-x86_64; MACHINE=(-machine q35,accel=kvm -cpu host) ;;
  aarch64) QEMU=qemu-system-aarch64; MACHINE=(-machine virt,accel=kvm -cpu host) ;;
esac

pids=()
stop() { for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done; wait 2>/dev/null; }
trap stop EXIT
trap 'exit 0' TERM INT

"$QEMU" "${MACHINE[@]}" -m "${MEMORY:-2048}" -smp "${CPUS:-2}" -nodefaults -nographic -no-reboot \
  -kernel "$IMAGE/vmlinuz" -initrd "$IMAGE/initramfs.cpio" -append "console=hvc0 panic=-1 quiet bigbrain.egress_port=$EGRESS" \
  -drive "file=$DISK,if=virtio,format=raw,discard=unmap" \
  -device "vhost-vsock-pci,guest-cid=$CID" \
  -device virtio-serial-pci -chardev "file,id=con,path=$CONSOLE" -device virtconsole,chardev=con \
  -device virtio-rng-pci -device virtio-balloon-pci -serial none -monitor none \
  -pidfile "$STATE/qemu.pid" &
pids+=($!)
socat "UNIX-LISTEN:$STATE/guest.sock,fork,unlink-early" "VSOCK-CONNECT:$CID:7470" &
pids+=($!)
socat "VSOCK-LISTEN:$EGRESS,fork,reuseaddr" "UNIX-CONNECT:$STATE/egress.sock" 2>/dev/null &
pids+=($!)
for _ in $(seq 1 300); do
  grep -q "serving on vsock" "$CONSOLE" 2>/dev/null && { echo running; break; }
  kill -0 "${pids[0]}" 2>/dev/null || { echo "failed"; exit 1; }
  sleep 0.05
done
wait "${pids[0]}"
