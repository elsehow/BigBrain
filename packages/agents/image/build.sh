#!/bin/bash
# The machine image: kernel, initramfs (the guest agent and the modules it
# loads), and the rootfs every desktop's disk is cloned from.
#
#   bun run vm:image [out-dir]       (default: packages/agents/image/out)
#
# Runs on Linux, as root or through sudo (debootstrap and chroot need it),
# for the machine's own architecture (amd64 or arm64). Boots nothing.
# Prints each artifact's sha256 and keeps dpkg -l beside them, so two
# builds compare. The plan's "The machine image" section is the spec.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../../.." && pwd)
. "$HERE/pins.sh"
OUT=$(realpath -m "${1:-$HERE/out}")

case "$(uname -m)" in
  x86_64) ARCH=amd64; TRIPLE=x86_64-unknown-linux-musl; NODE_ARCH=x64; BUN_ARCH=x64; UV_ARCH=x86_64 ;;
  aarch64) ARCH=arm64; TRIPLE=aarch64-unknown-linux-musl; NODE_ARCH=arm64; BUN_ARCH=aarch64; UV_ARCH=aarch64 ;;
  *) echo "vm:image: no machine image for $(uname -m)" >&2; exit 1 ;;
esac
pin() { eval "echo \${$1_$ARCH}"; }

# the guest is built as whoever runs this, before root takes over
if [ "$(id -u)" != 0 ]; then
  cargo build --release --target "$TRIPLE" --manifest-path "$ROOT/packages/guest/Cargo.toml"
  exec sudo --preserve-env=DEBIAN_SNAPSHOT "$0" "$OUT"
fi
[ -x "$ROOT/packages/guest/target/$TRIPLE/release/bigbrain-guest" ] \
  || { echo "vm:image: build the guest first (cargo build --release --target $TRIPLE), or run this as yourself" >&2; exit 1; }

WORK=$(mktemp -d /var/tmp/bigbrain-image.XXXXXX)
cleanup() {
  for m in proc sys dev/pts dev; do umount -l "$WORK/rootfs/$m" 2>/dev/null || true; done
  rm -rf "$WORK"
}
trap cleanup EXIT
mkdir -p "$OUT" "$WORK/dl"
say() { printf '\n== %s\n' "$*"; }
fetch() { # url sha256 dest
  curl -fsSL --retry 3 -o "$3" "$1"
  echo "$2  $3" | sha256sum -c --quiet - || { echo "vm:image: $1 is not the pinned file" >&2; exit 1; }
}

say "rootfs: debootstrap $SUITE ($ARCH) from $MIRROR"
debootstrap --variant=minbase --arch="$ARCH" "$SUITE" "$WORK/rootfs" "$MIRROR" >"$WORK/debootstrap.log" 2>&1 \
  || { tail -30 "$WORK/debootstrap.log"; exit 1; }
