# Native isolation canary (not an app launcher)

This deliberately small native WKWebView fixture tests a prerequisite for a
safe packaged-app smoke. It never opens BigBrain, imports its engine, contacts
an ingestion service, or uses real profile files as canaries. **A passing result
would still not certify an entire app profile or its XPC services.**

On macOS with Xcode CLT and a GUI session:

```sh
python3 test/support/native-smoke/probe.py --mode sandbox
python3 test/support/native-smoke/probe.py --mode proxy
python3 test/support/native-smoke/probe.py --mode content-block
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s test/support/native-smoke -p 'test_*.py'
```

`sandbox-exec` cannot apply another sandbox inside some agent sandboxes. Use the
native approval mechanism for the **synthetic probe only**, never disable the
profile or turn this script into an uncontained BigBrain launcher.

Each invocation compiles `probe.m` into a fresh `/private/tmp/bb-native-boundary-*`
directory, creates an empty home and a separate fabricated forbidden file, and
binds two ephemeral loopback servers. The first serves the page and an allowed
fetch; the second records whether a forbidden fetch arrived. The test launches
only its own native process and stops only that process. The servers close in
`finally`; a subprocess timeout kills/waits for that probe. Evidence remains at
`<root>/result.json` with source/policy hashes, requests, stdout and checks.

The child receives an allowlisted environment (`HOME`, `CFFIXED_USER_HOME`,
`TMPDIR`, system-only `PATH`, synthetic paths/ports). Its experimental seatbelt
policy denies user-directory reads, all writes except its disposable home/temp,
network except the allowed loopback port, named preference/security services,
Apple events, and execution from installed-app/provider/user directories.
It uses a nonpersistent WebKit data store. That differs from production and
makes this a **boundary experiment**, not production WebView/storage coverage.

Modes:

- `sandbox`: parent-process sandbox only (negative control).
- `proxy`: also sets WebKit's HTTP CONNECT proxy, with failover disabled. The
  proxy can forward only the allowed canary; other targets receive 403.
- `content-block`: compiles deny-all content rules with an exception for the
  exact test origin before the first navigation. A compiler failure exits
  without loading the page. Rules reside in the disposable home.

Every mode exits **1** unless all file checks, the allowed fetch, the blocked
fetch, and native completion are observed. A server observation overrides a
page's claimed success; absence of requests alone is never success. The small
unit suite protects these failure classifications. Errors such as missing SDKs
also produce nonzero exit status.

On macOS 26.6.2 all three containment gates failed. The sandbox and proxy modes
reached the forbidden server through WKWebView. Content rules failed compiling
and no page loaded. This is useful negative evidence, not a candidate defect
and not a reason to relax the policy. See
[the audit](../../../docs/native-smoke-isolation.md) for provenance and remaining
release coverage.
