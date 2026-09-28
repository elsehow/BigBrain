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
- Four-second transport/body deadline, five-second miss refresh, 4 MiB / 5,000
  records per shard; concurrent requests coalesce, including exact launch misses.
  A one-minute per-provider cooldown includes failures and repeated unknown IDs.
- ETag revalidation. Invalid JSON, HTTP failure, oversize, invalid metadata or
  unknown adapter configuration leaves the previous snapshot/store unchanged.
- Disk overlays undergo the same model validation before use; invalid overlays
  fall back to bundled records. Pi's existing locked file store is reused (not a
  new signed or atomic cache format). Bundled records remain available even if
  omitted upstream; omission is not treated as a verified retirement signal.
- Remote fields are allowlisted. Headers, sampling instructions, executable code,
  new endpoints and unknown fields cannot enter runtime models. API, endpoint,
  compatibility and reasoning-map combinations must already occur in the installed
  provider. A shard requiring new semantics is rejected as a whole, not guessed.
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

**Live `pi.dev` endpoint availability, schema compatibility and publication latency
remain unverified.** Network access to that domain was not approved during this
implementation. Conservative whole-shard validation may reject current upstream
fields; verify with an approved public endpoint check before claiming live model
propagation. No specific future model's entitlement or compatibility is promised.

Adapter code changes require a separate tested Pi dependency/application release.
Automatic executable upgrades, signed release delivery and retirement discovery
are follow-ups, not implemented by data-only catalog refresh.