R=$WORK/rootfs
mount -t proc proc "$R/proc"; mount -t sysfs sys "$R/sys"; mount --bind /dev "$R/dev"; mount --bind /dev/pts "$R/dev/pts"
cp /etc/resolv.conf "$R/etc/resolv.conf"
cat >"$R/etc/apt/sources.list" <<SOURCES
deb $MIRROR $SUITE main
deb $MIRROR $SUITE-updates main
deb ${DEBIAN_SNAPSHOT:+http://snapshot.debian.org/archive/debian-security/$DEBIAN_SNAPSHOT}${DEBIAN_SNAPSHOT:-http://deb.debian.org/debian-security} $SUITE-security main
SOURCES
in_root() { chroot "$R" /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8 "$@"; }
in_root apt-get update -q >/dev/null
# shellcheck disable=SC2086
in_root apt-get install -y -q --no-install-recommends $PACKAGES >"$WORK/apt.log" 2>&1 || { tail -30 "$WORK/apt.log"; exit 1; }

say "toolchains: node $NODE_VERSION, bun $BUN_VERSION, uv $UV_VERSION"
fetch "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-$NODE_ARCH.tar.xz" "$(pin NODE_SHA256)" "$WORK/dl/node.tar.xz"
tar -xJf "$WORK/dl/node.tar.xz" -C "$R/usr/local" --strip-components=1 --exclude='*/README.md' --exclude='*/CHANGELOG.md' --exclude='*/LICENSE'
fetch "https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION/bun-linux-$BUN_ARCH.zip" "$(pin BUN_SHA256)" "$WORK/dl/bun.zip"
python3 -c 'import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])' "$WORK/dl/bun.zip" "$WORK/dl"
install -m 0755 "$WORK/dl/bun-linux-$BUN_ARCH/bun" "$R/usr/local/bin/bun"
ln -sf bun "$R/usr/local/bin/bunx"
fetch "https://github.com/astral-sh/uv/releases/download/$UV_VERSION/uv-$UV_ARCH-unknown-linux-gnu.tar.gz" "$(pin UV_SHA256)" "$WORK/dl/uv.tar.gz"
tar -xzf "$WORK/dl/uv.tar.gz" -C "$R/usr/local/bin" --strip-components=1

say "the machine's own files"
in_root useradd --create-home --uid 1000 --user-group --shell /bin/bash work
echo 'work ALL=(ALL) NOPASSWD:ALL' >"$R/etc/sudoers.d/work"; chmod 0440 "$R/etc/sudoers.d/work"
cat >"$R/etc/profile.d/bigbrain-proxy.sh" <<'PROFILE'
# A desktop's machine reaches beyond itself only through the engine's egress
# proxy, forwarded from here (packages/agents/PROTOCOL.md, Egress).
export HTTP_PROXY=http://127.0.0.1:3128 HTTPS_PROXY=http://127.0.0.1:3128 ALL_PROXY=http://127.0.0.1:3128
export http_proxy=$HTTP_PROXY https_proxy=$HTTPS_PROXY all_proxy=$ALL_PROXY
export NO_PROXY=localhost,127.0.0.1,::1 no_proxy=localhost,127.0.0.1,::1
export npm_config_proxy=$HTTP_PROXY npm_config_https_proxy=$HTTPS_PROXY
export NODE_USE_ENV_PROXY=1
PROFILE
printf 'desktop\n' >"$R/etc/hostname"
printf '127.0.0.1 localhost desktop\n::1 localhost\n' >"$R/etc/hosts"
mkdir -p "$R/work" && chown 1000:1000 "$R/work"
in_root git config --system init.defaultBranch main
in_root git config --system safe.directory '*'

say "kernel: $(pin KERNEL_PACKAGE)"
# the metapackage names the image package; only that one is downloaded
KIMG=$(in_root apt-cache depends "$(pin KERNEL_PACKAGE)" | awk '/Depends: linux-image-[0-9]/ { print $2; exit }')
(cd "$R/tmp" && in_root sh -c "cd /tmp && apt-get download -q $KIMG" >/dev/null)
DEB=$(ls "$R"/tmp/linux-image-*.deb | head -1)
mkdir -p "$WORK/kernel" && dpkg-deb -x "$DEB" "$WORK/kernel"
# merged /usr: the package may ship usr/lib/modules; depmod and modprobe -d look in lib/modules
[ -d "$WORK/kernel/lib/modules" ] || ln -s usr/lib "$WORK/kernel/lib"
KVER=$(ls "$WORK/kernel/lib/modules/" | head -1)
KPKG=$(dpkg-deb -f "$DEB" Package)=$(dpkg-deb -f "$DEB" Version)
cp "$WORK/kernel/boot/vmlinuz-$KVER" "$WORK/vmlinuz"
# Virtualization.framework boots an uncompressed arm64 Image only
if [ "$ARCH" = arm64 ] && [ "$(head -c2 "$WORK/vmlinuz" | od -An -tx1 | tr -d ' ')" = 1f8b ]; then gunzip -c "$WORK/vmlinuz" >"$WORK/vmlinuz.raw" && mv "$WORK/vmlinuz.raw" "$WORK/vmlinuz"; fi
rm -f "$R"/tmp/*.deb

say "modules for $KVER"
depmod -b "$WORK/kernel" "$KVER"
mkdir -p "$WORK/initramfs/modules"
: >"$WORK/order"
for m in $MODULES; do
  # each module's dependencies first; a builtin answers "builtin" and loads nothing
  modprobe -d "$WORK/kernel" -S "$KVER" --show-depends "$m" 2>/dev/null | awk '$1 == "insmod" { print $2 }' >>"$WORK/order" \
    || echo "  $m: not a module (built in, or absent)"
done
awk '!seen[$0]++' "$WORK/order" | while read -r ko; do
  name=$(basename "$ko"); plain=${name%.xz}; plain=${plain%.zst}; plain=${plain%.gz}
  case "$name" in
    *.xz) xz -dc "$ko" >"$WORK/initramfs/modules/$plain" ;;
    *.zst) zstd -qdc "$ko" >"$WORK/initramfs/modules/$plain" ;;
    *.gz) gzip -dc "$ko" >"$WORK/initramfs/modules/$plain" ;;
    *) cp "$ko" "$WORK/initramfs/modules/$plain" ;;
  esac
  echo "$plain" >>"$WORK/initramfs/modules/order"
  echo "  $plain"
done

say "guest agent ($TRIPLE)"
install -m 0755 "$ROOT/packages/guest/target/$TRIPLE/release/bigbrain-guest" "$WORK/initramfs/init"
mkdir -p "$WORK/initramfs/"{proc,sys,dev,newroot}
(cd "$WORK/initramfs" && find . -mindepth 1 | LC_ALL=C sort | cpio --quiet -o -H newc --owner=0:0 --reproducible) >"$WORK/initramfs.cpio"

say "rootfs image"
# from now on apt in the machine goes through the egress proxy, like everything else
printf 'Acquire::http::Proxy "http://127.0.0.1:3128";\nAcquire::https::Proxy "http://127.0.0.1:3128";\n' >"$R/etc/apt/apt.conf.d/90bigbrain-proxy"
: >"$R/etc/resolv.conf"
in_root apt-get clean
rm -rf "$R/var/lib/apt/lists/"* "$R/var/log/"*.log "$R/tmp/"* "$R/root/.cache"
for m in dev/pts dev sys proc; do umount -l "$R/$m"; done
DPKG=$(chroot "$R" dpkg-query -W -f '${Package}=${Version}\n' | LC_ALL=C sort)
IMAGE_ID="bigbrain-machine $SUITE $ARCH $(date -u +%Y%m%d) $KPKG"
echo "$IMAGE_ID" >"$R/etc/bigbrain-image"
rm -f "$WORK/rootfs.img"; truncate -s "$DISK_SIZE" "$WORK/rootfs.img"
mkfs.ext4 -q -F -L bigbrain -E root_owner=0:0 -d "$R" "$WORK/rootfs.img"

say "out: $OUT"
mv "$WORK/vmlinuz" "$OUT/vmlinuz"
mv "$WORK/initramfs.cpio" "$OUT/initramfs.cpio"
gzip -c --no-name "$WORK/rootfs.img" >"$OUT/rootfs.img.gz"
mv "$WORK/rootfs.img" "$OUT/rootfs.img"
echo "$DPKG" >"$OUT/dpkg.txt"
cp "$WORK/initramfs/modules/order" "$OUT/modules.txt"
{
  echo "image: $IMAGE_ID"
  echo "kernel package: $KPKG"
  for f in vmlinuz initramfs.cpio rootfs.img.gz; do echo "$f $(stat -c %s "$OUT/$f") $(sha256sum "$OUT/$f" | cut -d' ' -f1)"; done
  echo "rootfs allocated: $(du -h "$OUT/rootfs.img" | cut -f1) of $DISK_SIZE"
} | tee "$OUT/manifest.txt"
[ -n "${SUDO_USER:-}" ] && chown -R "$SUDO_USER" "$OUT"
