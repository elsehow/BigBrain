import { ApplicationActions } from "../lib/applicationActions";
import { fakeIntegrationActivation } from "./support/integrationActivation";
import { afterAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ImapFlow } from "imapflow";
import { createEmailReadStateAdapter } from "../lib/emailReadState";
import { createSourceReadStateService, type SourceReadStateAdapter } from "../lib/sourceReadState";
import { aggregateReadState, type SourceReadState } from "../lib/sourceReadStateTypes";
import { insertionEventRel } from "../lib/insertionLog";
import { sourceThreads } from "../lib/sourceThreads";
import { sourceReadStateRoutes } from "../lib/sourceReadStateApi";
import { insertion, nativeVault } from "./support/vault";

const roots: string[] = [];
afterAll(() => roots.forEach(root => rmSync(root, { recursive: true, force: true })));
const email = (i: number, account = "me@example.com") => insertion({ id: `ins_${i.toString(16).padStart(24, "0")}`,
  title: "Conference travel planning with the team", envelope: { source: "email", inbox: account,
    message_id: `<message-${i}@example.com>`, url: "https://mail.google.com/mail/u/0/#all/abc" } });
function vault(sources = [email(1), email(2)]) {
  const root = nativeVault({ insertions: sources, files: {
    "vault.yaml": "integrations:\n  email:\n    enabled: true\n    inboxes:\n      - address: me@example.com\n        host: imap.gmail.com\n      - address: work@example.com\n        host: imap.gmail.com\n",
    ".env": "BIGBRAIN_IMAP_PASSWORD__ME_EXAMPLE_COM=test-password\nBIGBRAIN_IMAP_PASSWORD__WORK_EXAMPLE_COM=test-password\n",
  } }); fakeIntegrationActivation(root); roots.push(root); return root;
}
function provider() {
  const mail = new Map<string, Array<{ uid: number; envelope: { messageId: string }; flags: Set<string> }>>([
    ["me@example.com", [1, 2].map(uid => ({ uid, envelope: { messageId: `<message-${uid}@example.com>` }, flags: new Set(uid === 1 ? ["\\Flagged"] : ["\\Seen", "\\Answered"]) }))],
    ["work@example.com", [{ uid: 1, envelope: { messageId: "<message-1@example.com>" }, flags: new Set(["\\Seen"]) }]],
  ]);
  const locks: Array<{ account: string; path: string; readOnly: boolean }> = [];
  const writes: Array<{ account: string; uid: number; unread: boolean }> = [];
  const failAccounts = new Set<string>();
  const failSearches = new Set<number>();
  const searches: string[][] = [];
  let denyWrites = false, ignoreWrites = false, goneAtConfirm = false, closed = 0, released = 0;
  const factory = (account: { address: string }) => {
    let readOnly = true;
    const messages = () => mail.get(account.address) ?? [];
    const check = (query: any, options: any) => { expect(query.source).toBeUndefined(); expect(options).toEqual({ uid: true }); };
    const change = async (ids: number[], flags: string[], options: unknown, unread: boolean) => {
      expect(readOnly).toBe(false); expect(flags).toEqual(["\\Seen"]); expect(options).toEqual({ uid: true });
      if (denyWrites) return false;
      for (const uid of ids) {
        writes.push({ account: account.address, uid, unread });
        const m = messages().find(m => m.uid === uid)!;
        if (!ignoreWrites) { if (unread) m.flags.delete("\\Seen"); else m.flags.add("\\Seen"); }
      }
      return true;
    };
    return {
      mailbox: { readOnly: false, uidValidity: 55n }, on() {},
      async connect() { if (failAccounts.has(account.address)) throw new Error("secret provider error"); },
      close() { closed++; },
      async list() { return [{ path: "[Gmail]/All Mail", specialUse: "\\All" }]; },
      async getMailboxLock(path: string, options: { readOnly: boolean }) {
        readOnly = options.readOnly; locks.push({ account: account.address, path, readOnly });
        return { release() { released++; } };
      },
      async search(query: any, options: any) {
        expect(options).toEqual({ uid: true });
        searches.push(query.or.map((q: any) => q.header["Message-ID"]));
        if (failSearches.has(searches.length)) throw new Error("Connection closed during search");
        return messages().filter(m => query.or.some((q: any) => m.envelope.messageId.includes(q.header["Message-ID"]))).map(m => m.uid);
      },
      async fetchAll(ids: number[], query: any, options: any) { check(query, options); expect(ids.length).toBeGreaterThan(0); return messages().filter(m => ids.includes(m.uid)); },
      async fetchOne(uid: string, query: any, options: any) { check(query, options); return goneAtConfirm ? false : messages().find(m => m.uid === Number(uid)) ?? false; },
      messageFlagsAdd: (ids: number[], flags: string[], options: unknown) => change(ids, flags, options, false),
      messageFlagsRemove: (ids: number[], flags: string[], options: unknown) => change(ids, flags, options, true),
    } as unknown as ImapFlow;
  };
  return { adapter: createEmailReadStateAdapter(factory), mail, locks, writes, failAccounts, failSearches, searches,
    deny() { denyWrites = true; }, ignore() { ignoreWrites = true; }, disappear() { goneAtConfirm = true; },
    closed: () => closed, released: () => released };
}

