import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyConfig } from "../lib/config";
import { configSave, integrationsInfo } from "../lib/configWrite";
import { emailConfig, parseInboxAdd, passwordEnvKey } from "../lib/emailConfig";
import { emailSources, readEmailState, writeEmailState } from "../lib/emailState";
import { readEnvValues } from "../lib/envFile";
import { loadManifest } from "../lib/manifest";

// The email integration's configuration surface (#744): inboxes in
// vault.yaml, app passwords in .env under a derived key, and the row the
// settings screen is told.

/** A scratch vault (the config.test.ts recipe): git-initialized so the
 * config path can commit, editor lock held by THIS process so the
 * post-commit poke exits instead of racing the assertions. */
const vault = (yaml: string): string => {
  const root = mkdtempSync(join(tmpdir(), "bb-emailcfg-"));
  for (const d of ["entities", ".state"]) mkdirSync(join(root, d), { recursive: true });
  writeFileSync(join(root, "vault.yaml"), yaml);
  writeFileSync(join(root, "entities", "note.md"), "---\nid: n-1\n---\nx\n");
  const g = (args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  g(["init", "-q"]);
  g(["config", "user.email", "test@test"]);
  g(["config", "user.name", "test"]);
  g(["add", "-A"]);
  g(["commit", "-q", "-m", "init"]);
  mkdirSync(join(root, ".state", "editor.lock"), { recursive: true });
  writeFileSync(join(root, ".state", "editor.lock", "pid"), `${process.pid}\n`);
  return root;
};

const BASE = ["# hand-written — comments must survive machine edits", "integrations:", "  granola: {}", ""].join("\n");

describe("emailConfig — the block, read tolerantly", () => {
  test("inboxes; malformed entries drop, addresses lowercase; a retired skip list is ignored", () => {
    const cfg = emailConfig({
      inboxes: [
        { address: "Alpha@Example.com", host: "imap.gmail.com" },
        { address: "not-an-address", host: "x" },
        { host: "no-address.example" },
        { address: "alpha@example.com", host: "dup.example" },
        { address: "b@example.org", host: "imap.example.org", port: 143 },
      ],
      skip: [{ sender: "NoReply@GitHub.com", reason: "CI", at: "2026-09-04" }, { reason: "no scope" }, { list: "L.example" }],
    });
    expect(cfg.inboxes).toEqual([
      { address: "alpha@example.com", host: "imap.gmail.com", port: 993 },
      { address: "b@example.org", host: "imap.example.org", port: 143 },
    ]);
    expect(cfg).not.toHaveProperty("skip");
    expect(emailConfig(undefined)).toEqual({ inboxes: [] });
  });

  test("passwordEnvKey derives a valid env name from the address", () => {
    expect(passwordEnvKey("Alpha.B+tag@Example.com")).toBe("BIGBRAIN_IMAP_PASSWORD__ALPHA_B_TAG_EXAMPLE_COM");
    expect(passwordEnvKey("a@b.c")).toMatch(/^[A-Z][A-Z0-9_]*$/u);
  });

  test("parseInboxAdd speaks in the form's words", () => {
    expect(parseInboxAdd({ address: "A@Example.com", host: "IMAP.Gmail.com", password: "abcd efgh" })).toEqual({
      address: "a@example.com",
      host: "imap.gmail.com",
      password: "abcd efgh",
    });
    expect(() => parseInboxAdd({ address: "nope", host: "imap.gmail.com", password: "x" })).toThrow(/address must be an email address/u);
    expect(() => parseInboxAdd({ address: "a@b.co", host: "not a host", password: "x" })).toThrow(/imap host/u);
    expect(() => parseInboxAdd({ address: "a@b.co", host: "imap.b.co", password: "  " })).toThrow(/app password is required/u);
    expect(() => parseInboxAdd({ address: "a@b.co", host: "imap.b.co", password: "x\ny" })).toThrow(/control characters/u);
  });
});

describe("applyConfig — adding, re-crediting and removing an inbox", () => {
  test("add: the address and host land in vault.yaml (committed, comments intact); the password lands in .env under its key and never in the commit", () => {
    const root = vault(BASE);
    const r = applyConfig(
      { integrations: [{ name: "email", add: { address: "Alpha@Example.com", host: "imap.gmail.com", password: "s3cret pass" } }] },
      root
    );
    expect(r.changed.sort()).toEqual([".env", "vault.yaml"]);
    expect(r.committed).toBe(true);
    const yaml = readFileSync(join(root, "vault.yaml"), "utf8");
    expect(yaml).toContain("# hand-written");
    expect(yaml).toMatch(/email:\n\s+inboxes:\n\s+- address: alpha@example.com\n\s+host: imap.gmail.com/u);
    expect(yaml).not.toContain("s3cret");
    expect(readEnvValues(root)[passwordEnvKey("alpha@example.com")]).toBe("s3cret pass");
    const log = spawnSync("git", ["log", "-1", "--format=%an %s"], { cwd: root, encoding: "utf8" }).stdout;
    expect(log).toContain("config");
    expect(log).toContain("alpha@example.com");
    expect(log).not.toContain("s3cret");
    // the manifest reads it back as an enabled integration with one inbox
    const m = loadManifest(root);
    expect(emailConfig(m.integrations["email"]).inboxes).toEqual([{ address: "alpha@example.com", host: "imap.gmail.com", port: 993 }]);
  });

  test("re-add with the same address replaces the password, keeps one inbox; a new host updates in place", () => {
    const root = vault(BASE);
    applyConfig({ integrations: [{ name: "email", add: { address: "a@example.com", host: "imap.one.example", password: "one" } }] }, root);
    const again = applyConfig({ integrations: [{ name: "email", add: { address: "a@example.com", host: "imap.one.example", password: "two" } }] }, root);
    expect(again.changed).toEqual([".env"]); // yaml unchanged: same address, same host
    expect(readEnvValues(root)[passwordEnvKey("a@example.com")]).toBe("two");
    applyConfig({ integrations: [{ name: "email", add: { address: "a@example.com", host: "imap.two.example", password: "three" } }] }, root);
    const inboxes = emailConfig(loadManifest(root).integrations["email"]).inboxes;
    expect(inboxes).toEqual([{ address: "a@example.com", host: "imap.two.example", port: 993 }]);
  });

  test("remove: the inbox leaves vault.yaml and its password is cleared; other inboxes stay", () => {
    const root = vault(BASE);
    applyConfig({ integrations: [{ name: "email", add: { address: "a@example.com", host: "imap.example", password: "pa" } }] }, root);
    applyConfig({ integrations: [{ name: "email", add: { address: "b@example.com", host: "imap.example", password: "pb" } }] }, root);
    const r = applyConfig({ integrations: [{ name: "email", remove: "A@example.com" }] }, root);
    expect(r.changed.sort()).toEqual([".env", "vault.yaml"]);
    expect(emailConfig(loadManifest(root).integrations["email"]).inboxes.map((i) => i.address)).toEqual(["b@example.com"]);
    const env = readEnvValues(root);
    expect(env[passwordEnvKey("a@example.com")] ?? "").toBe("");
    expect(env[passwordEnvKey("b@example.com")]).toBe("pb");
  });

  test("an add or remove on any other integration is refused; a bad form is refused before anything is written", () => {
    const root = vault(BASE);
    expect(() => applyConfig({ integrations: [{ name: "granola", add: { address: "a@b.co", host: "h.co", password: "x" } }] }, root)).toThrow(/no sources/u);
    expect(() => applyConfig({ integrations: [{ name: "email", add: { address: "bad", host: "imap.example", password: "x" } }] }, root)).toThrow(/address/u);
    expect(readFileSync(join(root, "vault.yaml"), "utf8")).toBe(BASE);
  });

  test("the settings screen's request shape, end to end through configSave — the inbox is probed, and saved only if it logs in", async () => {
    const root = vault(BASE);
    const probed: string[] = [];
    const ok = async (t: { address: string; host: string; password: string }) => { probed.push(`${t.address}@${t.host}:${t.password}`); };
    const r = await configSave(root, JSON.stringify({ integrations: [{ name: "email", add: { address: "a@example.com", host: "imap.example", password: "pw" } }] }), ok);
    expect(r.status).toBe(200);
    expect(probed).toEqual(["a@example.com@imap.example:pw"]);
    // a malformed form fails before any login is tried
    const bad = await configSave(root, JSON.stringify({ integrations: [{ name: "email", add: { address: "a@example.com", host: "imap.example", password: "" } }] }), ok);
    expect(bad.status).toBe(400);
    expect(JSON.parse(bad.body).error).toMatch(/app password is required/u);
    expect(probed.length).toBe(1);
    // a login that fails is the form's error, and nothing is written
    const rejected = async () => { throw new Error("password rejected"); };
    const before = readFileSync(join(root, "vault.yaml"), "utf8");
    const no = await configSave(root, JSON.stringify({ integrations: [{ name: "email", add: { address: "b@example.com", host: "imap.example", password: "wrong" } }] }), rejected);
    expect(no.status).toBe(400);
    expect(JSON.parse(no.body).error).toBe("password rejected");
    expect(readFileSync(join(root, "vault.yaml"), "utf8")).toBe(before);
    expect(readEnvValues(root)[passwordEnvKey("b@example.com")]).toBeUndefined();
    // a toggle or a remove never probes
    await configSave(root, JSON.stringify({ integrations: [{ name: "email", remove: "a@example.com" }] }), rejected);
    expect(emailConfig(loadManifest(root).integrations["email"]).inboxes).toEqual([]);
  });
});

describe("integrationsInfo — the email row", () => {
  test("email is listed (no longer retired) with its inboxes as sources and the add form; a granola row has neither", () => {
    const root = vault(BASE);
    applyConfig({ integrations: [{ name: "email", add: { address: "a@example.com", host: "imap.example", password: "pw" } }] }, root);
    const rows = integrationsInfo(root, loadManifest(root)) as { name: string; sources?: unknown[]; add?: { label: string } }[];
    const email = rows.find((r) => r.name === "email")!;
    expect(email.sources).toEqual([{ id: "a@example.com", label: "a@example.com", status: "ok", fields: { address: "a@example.com", host: "imap.example" } }]);
    expect(email.add?.label).toBe("ADD AN INBOX");
    expect((email.add as unknown as { fields: { key: string; default?: string }[] }).fields.find((f) => f.key === "host")?.default).toBe("imap.gmail.com");
    expect(rows.find((r) => r.name === "granola")!.sources).toBeUndefined();
  });

  test("emailSources: no password is `unset`; a failed last poll is `failed` with its reason and age; FIX gets the fields", () => {
    const root = vault(BASE);
    applyConfig({ integrations: [{ name: "email", add: { address: "a@example.com", host: "imap.example", password: "pw" } }] }, root);
    applyConfig({ integrations: [{ name: "email", add: { address: "b@example.com", host: "imap.example", password: "pw" } }] }, root);
    writeFileSync(join(root, ".env"), readFileSync(join(root, ".env"), "utf8").replace(/BIGBRAIN_IMAP_PASSWORD__B_EXAMPLE_COM=.*\n/u, ""));
    const state = readEmailState(root);
    state.inboxes["a@example.com"] = { lastUid: 10, last: { at: "2026-09-04T14:00:00Z", ok: false, error: "password rejected" } };
    writeEmailState(root, state);
    const cfg = emailConfig(loadManifest(root).integrations["email"]);
    expect(emailSources(root, cfg, new Date("2026-09-04T16:00:00Z"))).toEqual([
      { id: "a@example.com", label: "a@example.com", status: "failed", detail: "password rejected · 2h ago", fields: { address: "a@example.com", host: "imap.example" } },
      { id: "b@example.com", label: "b@example.com", status: "unset", detail: "no password", fields: { address: "b@example.com", host: "imap.example" } },
    ]);
  });

  test("readEmailState tolerates a missing or corrupt file", () => {
    const root = vault(BASE);
    expect(readEmailState(root)).toEqual({ inboxes: {} });
    writeFileSync(join(root, ".state", "email.json"), "{not json");
    expect(readEmailState(root)).toEqual({ inboxes: {} });
  });
});


test("two account checkpoints and pending bodies survive legacy preservation and cache deletion", () => {
  const root = vault(BASE);
  try {
    const state = { inboxes: { "a@example.com": { lastUid: 17 }, "b@example.com": { lastUid: 91, retry: [{ uid: 92, tries: 2 }] } } };
    writeFileSync(join(root, ".state", "email.json"), JSON.stringify(state));
    mkdirSync(join(root, ".state", "stage", "email"), { recursive: true });
    const item = { id: "pending-b", source: "email", account: "b@example.com", content: "Invented pending message", name: "pending.md", at: "2026-09-26", line: "Sample" };
    writeFileSync(join(root, ".state", "stage", "email", "pending-b.json"), JSON.stringify(item));
    expect(readEmailState(root)).toEqual(state);
    rmSync(join(root, ".state"), { recursive: true });
    expect(readEmailState(root)).toEqual(state);
    expect(JSON.parse(readFileSync(join(root, ".spool", "stage", "email", "bodies", "pending-b.json"), "utf8"))).toEqual(item);
    writeFileSync(join(root, ".spool", "email.json"), "{damaged");
    expect(readEmailState(root)).toEqual({ inboxes: {} });
    expect(readFileSync(join(root, ".spool", "email.json"), "utf8")).toBe("{damaged");
    expect(JSON.parse(readFileSync(join(root, ".spool", "stage", "email", "bodies", "pending-b.json"), "utf8"))).toEqual(item);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
