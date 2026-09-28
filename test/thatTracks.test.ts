import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pollThatTracks, ThatTracksClient, tracksContent, type TracksChange } from "../lib/thatTracks";
import { receive } from "../lib/intake";
import { readSourceInsertionLog } from "../lib/insertionLog";
import { supersededInsertionIds } from "../lib/sourceSupersede";

const roots: string[] = [];
const scratch = () => { const r = mkdtempSync(join(tmpdir(), "bb-tracks-")); roots.push(r); return r; };
afterEach(() => roots.splice(0).forEach(r => rmSync(r, { recursive: true, force: true })));
const account = "00000000-0000-0000-0000-000000000001";
const category = "00000000-0000-0000-0000-000000000002";
const tracker = "00000000-0000-0000-0000-000000000003";
const event = "00000000-0000-0000-0000-000000000004";
const at = "2026-09-12T16:00:00.000Z";
const change = (n: number, entity: TracksChange["entity"], record: Record<string, unknown>, operation: TracksChange["operation"] = "upsert"): TracksChange => ({
  cursor: String(n), entity, operation, record: { revision: 1, updatedAt: at, ...record } as TracksChange["record"],
});
const initial = () => [
  change(1, "categories", { id: category, name: "Health" }),
  change(2, "trackers", { id: tracker, name: "Water", categoryID: category, config: { amount: { unit: "cup", plural: "cups" } }, archived: true }),
  change(3, "events", { id: event, trackerID: tracker, timestamp: "2020-01-01T12:00:00.000Z", value: 0, source: "hand", note: "Full note\n\nincluding its ending." }),
];
function fixture(items = initial(), opts: { pageSize?: number; account?: string; allowed?: string[] | null } = {}) {
  const requested: string[] = [];
  const client = new ThatTracksClient("tt_fixture", "https://fixture.invalid", (async (input, init) => {
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer tt_fixture");
    expect(init?.redirect).toBe("error");
    const url = new URL(String(input)); requested.push(url.pathname + url.search);
    if (url.pathname === "/me") return Response.json({ id: opts.account ?? account, scopes: ["read"], trackerIDs: opts.allowed ?? null });
    const cursor = BigInt(url.searchParams.get("cursor")!);
    const rest = items.filter(c => BigInt(c.cursor) > cursor);
    const page = rest.slice(0, opts.pageSize ?? 100);
    return Response.json({ items: page, nextCursor: page.at(-1)?.cursor ?? String(cursor), hasMore: rest.length > page.length });
  }) as typeof fetch);
  return { client, items, requested };
}