test("existing stored emails reflect Gmail, agent reads preserve flags, and writes sync both ways", async () => {
  const a = email(1), b = email(2), root = vault([a, b]), p = provider();
  let now = Date.now();
  const service = createSourceReadStateService([p.adapter], { now: () => now });
  expect(service.peek(root).find(r => r.path === insertionEventRel(a))!.readState.unread).toBeNull();
  const rows = await service.refresh(root);
  expect(rows.find(r => r.path === insertionEventRel(a))!.readState).toMatchObject({ unread: true, status: "synced", provider: "email" });
  expect(rows.find(r => r.path === insertionEventRel(b))!.readState.unread).toBe(false);
  expect(p.writes).toHaveLength(0);
  expect(p.locks[0]).toMatchObject({ readOnly: true, path: "[Gmail]/All Mail" });
  // External Gmail changes become visible on the next refresh window.
  p.mail.get("me@example.com")![0]!.flags.add("\\Seen"); now += 60_001;
  expect(service.peek(root)[0]!.readState.unread).toBeNull();
  expect((await service.refresh(root)).find(r => r.path === insertionEventRel(a))!.readState.unread).toBe(false);
  expect((await service.setUnread(root, [insertionEventRel(a)], true)).ok).toBe(true);
  expect(p.mail.get("me@example.com")![0]!.flags).toEqual(new Set(["\\Flagged"]));
  expect((await service.setUnread(root, [insertionEventRel(a)], false)).ok).toBe(true);
  expect(p.mail.get("me@example.com")![0]!.flags).toEqual(new Set(["\\Flagged", "\\Seen"]));
  expect(p.closed()).toBe(p.released());
});

test("read state is account-scoped and substring or duplicate Message-IDs never redirect a write", async () => {
  const root = vault(), p = provider(), a = email(1), other = email(1, "work@example.com");
  const result = await p.adapter.read(root, [other]);
  expect(result.get(other.id)!.unread).toBe(false);
  await p.adapter.setUnread(root, other, true);
  expect(p.writes).toEqual([{ account: "work@example.com", uid: 1, unread: true }]);
  p.mail.set("me@example.com", [{ uid: 99, envelope: { messageId: "prefix<message-1@example.com>suffix" }, flags: new Set() }]);
  expect((await p.adapter.read(root, [a])).get(a.id)!.status).toBe("missing");
  await expect(p.adapter.setUnread(root, a, false)).rejects.toThrow("missing or ambiguous");
  p.mail.set("me@example.com", [1, 2].map(uid => ({ uid, envelope: { messageId: "<message-1@example.com>" }, flags: new Set() })));
  await expect(p.adapter.setUnread(root, a, false)).rejects.toThrow("missing or ambiguous");
  expect(p.writes).toHaveLength(1);
});

