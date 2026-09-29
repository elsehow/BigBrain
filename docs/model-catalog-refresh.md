# Automatic model catalog refresh

`modelCatalog` remains the shared application discovery surface. Desktop startup,
subscription connection, picker/tool discovery, and Pi session initialization use
`createCatalogRuntime`. It restores an offline snapshot first and revalidates in
the background at startup and every four hours. An explicit `launch_agent` /
`revise_agent_environment` choice and Pi session preparation force a refresh on an
exact miss before rejection. No choice or saved preference is rewritten.

Pi owns installed provider adapters, runtime model snapshots, authentication and
its locked `models-store.json` persistence. BigBrain replaces the permissive Pi
0.85.1 public overlay loader with a bounded, validating provider wrapper, using
Pi's `refreshModels` / generation-checked `publish` interface. There is no second
curated model list. Only Pi built-in public providers are refreshed; Radius and
custom provider discovery are not redirected to the public service.

Policy:

- Fixed HTTPS Pi provider shards, no redirects, credentials or arbitrary endpoints.
  Requests use `redirect: "manual"` and refuse every 3xx except a 304: Bun's
  `fetch` treats a 304 as a redirect under `redirect: "error"`.
- Four-second transport/body deadline, five-second miss refresh, 4 MiB / 5,000
  records per shard; concurrent requests coalesce, including exact launch misses.
  A one-minute per-provider cooldown includes failures and repeated unknown IDs.
- ETag revalidation. Invalid JSON, HTTP failure, oversize, invalid metadata or
  unknown adapter configuration leaves the previous snapshot/store unchanged.
- Disk overlays undergo the same model validation before use; invalid overlays
  fall back to bundled records. Pi's existing locked file store is reused (not a
  new signed or atomic cache format). Bundled records remain available even if
  omitted upstream; omission is not treated as a verified retirement signal.
- Remote fields are allowlisted. Instructions, executable code, new endpoints and
  unknown fields cannot enter runtime models; a shard carrying them, invalid
  numbers, duplicate IDs or headers other than an installed record's exact headers
  is rejected whole and the last good snapshot stays.
- Newer pi.dev metadata that Pi 0.85.1's adapters never read (`type`,
  `inputLimits`, `promptCache`) is dropped; non-`chat` records are skipped.
  Tiered prices (`cost.tiers`) are installed Pi semantics and are validated and kept.
- API, endpoint, compatibility and reasoning-map combinations must already occur in
  the installed provider. A record needing new semantics is skipped by itself,
  never adapted; its bundled record (if any) stays.
- A remote record may never introduce `compat.allowedFallbackModels` (a
  server-side fallback serves a different model than the one chosen): only an
  installed record's exact list is accepted.
  Independently, `PiSession` strips `allowedFallbackModels` from every model request
  (`exactModel`), so no record, bundled or refreshed, can switch models server-side.
- `authentication: configured` and `ready` do not mean account entitlement.
  Discovery reports `entitlement: unverified`, model `availability: unverified`,
  and `adapterCompatibility: installed-configuration`. This checks declared adapter
  configuration, not live inference compatibility or provider authorization.
- No model/provider/billing fallback. Existing subscription billing guards remain.
  `PI_OFFLINE` disables network refresh; bundled/validated persisted models work.

## Verification boundary

Tests use fabricated model records, in-memory credentials and mocked HTTP. They
exercise real Pi initialization/persistence, discovery, `launch_agent` preflight,
Pi session preparation, concurrency, freshness, offline and malformed responses.
Normal tests set `PI_OFFLINE`; catalog tests opt in only with injected transport.
No paid inference, live credentials, or real vault are needed.

Live check, 2026-09-28 (anonymous GETs, scratch store, no inference): all 39
public provider shards returned 200 with an ETag and validated; 399 records were
accepted, 62 of them newer than the bundled catalog, and the rest were skipped
because their `compat` has moved past the installed adapters (notably most
`anthropic` and `openai-codex` records). A credentialed-provider refresh
persisted, restored offline, and revalidated with a 304; the catalog request
carried no credential. Pi only network-refreshes providers with a stored
credential. Publication latency and any specific future model remain unverified.

Adapter code changes require a separate tested Pi dependency/application release.
Automatic executable upgrades, signed release delivery and retirement discovery
are follow-ups, not implemented by data-only catalog refresh.