describe("That Tracks ingestion", () => {
  test("all history, archived metadata, zero and full notes land; quiet polls and full replay deduplicate", async () => {
    const root = scratch(); const f = fixture(initial(), { pageSize: 1 });
    expect((await pollThatTracks(root, "key", f)).arrivals).toBe(3);
    const events = readSourceInsertionLog(root);
    const entry = events.find(e => e.envelope.key === `events:${event}`)!;
    expect(entry.body).toContain("Value: 0 cups");
    expect(entry.body).toContain("Category: Health");
    expect(entry.body).toContain("Full note\n\nincluding its ending.");
    expect(entry.occurred_at).toBe("2020-01-01T12:00:00.000Z");
    expect(entry.envelope.that_tracks).toEqual(f.items[2]);
    expect((await pollThatTracks(root, "key", f)).arrivals).toBe(0);
    rmSync(join(root, ".spool"), { recursive: true });
    rmSync(join(root, ".state"), { recursive: true });
    expect((await pollThatTracks(root, "key", f)).arrivals).toBe(0);
    expect(readSourceInsertionLog(root)).toHaveLength(3);
  });

  test("a crash after landing but before checkpoint is replayed without duplicate or self-supersession", async () => {
    const root = scratch(); const f = fixture(); let count = 0;
    await expect(pollThatTracks(root, "key", { ...f, land: opts => {
      const result = receive(opts); if (++count === 3) throw new Error("power lost"); return result;
    } })).rejects.toThrow("power lost");
    expect((await pollThatTracks(root, "key", f)).arrivals).toBe(0);
    const events = readSourceInsertionLog(root);
    expect(events).toHaveLength(3);
    expect(events.every(e => e.envelope.supersedes !== e.id)).toBe(true);
  });

  test("old-event corrections and tombstones supersede earlier evidence, retaining the whole history", async () => {
    const root = scratch(); const f = fixture(); await pollThatTracks(root, "key", f);
    f.items.push(change(4, "events", { ...f.items[2]!.record, revision: 2, value: 2, note: "Corrected" }));
    expect((await pollThatTracks(root, "key", f)).arrivals).toBe(1);
    f.items.push(change(5, "events", { id: event, trackerID: tracker, revision: 3, deletedAt: at }, "delete"));
    await pollThatTracks(root, "key", f);
    const events = readSourceInsertionLog(root);
    const hidden = supersededInsertionIds(events);
    const revisions = events.filter(e => e.envelope.key === `events:${event}`);
    expect(revisions).toHaveLength(3);
    expect(revisions.filter(e => !hidden.has(e.id))).toHaveLength(1);
    const withdrawal = revisions.find(e => !hidden.has(e.id))!;
    expect(withdrawal.title).toBe("Withdrawn from That Tracks — Water");
    expect(withdrawal.body).toContain("withdrawn evidence");
    expect(revisions.find(e => e.envelope.seq === 2)!.body).toContain("Value: 2 cups");
  });

  test("bounded backfill resumes; key or account replacement restarts from zero without duplicate history", async () => {
    const root = scratch(); const f = fixture(initial(), { pageSize: 1 });
    expect((await pollThatTracks(root, "key", { ...f, maxPages: 1 })).detail).toContain("continuing");
    expect((await pollThatTracks(root, "key", f)).arrivals).toBe(2);
    f.requested.length = 0;
    expect((await pollThatTracks(root, "replacement", f)).arrivals).toBe(0);
    expect(f.requested[1]).toContain("cursor=0");
    const other = fixture(initial(), { account: "00000000-0000-0000-0000-000000000099" });
    expect((await pollThatTracks(root, "other", other)).arrivals).toBe(3);
    expect(readSourceInsertionLog(root)).toHaveLength(6);
    expect(readFileSync(join(root, ".spool/that-tracks/checkpoint.json"), "utf8")).not.toContain("replacement");
  });

  test("metadata renames are retained and later entries use the new labels", async () => {
    const root = scratch(); const f = fixture(); await pollThatTracks(root, "key", f);
    f.items.push(change(4, "categories", { id: category, name: "Daily", revision: 2 }));
    f.items.push(change(5, "trackers", { ...f.items[1]!.record, name: "Tea", revision: 2 }));
    f.items.push(change(6, "events", { ...f.items[2]!.record, id: "00000000-0000-0000-0000-000000000005", value: 1 }));
    await pollThatTracks(root, "key", f);
    expect(readSourceInsertionLog(root).find(e => e.title.startsWith("Tea —"))!.body).toContain("Category: Daily\nValue: 1 cup");
  });

  test("full long text and selected types survive rendering, without synthesizing entries", () => {
    const c = change(3, "events", { ...initial()[2]!.record, options: ["a", "b"], note: "long dream\n".repeat(10000) });
    const content = tracksContent(account, c, { categories: {}, trackers: {} });
    expect(content).toContain("Selected: a, b");
    expect(content).toContain("long dream\n".repeat(10000));
  });
});

describe("API failures", () => {
  test.each([401, 403, 429, 500])("HTTP %s never records success or includes a response body", async status => {
    const client = new ThatTracksClient("secret", "https://fixture.invalid", (async () => new Response("secret echoed", { status })) as typeof fetch);
    await expect(client.identity()).rejects.toThrow(status === 401 || status === 403 ? "rejected the key" : status === 429 ? "rate limiting" : "HTTP 500");
  });
  test("out-of-order pages and malformed events fail before any page lands", async () => {
    for (const items of [[initial()[1], initial()[0]], [change(1, "events", { id: event })]]) {
      const client = new ThatTracksClient("key", "https://fixture.invalid", (async () => Response.json({ items, nextCursor: "3", hasMore: false })) as typeof fetch);
      await expect(client.changes("0")).rejects.toThrow("invalid");
    }
  });
  test("empty restricted-grant pages can advance over hidden changes; cursors exceed JS integer precision", async () => {
    const client = new ThatTracksClient("key", "https://fixture.invalid", (async () => Response.json({ items: [], nextCursor: "9007199254740995", hasMore: false })) as typeof fetch);
    expect((await client.changes("9007199254740993")).nextCursor).toBe("9007199254740995");
  });
});