test("provider failures and unavailable sources are unknown, never read or successful writes", async () => {
  const root = vault(), a = email(1), p = provider();
  p.failAccounts.add("me@example.com");
  const service = createSourceReadStateService([p.adapter]);
  expect((await service.refresh(root))[0]!.readState).toMatchObject({ unread: null, status: "unavailable", writable: false });
  const failed = await service.setUnread(root, [insertionEventRel(a)], false);
  expect(failed.ok).toBe(false); expect(JSON.stringify(failed)).not.toContain("secret");
  for (const mode of ["deny", "ignore", "disappear"] as const) {
    const other = provider(); other[mode]();
    await expect(other.adapter.setUnread(root, a, false)).rejects.toThrow();
    expect(other.closed()).toBe(1); expect(other.released()).toBe(1);
  }
});

test("thread changes target stored members once and preserve per-message failures", async () => {
  const a = email(1), b = email(2), root = vault([a, b]), p = provider();
  p.mail.get("me@example.com")!.splice(1, 1); // message 2 was removed remotely
  const service = createSourceReadStateService([p.adapter]);
  const thread = sourceThreads([a, b])[0]!;
  const result = await service.setUnread(root, [thread.path, insertionEventRel(a)], false);
  expect(result.results).toHaveLength(2); expect(result.results.filter(r => r.ok)).toHaveLength(1); expect(result.ok).toBe(false);
  expect(p.writes).toHaveLength(1);
  const state = (await service.refresh(root)).find(r => r.path === thread.path)!.readState;
  expect(state.unread).toBeNull(); expect(state.writable).toBe(false);
  const before = p.writes.length;
  await expect(service.setUnread(root, [insertionEventRel(a), "../../.env"], true)).rejects.toThrow("Source not found");
  await expect(service.setUnread(root, [insertionEventRel(a)], "false")).rejects.toThrow("boolean");
  expect(p.writes).toHaveLength(before);
});

test("new integrations use the same contract; concurrent refresh cannot overwrite a newer mutation", async () => {
  const source = insertion({ envelope: { source: "future-chat" } });
  let unread = true, reads = 0, release!: () => void;
  const gate = new Promise<void>(r => release = r);
  const state = (): SourceReadState => ({ unread, status: "synced", provider: "future-chat", writable: true });
  const adapter: SourceReadStateAdapter = { provider: "future-chat", supports: s => s.envelope.source === "future-chat",
    async read() { reads++; await gate; return new Map([[source.id, state()]]); },
    async setUnread(_root, _s, value) { unread = value; return state(); } };
  const service = createSourceReadStateService([adapter], { sources: () => [source] });
  const refreshing = service.refresh("scratch"), writing = service.setUnread("scratch", [insertionEventRel(source)], false);
  release(); await refreshing; expect((await writing).ok).toBe(true);
  expect((await service.refresh("scratch"))[0]!.readState.unread).toBe(false);
  expect(reads).toBe(2);
  expect(aggregateReadState([state(), { unread: null, writable: false, status: "unknown" }]).unread).toBeNull();
  expect(aggregateReadState([{ ...state(), unread: true }, { unread: null, writable: false, status: "unknown" }]).unread).toBe(true);
  const unsupported = createSourceReadStateService([], { sources: () => [source] });
  expect((await unsupported.refresh("scratch"))[0]!.readState).toMatchObject({ unread: null, status: "unsupported" });
});

