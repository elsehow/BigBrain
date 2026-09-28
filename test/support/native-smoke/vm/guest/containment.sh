#!/bin/sh
# Containment evidence, collected inside the guest BEFORE BigBrain first runs.
# Usage: containment.sh OUT_DIR. Prints PASS/FAIL per check; exits 1 on any FAIL.
# The only network probes are a loopback listener and a connect to TEST-NET-1
# (192.0.2.1, RFC 5737: documentation-only, never a live service).
set -u
out=${1:?output directory}
mkdir -p "$out"
fail=0
check() { if eval "$2" >/dev/null 2>&1; then echo "PASS $1"; else echo "FAIL $1"; fail=1; fi; }
{
  echo "== identity"; /usr/sbin/sysctl -n hw.model; /usr/bin/sw_vers; /usr/bin/id; /bin/date -u
  echo "== interfaces"; /sbin/ifconfig -a; /usr/sbin/ioreg -r -c IOEthernetInterface -l
  echo "== routes"; /usr/sbin/netstat -rn
  echo "== default route v4"; /sbin/route -n get default 2>&1
  echo "== default route v6"; /sbin/route -n get -inet6 default 2>&1
  echo "== mounts"; /sbin/mount
  echo "== disks"; /usr/sbin/diskutil list
  echo "== profile"; ls -la "$HOME"; ls -la "$HOME/.config" "$HOME/.claude" "$HOME/.claude.json" "$HOME/.codex" "$HOME/.local" 2>&1
  echo "== xcode-select"; /usr/bin/xcode-select -p 2>&1; /usr/bin/git --version 2>&1
} > "$out/containment-raw.txt" 2>&1
input=$(/sbin/mount | /usr/bin/awk '/on \/Volumes\/BB_SMOKE_INPUT /{print $0}')
{
  check "hw.model is VirtualMac" '/usr/sbin/sysctl -n hw.model | grep -q "^VirtualMac"'
  # A NIC-less VZ guest still has an en* placeholder paired with anpi0 (no media, inactive).
  check "no en* interface with a link" '(for i in $(/sbin/ifconfig -l); do case $i in en*) /sbin/ifconfig $i | grep -q "status: inactive" || exit 1;; esac; done)'
  check "no IPv4 address outside lo0" '! /sbin/ifconfig -a | awk "/^[a-z]/{i=\$1} /inet /{print i}" | grep -vq "^lo0:"'
  check "no non-link-local IPv6 outside lo0" '! /sbin/ifconfig -a | awk "/^[a-z]/{i=\$1} /inet6 /{print i, \$2}" | grep -v "^lo0:" | grep -vq " fe80:"'
  # route get exits 0 even when it answers "not in table".
  check "no IPv4 default route" '! /sbin/route -n get default 2>&1 | grep -q "interface:"'
  check "no IPv6 default route outside utun link-local tunnels" '! /usr/sbin/netstat -rn -f inet6 | awk "\$1 == \"default\" && \$4 !~ /^utun/" | grep -q .'
  check "TEST-NET-1 connect fails" '! /usr/bin/nc -z -G 3 192.0.2.1 443'
  check "no shared/network filesystems" '! /sbin/mount | grep -Eiq "virtiofs|smbfs|nfs|afpfs|webdav"'
  check "input volume mounted read-only" 'echo "$input" | grep -q "read-only"'
  check "input volume refuses writes" '! touch /Volumes/BB_SMOKE_INPUT/.write-probe'
  check "output volume present and writable" 'touch /Volumes/BB_SMOKE_OUT/.write-probe && rm /Volumes/BB_SMOKE_OUT/.write-probe'
  check "no ~/.config/bigbrain" '[ ! -e "$HOME/.config/bigbrain" ]'
  check "no ~/.claude or ~/.claude.json" '[ ! -e "$HOME/.claude" ] && [ ! -e "$HOME/.claude.json" ]'
  check "no ~/.codex" '[ ! -e "$HOME/.codex" ]'
  check "no ~/.local/bin/bigbrain" '[ ! -e "$HOME/.local/bin/bigbrain" ]'
  check "no BigBrain app installed" '[ ! -e /Applications/BigBrain.app ] && [ ! -e "$HOME/Applications/BigBrain Consent Review.app" ]'
  check "real claude CLI absent from PATH dirs" '! ls /opt/homebrew/bin/claude /usr/local/bin/claude'
  check "Command Line Tools present" '/usr/bin/xcode-select -p && /usr/bin/git --version'
  # Loopback stays up for the engine.
  /usr/bin/nc -l 127.0.0.1 47999 > "$out/loopback-canary.txt" & listener=$!
  sleep 1
  echo loopback-ok | /usr/bin/nc -G 2 127.0.0.1 47999 >/dev/null 2>&1
  sleep 1; kill "$listener" 2>/dev/null
  check "loopback canary delivered" 'grep -q loopback-ok "$out/loopback-canary.txt"'
} | tee "$out/containment.txt"
grep -q '^FAIL' "$out/containment.txt" && exit 1
exit 0
