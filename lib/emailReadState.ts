import { integrationConnected } from "./integrationAccess";
/** Provider-owned read state for existing and future email sources. Uses Gmail message ID + account,
 * falling back to exact RFC Message-ID for older evidence. */
import { ImapFlow, type FetchMessageObject } from "imapflow";
import { emailConfig, passwordEnvKey, gmailReadOnly, type Inbox } from "./emailConfig";
import { readEnvValues } from "./envFile";
import { loadManifest } from "./manifest";
import type { SourceMetadata } from "./insertionLog";
import type { SourceReadStateAdapter, SourceReadState } from "./sourceReadState";

type Factory = (account: Inbox, password: string) => ImapFlow;
const factory: Factory = (account, pass) => new ImapFlow({ host: account.host, port: account.port, secure: true,
  auth: { user: account.address, pass }, logger: false, emitLogs: false,
  connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 25_000 });
function identity(s: SourceMetadata) {
  const e = s.envelope;
  if (e.source !== "email" && e.kind !== "email") return;
  const account = typeof e.inbox === "string" ? e.inbox.trim().toLowerCase() : "";
  const messageId = typeof e.message_id === "string" ? e.message_id.trim() : "";
  const emailId=typeof e.provider_message_id==="string"&&/^\d+$/.test(e.provider_message_id)?e.provider_message_id:undefined;
  if (!account || (!messageId&&!emailId) || messageId.length > 998 || /[\r\n\0]/u.test(messageId)) return;
  return { account, messageId, emailId };
}
const flags = { uid: true, envelope: true, flags: true } as const;
const unknown = (status: SourceReadState["status"]): SourceReadState => ({ unread: null, provider: "email", status, writable: false });
const observed = (m: FetchMessageObject, writable: boolean): SourceReadState => m.flags instanceof Set
  ? { unread: !m.flags.has("\\Seen"), provider: "email", status: "synced", writable, checkedAt: new Date().toISOString() }
  : unknown("unknown");

/** `userSeen`: the viewer's own mark-read/unread. A Gmail connection is
 * read-only to every agent, but the person may flip \\Seen on their own mail
 * from the app — that flag and nothing else. */
export function createEmailReadStateAdapter(makeClient: Factory = factory, access: {authorize?: () => void; signal?: AbortSignal; userSeen?: boolean} = {}): SourceReadStateAdapter {
  const readOnly = (root: string, address: string) => !access.userSeen && gmailReadOnly(root, address);
  async function connected<T>(root: string, address: string, write: boolean, run: (client: ImapFlow) => Promise<T>): Promise<T> {
    if (write && readOnly(root, address)) throw new Error("Gmail connections are read-only.");
    if (!integrationConnected(root, "email", address)) throw new Error("Email integration is inactive.");
    const account = emailConfig(loadManifest(root).integrations.email).inboxes.find(i => i.address === address);
    const pass = account && readEnvValues(root)[passwordEnvKey(address)];
    if (!account || !pass) throw new Error("Email account is not connected.");
    access.authorize?.(); access.signal?.throwIfAborted();
    const client = makeClient(account, pass);
    const abort = () => client.close();
    access.signal?.addEventListener("abort", abort, {once:true});
    client.on("error", () => {});
    const timeout = setTimeout(() => client.close(), 60_000); timeout.unref?.();
    try {
      await client.connect();
      access.authorize?.(); access.signal?.throwIfAborted();
      const mailbox = (await client.list()).find(b => b.specialUse === "\\All")?.path ?? "INBOX";
      const lock = await client.getMailboxLock(mailbox, { readOnly: !write });
      try {
        if (!client.mailbox || write && client.mailbox.readOnly) throw new Error("Mailbox is not writable.");
        if (write && readOnly(root, address)) throw new Error("Gmail connections are read-only.");
        if (!integrationConnected(root, "email", address)) throw new Error("Email integration is inactive.");
        access.authorize?.(); access.signal?.throwIfAborted();
        const result = await run(client);
        access.authorize?.(); access.signal?.throwIfAborted();
        if (write && readOnly(root, address)) throw new Error("Gmail connections are read-only.");
        if (!integrationConnected(root, "email", address)) throw new Error("Email integration is inactive.");
        return result;
      } finally { lock.release(); }
    } finally { clearTimeout(timeout); access.signal?.removeEventListener("abort", abort); client.close(); }
  }
  async function find(client: ImapFlow, ids: NonNullable<ReturnType<typeof identity>>[]) {
    const found = await client.search({ or: ids.map(id => id.emailId ? {emailId:id.emailId} : ({ header: { "Message-ID": id.messageId } })) }, { uid: true });
    if (!found || !found.length) return [];
    const rows: FetchMessageObject[] = [];
    for (let i = 0; i < found.length; i += 200) rows.push(...await client.fetchAll(found.slice(i, i + 200), flags, { uid: true }));
    return rows;
  }
  return {
    provider: "email", supports: s => !!identity(s),
    async read(root, sources) {
      const result = new Map<string, SourceReadState>();
      const accounts = new Map<string, SourceMetadata[]>();
      for (const s of sources) { const key = identity(s)!.account; accounts.set(key, [...accounts.get(key) ?? [], s]); }
      for (const [address, items] of accounts) {
        // A dropped connection must not discard batches already confirmed.
        // Reconnect once for unresolved stored messages; never broaden the search.
        for (let attempt = 0; attempt < 2; attempt++) {
          const remaining = items.filter(s => !result.has(s.id));
          if (!remaining.length) break;
          try {
            await connected(root, address, false, async client => {
              for (let i = 0; i < remaining.length; i += 50) {
                const batch = remaining.slice(i, i + 50);
                const rows = await find(client, batch.map(s => identity(s)!));
                for (const s of batch) {
                  // IMAP HEADER search is a substring match; verify exact identity.
                  const matches = rows.filter(m => identity(s)!.emailId ? m.emailId===identity(s)!.emailId : m.envelope?.messageId === identity(s)!.messageId);
                  result.set(s.id, matches.length === 1 ? observed(matches[0]!, !readOnly(root, address)) : unknown(matches.length ? "unknown" : "missing"));
                }
              }
            });
          } catch {
            if (attempt === 1) for (const s of remaining) if (!result.has(s.id)) result.set(s.id, unknown("unavailable"));
          }
        }
      }
      return result;
    },
    async setUnread(root, source, unread) {
      const id = identity(source);
      if (!id) throw new Error("Email has no stable provider identity.");
      return connected(root, id.account, true, async client => {
        const matches = (await find(client, [id])).filter(m => id.emailId ? m.emailId===id.emailId : m.envelope?.messageId === id.messageId);
        if (matches.length !== 1) throw new Error("Email is missing or ambiguous. No read state changed.");
        if (!integrationConnected(root, "email", id.account)) throw new Error("Email integration is inactive.");
        access.authorize?.(); access.signal?.throwIfAborted();
        const uid = matches[0]!.uid;
        // Only change \\Seen; preserve labels and every other flag.
        const changed = unread ? await client.messageFlagsRemove([uid], ["\\Seen"], { uid: true })
          : await client.messageFlagsAdd([uid], ["\\Seen"], { uid: true });
        if (!changed) throw new Error("Provider refused the read-state change.");
        const confirmed = await client.fetchOne(String(uid), flags, { uid: true });
        if (!confirmed || (id.emailId ? confirmed.emailId !== id.emailId : confirmed.envelope?.messageId !== id.messageId)) throw new Error("Email disappeared before confirmation.");
        const state = observed(confirmed, true);
        if (state.unread !== unread) throw new Error("Provider did not confirm the requested read state.");
        return state;
      });
    },
  };
}