test("HTTP read-state writes validate origin and JSON before provider access and expose partial receipts", async () => {
  const a = email(1), b = email(2), root = vault([a, b]), p = provider();
  p.mail.get("me@example.com")!.splice(1, 1);
  const routes = sourceReadStateRoutes(root, createSourceReadStateService([p.adapter]));
  async function request(method: "GET" | "POST", body?: unknown, headers: Record<string, string> = { "content-type": "application/json", host: "127.0.0.1:4799", origin: "http://127.0.0.1:4799" }) {
    return new Promise<{ status: number; body: any }>(resolve => {
      const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
      req.headers = headers;
      let status = 0;
      const res = { writeHead(code: number) { status = code; }, end(text: string) { resolve({ status, body: JSON.parse(text) }); } } as ServerResponse;
      routes.find(r => r.method === method)!.handler({ req, res, url: new URL("http://127.0.0.1:4799/api/source/read-state") });
    });
  }
  const body = { actionId: "fabricated-read-batch", paths: [insertionEventRel(a), insertionEventRel(b)], unread: false };
  expect((await request("POST", body, { "content-type": "text/plain" })).status).toBe(415);
  expect((await request("POST", body, { "content-type": "application/json", host: "127.0.0.1:4799", origin: "https://example.com" })).status).toBe(403);
  expect(p.writes).toHaveLength(0);
  const read = await request("GET");
  expect(read.body.scope).toBe("stored_sources"); expect(p.writes).toHaveLength(0);
  const write = await request("POST", body);
  expect(write.status).toBe(200); expect(write.body.ok).toBe(false);
  expect(write.body.results.filter((r: any) => r.ok)).toHaveLength(1);
  expect(p.writes).toHaveLength(1);
  expect((await request("POST", body)).body).toEqual(write.body);
  expect(p.writes).toHaveLength(1);
  expect((await request("POST", { ...body, unread: true })).status).toBe(400);
  const receipts = new ApplicationActions(root).list({ kind: "user", id: "desktop" }).receipts;
  expect(receipts.filter(r => r.operation === "source_set_unread.item").map(r => r.status).sort()).toEqual(["completed", "uncertain"]);
});

test("read refresh reconnects only for unresolved imported messages and preserves confirmed batches", async () => {
  const sources = Array.from({ length: 55 }, (_, i) => email(i + 1)), root = vault(sources);
  for (const permanent of [false, true]) {
    const p = provider();
    p.mail.set("me@example.com", sources.map((s, i) => ({ uid: i + 1, envelope: { messageId: s.envelope.message_id as string }, flags: new Set<string>() })));
    p.failSearches.add(2);
    if (permanent) p.failSearches.add(3);
    const states = await p.adapter.read(root, sources);
    expect(states.get(sources[0]!.id)).toMatchObject({ unread: true, status: "synced" });
    expect(states.get(sources[54]!.id)).toMatchObject(permanent ? { unread: null, status: "unavailable" } : { unread: true, status: "synced" });
    expect(p.searches.map(ids => ids.length)).toEqual([50, 5, 5]);
    expect(p.searches[2]).toEqual(sources.slice(50).map(s => s.envelope.message_id));
    expect(p.writes).toHaveLength(0);
    expect(p.closed()).toBe(2); expect(p.released()).toBe(2);
  }
});

test("explicit refresh bypasses cached failures and immediately observes imported mail flag changes", async () => {
  const a = email(1), root = vault([a]), p = provider();
  const service = createSourceReadStateService([p.adapter]);
  p.failAccounts.add("me@example.com");
  expect((await service.refresh(root))[0]!.readState.status).toBe("unavailable");
  p.failAccounts.clear();
  expect((await service.refresh(root))[0]!.readState.status).toBe("unavailable");
  expect((await service.refresh(root, true))[0]!.readState.unread).toBe(true);
  p.mail.get("me@example.com")![0]!.flags.add("\\Seen");
  expect((await service.refresh(root, true))[0]!.readState.unread).toBe(false);
  expect(p.writes).toHaveLength(0);
});
