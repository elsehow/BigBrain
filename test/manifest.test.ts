import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const vault = (yaml: string): string =>
  mdVault({ prefix: "bb-manifest-", files: { "vault.yaml": yaml } });

/** The minimal prelude every fixture below shares — loadManifest needs a
 * parseable document, nothing more. */
const BASE = "integrations: {}\n";

// A plain import: this module is side-effect-free and takes its root as an
// argument. It used to resolve VAULT_ROOT at import, so this file died on a
// machine with no vault — a red suite that said nothing about the code, only
// about whose laptop it ran on (test/vaultRoot.test.ts keeps it that way).
import { integrationEnabledIn, loadManifest } from "../lib/manifest";
import { mdVault } from "./support/vault";

describe("the gardener's model", () => {
  test("no block anywhere → the default model and `max` auth", () => {
    const m = loadManifest(vault(BASE));
    expect(m.gardener).toEqual({ adapter: "pi", provider: "anthropic", model: "claude-opus-5" });
    expect(m.auth).toBe("max");
  });

  test("gardener.model is honored verbatim", () => {
    const m = loadManifest(vault(BASE + "gardener:\n  model: claude-opus-4-8\n"));
    expect(m.gardener.model).toBe("claude-opus-4-8");
  });

  // The block was `queue:` while the typed work queue existed, and every
  // vault written before #524 names it that way. Reading it is the whole
  // reason a live vault survives the rename.
  test("a legacy queue.model still names the gardener's model", () => {
    const m = loadManifest(vault(BASE + "queue:\n  model: claude-opus-4-8\n"));
    expect(m.gardener.model).toBe("claude-opus-4-8");
  });

  test("older still: deep.model, then triage.model", () => {
    expect(loadManifest(vault(BASE + "deep:\n  model: from-deep\n")).gardener.model).toBe(
      "from-deep"
    );
    expect(loadManifest(vault(BASE + "triage:\n  model: from-triage\n")).gardener.model).toBe(
      "from-triage"
    );
  });

  test("newest name wins when a vault carries several", () => {
    const m = loadManifest(
      vault(
        BASE +
          "triage:\n  model: from-triage\ndeep:\n  model: from-deep\n" +
          "queue:\n  model: from-queue\ngardener:\n  model: from-gardener\n"
      )
    );
    expect(m.gardener.model).toBe("from-gardener");
    expect(loadManifest(vault(BASE + "deep:\n  model: d\nqueue:\n  model: q\n")).gardener.model).toBe(
      "q"
    );
  });
});

describe("auth — one credential for the whole vault", () => {
  test("top-level auth is read; the default is max", () => {
    expect(loadManifest(vault(BASE + "auth: api\n")).auth).toBe("api");
    expect(loadManifest(vault(BASE)).auth).toBe("max");
  });

  test("a bad top-level auth throws", () => {
    expect(() => loadManifest(vault(BASE + "auth: subscription\n"))).toThrow(
      /auth must be "max" or "api"/
    );
  });

  // The per-pass overrides went with the passes (#524). A vault that still
  // carries one is not wrong, just out of date — and a stale override must
  // never fail the load, nor quietly beat the top-level key.
  test("a per-pass auth override is ignored, not fatal — even a nonsense one", () => {
    const m = loadManifest(vault(BASE + "auth: api\nqueue:\n  model: m\n  auth: subscription\n"));
    expect(m.auth).toBe("api");
  });
});

describe("the memory pass", () => {
  test("no block → the gardener's model and the production-lean cadence", () => {
    const m = loadManifest(vault(BASE + "gardener:\n  model: the-model\n"));
    expect(m.memory).toEqual({
      adapter: "pi", provider: "anthropic", model: "the-model",
      interval: "1d",
      intervalMs: 86_400_000,
    });
  });

  test("its own model and cadence are honored", () => {
    const m = loadManifest(
      vault(BASE + "gardener:\n  model: g\nmemory:\n  model: m\n  interval: 6h\n")
    );
    expect(m.memory.model).toBe("m");
    expect(m.memory.intervalMs).toBe(21_600_000);
  });

  test("an unparseable memory duration throws", () => {
    expect(() => loadManifest(vault(BASE + "memory:\n  interval: sometimes\n"))).toThrow(
      /unparseable duration/
    );
  });

  test("memory: itself must be a mapping, not a list or scalar", () => {
    expect(() => loadManifest(vault(BASE + "memory: not-a-map\n"))).toThrow(
      /memory must be a mapping/
    );
  });
});

describe("keys the engine no longer reads", () => {
  // design-principles §5: ignore, never fail. Everything here was load-bearing
  // in some earlier engine, and a vault.yaml is a file a person keeps.
  test.each([
    ["assertions (retired #498)", "assertions:\n  native: true\n"],
    ["the retired editor's passes", "triage:\n  debounce: 10m\ndeep:\n  debounce: 1h\n"],
    ["the worker debounce nothing read", "queue:\n  model: m\n  debounce: 2m\n"],
    ["a host pointer (the retired mirror)", "host:\n  url: https://example.invalid\n"],
    ["an unparseable stale duration", "queue:\n  debounce: sometimes\n"],
    ["the memory pass's settle clock (retired 2026-09-02)", "memory:\n  debounce: 6h\n"],
    ["an unparseable settle clock", "memory:\n  debounce: sometimes\n"],
  ])("%s loads without throwing", (_label, yaml) => {
    expect(() => loadManifest(vault(BASE + yaml))).not.toThrow();
  });

  test("and none of them appear on the manifest", () => {
    const m = loadManifest(vault(BASE + "triage:\n  model: t\nqueue:\n  debounce: 2m\n"));
    for (const key of ["triage", "deep", "queue", "assertions", "host"])
      expect(key in m).toBe(false);
    const mm = loadManifest(vault(BASE + "memory:\n  debounce: 6h\n"));
    expect("debounce" in mm.memory).toBe(false);
  });
});

describe("an empty vault.yaml", () => {
  test("loads with defaults rather than throwing on a null document", () => {
    const m = loadManifest(vault("\n"));
    expect(m.integrations).toEqual({});
    expect(m.gardener.model).toBe("claude-opus-5");
  });
});

test("retired transcript capture stays off in legacy manifests", () => {
  expect(integrationEnabledIn({ "agent-chat": { enabled: true } }, "agent-chat")).toBe(false);
  expect(integrationEnabledIn({ granola: { enabled: true } }, "granola")).toBe(true);
});


test("legacy Pi roles read unchanged while canonical Pi choices require explicit providers", () => {
  const root = mdVault({ files: { "vault.yaml": "gardener: { agent: pi, model: example }\nmemory: { agent: pi, model: example }\nquick: { agent: pi, model: example }\n" } });
  try {
    const before = readFileSync(join(root, "vault.yaml"), "utf8");
    const m = loadManifest(root);
    for (const role of [m.gardener, m.memory, m.quick]) expect(role).toMatchObject({ adapter: "pi", provider: "openai-codex", model: "example" });
    expect(readFileSync(join(root, "vault.yaml"), "utf8")).toBe(before);
    writeFileSync(join(root, "vault.yaml"), "gardener: { adapter: pi, model: example }\n");
    expect(() => loadManifest(root)).toThrow("Choose a Pi provider");
    writeFileSync(join(root, "vault.yaml"), "gardener: { adapter: pi, provider: openai, model: example }\n");
    expect(loadManifest(root).gardener).toEqual({ adapter: "pi", provider: "openai", model: "example" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
