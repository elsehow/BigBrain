# What the machine image is built from. A change here is a new rootfs:
# bump packages/agents/machine.json with the sha256s the build prints.

SUITE=trixie
# deb.debian.org by default; set DEBIAN_SNAPSHOT=20261001T000000Z to build
# from snapshot.debian.org at that moment, for a build that repeats exactly.
MIRROR=${DEBIAN_SNAPSHOT:+http://snapshot.debian.org/archive/debian/$DEBIAN_SNAPSHOT}
MIRROR=${MIRROR:-http://deb.debian.org/debian}

# The toolchains the plan's Q1 lists, from Debian.
PACKAGES="bash ca-certificates curl git jq ripgrep build-essential python3 python3-venv sudo tzdata unzip xz-utils less procps iproute2 openssh-client"

# The kernel: Debian's cloud flavour, its vmlinuz and the module set below.
KERNEL_PACKAGE_amd64=linux-image-cloud-amd64
KERNEL_PACKAGE_arm64=linux-image-cloud-arm64

# The modules a machine needs before the guest can serve (the plan's
# "Kernel and modules"); their dependencies are resolved from modules.dep.
MODULES="virtio_pci virtio_mmio virtio_blk virtio_console virtio_rng virtio_balloon ext4 vsock vmw_vsock_virtio_transport"

# Toolchains not from Debian, each pinned by its upstream sha256.
NODE_VERSION=24.21.0
NODE_SHA256_amd64=fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6
NODE_SHA256_arm64=6ad1325edbdb5649c379b75a237147a666c95d4f9ae8d340fef2d1575d289ad2
BUN_VERSION=1.3.14
BUN_SHA256_amd64=951ee2aee855f08595aeec6225226a298d3fea83a3dcd6465c09cbccdf7e848f
BUN_SHA256_arm64=a27ffb63a8310375836e0d6f668ae17fa8d8d18b88c37c821c65331973a19a3b
UV_VERSION=0.13.0
UV_SHA256_amd64=1468ebd5a5541121837c5a2817b9972ba6090fa6caa3d142620850a47fb75154
UV_SHA256_arm64=3ccfb6af6e242433eb552f7d9676abd5412c6595c497e990d9c8cb7b5bd4d2c3

# The disk a desktop clones: sparse, ext4.
DISK_SIZE=8G
