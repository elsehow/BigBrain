#!/bin/sh
set -eu
# Refuse on the host BEFORE reading profiles, creating files, or running Bun.
case "$(/usr/sbin/sysctl -n hw.model)" in VirtualMac*) ;; *) echo 'Refusing: this is not the disposable Apple VM.' >&2; exit 1;; esac
# macOS always creates virtual anpi/utun interfaces; utun carries only fe80:: link-local.
# A NIC-less VZ guest also has an en* placeholder paired with anpi0: no media, inactive.
# Any en* with a carrier, any other device, or any routable address outside lo0, refuses.
for interface in $(/sbin/ifconfig -l); do
  case "$interface" in
    lo0) continue ;;
    gif*|stf*|anpi*|utun*) ;;
    en*) if ! /sbin/ifconfig "$interface" | /usr/bin/grep -q 'status: inactive'; then echo "Refusing: $interface has a link." >&2; exit 1; fi ;;
    *) echo "Refusing: guest has network device $interface." >&2; exit 1 ;;
  esac
  if /sbin/ifconfig "$interface" | /usr/bin/grep -E '^[[:space:]]+inet6? ' | /usr/bin/grep -vEq 'inet6 fe80:'; then echo "Refusing: routable address on $interface." >&2; exit 1; fi
done
# `route get` exits 0 even when it answers "not in table"; read what it says.
if /sbin/route -n get default 2>&1 | /usr/bin/grep -q 'interface:'; then echo 'Refusing: guest has an IPv4 default route.' >&2; exit 1; fi
# utun tunnels scope link-local IPv6 defaults; any other interface's default refuses.
if /usr/sbin/netstat -rn -f inet6 | /usr/bin/awk '$1 == "default" && $4 !~ /^utun/' | /usr/bin/grep -q .; then echo 'Refusing: guest has an IPv6 default route.' >&2; exit 1; fi
if /sbin/mount | /usr/bin/grep -Eiq 'virtiofs|smbfs|nfs'; then echo 'Refusing: shared host/network filesystem mounted.' >&2; exit 1; fi
if /usr/bin/pgrep -x bigbrain-desktop >/dev/null; then echo 'Quit the existing guest BigBrain normally before restart.' >&2; exit 1; fi
input_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
app_name='BigBrain Consent Review.app'
app_source="$input_dir/$app_name"
app_target="$HOME/Applications/$app_name"
evidence="$HOME/Desktop/BigBrain-Smoke-Evidence"
mkdir -p "$evidence" "$HOME/Applications"
{
  /usr/sbin/sysctl -n hw.model
  /usr/bin/sw_vers
  /sbin/ifconfig -l
  /sbin/mount
} > "$evidence/guest-containment.txt"
"$app_source/Contents/MacOS/bun" "$input_dir/verify-artifact.ts" "$input_dir/candidate-manifest.json" "$app_source" > "$evidence/source-artifact.json"
if [ ! -d "$app_target" ]; then /usr/bin/ditto "$app_source" "$app_target"; fi
"$app_source/Contents/MacOS/bun" "$input_dir/verify-artifact.ts" "$input_dir/candidate-manifest.json" "$app_target" > "$evidence/copied-artifact.json"
if ! /usr/bin/xcode-select -p >/dev/null 2>&1; then echo 'Install official Apple Command Line Tools in the clean base, then return offline before testing.' >&2; exit 1; fi
# Synthetic provider onboarding only; this CLI has no credentials/model capability.
mkdir -p "$HOME/.local/bin"
if [ ! -e "$HOME/.local/bin/claude" ]; then
  cat > "$HOME/.local/bin/claude" <<'STUB'
#!/bin/sh
# BigBrain synthetic native-smoke provider fixture.
case "$*" in
  --version) echo '2.1.247 (Claude Code)' ;;
  'auth status --json') echo '{"loggedIn":true,"email":"native-smoke@example.invalid","authMethod":"fixture"}' ;;
  'plugin marketplace add '*|'plugin install '*|'plugin marketplace update '*|'plugin update '*) echo 'Synthetic plugin operation only; no external CLI or credentials.' ;;
  *) echo 'Synthetic provider refuses model/other commands.' >&2; exit 1 ;;
esac
STUB
  chmod 755 "$HOME/.local/bin/claude"
elif ! /usr/bin/grep -q '^# BigBrain synthetic native-smoke provider fixture[.]$' "$HOME/.local/bin/claude"; then
  echo 'Refusing: unexpected provider executable in guest profile.' >&2; exit 1
fi
printf '%s\n' 'Provider status/plugin commands are synthetic. Native app and engine are unchanged. Guest networking is disabled.' > "$evidence/fixture-disclosure.txt"
# Production ports, bundled engine, normal guest home, persistent WebView.
cd "$HOME"
exec /usr/bin/env -i HOME="$HOME" USER="$(/usr/bin/id -un)" LOGNAME="$(/usr/bin/id -un)" PATH="$HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin" TMPDIR="${TMPDIR:-/tmp}" "$app_target/Contents/MacOS/bigbrain-desktop" >> "$evidence/native.log" 2>&1
