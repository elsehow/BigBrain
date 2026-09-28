# Spike-0 findings — pi tool-bridge fidelity

> **HISTORICAL (2026-08-30, #644).** A pi-era gate record; the pi engine retired with the hosted product (#566) — code at tag `hosted-multitenant-final`.

Date: 2026-08-08 · Gate for Item A · Feeds updates to
`2026-08-07-hosted-walking-skeleton-design.md` §4 (run-environment contract)
and §6 (Spike-0 / Item A).

## Verdict

**pi verified, and the bridge works — offline, end-to-end.** The design's central
bet (host-side pi loop, tool calls execute in a container, key never in the
container, offline-testable, output shape unchanged) is proven. Several concrete
API details differ from what the design assumed; all are for the better or
neutral, none are blocking. **The documented pi-in-container + egress-proxy
fallback is now LESS likely to be needed** (see deviation 1).

Packages installed (all under Bun 1.3.9, clean):
`@earendil-works/pi-coding-agent@0.84.1`, `@earendil-works/pi-agent-core@0.84.1`,
`@earendil-works/pi-ai@0.84.1` (2 blocked postinstalls, benign).

Deliverables: `lib/editor/piRun.ts` (~205 LOC), `lib/editor/containment.ts`
(~215 LOC), `test/piRun.test.ts` (5 tests), `test/containment.test.ts`
(18 tests). Full suite 814 pass / 0 fail; oxlint silent. The `claude-cli` path
in `run.ts`/`worker.ts` is byte-identical (untouched).

## Deviations from the design — apply these to §4/§6

### 1. Tool bridge: keep pi's OWN tools, swap the `operations` backend (NOT `noTools:'all'` + hand-rolled `defineTool` wrappers) — HIGHER fidelity

Design §4.6/§6 specified `noTools:'all'` + four `defineTool` wrappers
(read/write/edit/bash). The real, canonical pi mechanism — shipped in pi's own
`examples/extensions/gondolin/` (routes tools into a micro-VM) and documented in
`docs/containerization.md` — is to **keep pi's builtin read/write/edit/bash tools
and override only their low-level `operations` backend**:

- `create{Read,Write,Edit,Bash}ToolDefinition(vaultRoot, { operations })` returns
  pi's real tool with a pluggable I/O backend. The `operations` interfaces are
  `ReadOperations {readFile(absPath)->Buffer, access, detectImageMimeType?}`,
  `WriteOperations {writeFile, mkdir}`, `EditOperations {readFile, writeFile,
  access}`, `BashOperations {exec(cmd, cwd, {onData,signal,timeout,env})->{exitCode}}`.
  We back each with `docker exec` (see `containment.ts`).
- Registration is via an **inline extension** (`(pi)=>{ pi.registerTool(def) }`)
  passed to the resource loader's `extensionFactories`. `pi.registerTool`
  overrides the same-named builtin.
- We do **not** set `noTools:'all'`. Empirically, `noTools:'all'` + `customTools`
  named `read`/… does **not** register the custom tools (they never enter the
  registry). The builtins are instead present and overridden; grep/find/ls are
  removed via `excludeTools: ['grep','find','ls']` (they ride container bash, per
  the design's own §4.6).

Why this matters: it **retires the design's single biggest flagged risk** — "the
tool bridge reimplements pi's builtins whose schemas/semantics the model is tuned
around" (§2 dissent, §8 Q1). We keep pi's exact tool schemas, prompt snippets,
truncation, edit and image semantics; only the bytes' source/sink move into the
container. This makes the §6 fallback (pi-in-container + host egress proxy) less
likely to be needed on fidelity grounds.

Action for §4.6/§6: replace "four `defineTool` wrappers" with "override the four
builtins via `create*ToolDefinition({operations})` + an inline extension;
`excludeTools` grep/find/ls; do not use `noTools:'all'`."

### 2. Offline test seam: install the fake stream on the ModelRuntime INSTANCE (there is no per-session `streamFn` option)

Design §6 assumed "an injectable `streamFn` for testing." Reality:
- `createAgentSession` has **no** `streamFn` option.
- pi-agent-core exports a **module-level** `setDefaultStreamFn(fn)`, but it is
  only the fallback used when a caller omits a model runtime. It does **not**
  override a passed `modelRuntime` — the agent loop calls
  `modelRuntime.streamSimple`. (Empirically, `setDefaultStreamFn` was never
  consulted; `turns: 0`.)
- The working offline seam is to install the canned stream on the **ModelRuntime
  instance**: `runtime.streamSimple = fakeStreamFn` (and `.stream`). `piRun`
  exposes this as `deps.streamFn` (production omits it → real credentialed
  stream). The `StreamFn` shape is `(model, context, options?) =>
  AssistantMessageEventStream`; build a stream with `new
  AssistantMessageEventStream()` + `.push({type:'start',partial})` +
  `.push({type:'done', reason, message})`.

The design's requirement (fully offline `streamFn` contract test) **holds** — just
via instance injection, not a session option. Both new test files run with no
network and no docker.

### 3. Runtime key override: CONFIRMED, exactly as designed (§4.4)

`const rt = await ModelRuntime.create(); await rt.setRuntimeApiKey('anthropic',
key)` — returns `Promise<void>`, runtime-only, never written to `auth.json` or any
file. `ModelRuntime.create()` is offline-safe with defaults (no network refresh).
Note: `session.prompt()` preflights that provider auth is configured, so the key
(a dummy in tests) must be set before prompting.

### 4. `systemPromptOverride` + `.pi/` isolation live on the resource loader, with first-class discovery-off flags — STRONGER than the design assumed

`systemPromptOverride` is **not** a `createAgentSession` option; it is a
`DefaultResourceLoader` option. More importantly, the design's "pinned `agentDir`
+ explicit `resourceLoader` so vault-resident `.pi/` trees never auto-load" is
served by **first-class loader flags**: `noExtensions`, `noSkills`,
`noPromptTemplates`, `noThemes`, `noContextFiles` (all `true`), plus pinning both
`cwd` and `agentDir` to a **throwaway dir** (NOT the vault). Confirmed: inline
`extensionFactories` still load with `noExtensions: true`, so our containment
extension loads while disk `.pi/` / `AGENTS.md` discovery is fully off. This is a
cleaner, better-supported closure of prompt-injection → extension-code-execution
than "pin agentDir" alone.

Note: because the overriding tools bind to the vault root themselves, the
session `cwd` need not be the vault — pinning it to the throwaway dir is what
kills vault-resident discovery.

### 5. Final-text extraction: `session.getLastAssistantText()`

The clean analog of `runClaude`'s `.result` is
`AgentSession.getLastAssistantText(): string | undefined`. Drive with `await
session.prompt(text); await session.waitForIdle();` then read it. The terminal
events are `agent_end` (carries full `messages[]`) then `agent_settled`. A
failed/aborted turn does not throw — it surfaces via `session.state.errorMessage`
(piRun throws on it, mirroring `runClaude`'s throw-on-failure).

### 6. `getModel` import path + model ids

`getModel` is **not** a runtime top-level `@earendil-works/pi-ai` export (the
design's `import { getModel } from '@earendil-works/pi-ai'` fails). It is a
deprecated alias at `@earendil-works/pi-ai/compat`; canonical is `getBuiltinModel`
from `@earendil-works/pi-ai/providers/all`, or `ModelRuntime.getModel(provider,
id)`. Model ids are bare and provider is a separate arg:
`getModel('anthropic','claude-opus-4-5')`. Builtin catalog includes
`claude-opus-4-5`, `claude-sonnet-4-5`, `claude-haiku-4-5`, etc. — §4.7's model
plumbing should pass `(provider, modelId)`.

## Choices we made (not deviations, but record them for Item A)

- **`DockerExec` seam kept SYNC** (spawnSync-shaped), mirroring run.ts's
  `ClaudeExec`, so the container argv is a pure, testable value. Consequence:
  container bash output collapses to a single `onData` chunk. Real per-chunk
  streaming would use `spawn` (async) — a perf follow-up for Item A, not a
  correctness issue.
- **`.git/hooks` neutralization (container half)** = an empty **read-only tmpfs**
  over `<vault>/.git/hooks` (`--tmpfs <hooks>:ro`). The host-side
  `-c core.hooksPath=/dev/null` half remains Item D's.
- **Text-only file I/O**: read uses `cat` (utf8). Binary/image reads
  (`detectImageMimeType`) are omitted for the skeleton — a follow-up if the
  editor ever reads image references inside a run.
- **Provider is hard-coded `anthropic`** in `piRun` (fixed decision 4, one shared
  key). #70's per-tenant keys drop into the same `setRuntimeApiKey` call; Item A
  can widen provider selection from tenant config.
- **`piRun` takes `apiKey` directly** rather than run.ts's `auth: max|api`. The
  hosted path is always key-injected; Item A reconciles the manifest `auth` field
  at the dispatch.

## Interface delivered

`piRun(opts, deps?) -> Promise<string>` returns the final assistant text — the
same shape `runClaude` returns — ending in a `` ```outcomes ``` `` block that
`worker.ts`'s `parseOutcomes`/`detectFiled` consume unchanged. `deps.streamFn`
and `deps.dockerExec` are the two offline seams. Item A wires `piRun` behind the
`run.ts` `ClaudeExec`/`queue.engine` dispatch.
