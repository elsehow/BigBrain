/** Live source operations never touch ingestion cursors or remember evidence.
 * Reads use EXAMINE/PEEK; explicit write operations change only named flags. */
import { ImapFlow, type FetchMessageObject } from "imapflow";
import { simpleParser } from "mailparser";
import { emailConfig, passwordEnvKey, gmailReadOnly, type Inbox } from "./emailConfig";
import { readEnvValues } from "./envFile";
import { loadManifest } from "./manifest";
import { gmailThreadUrl } from "./emailItem";

/** The mail tools this runs; each is declared, with its schema, in lib/integrations/email.ts. */
const LIVE_INBOX_TOOLS = new Set(["email_search", "email_read", "inbox_set_unread", "inbox_list", "inbox_read"]);

type Ref = { account: string; uid: number; validity: string; mailbox?: "all"; emailId?:string };
function decodeRef(raw: unknown): Ref {
  try {
    if (typeof raw !== "string" || raw.length > 1000) throw new Error();
    const r = JSON.parse(Buffer.from(raw, "base64url").toString()) as Ref;
    if (typeof r.account !== "string" || !Number.isSafeInteger(r.uid) || r.uid < 1 || !/^\d+$/.test(r.validity)) throw new Error();
    if(r.mailbox!==undefined&&r.mailbox!=="all")throw new Error();
    if(r.emailId!==undefined&&(typeof r.emailId!=="string"||!/^\d+$/.test(r.emailId)))throw new Error();
    return r;
  } catch { throw new Error("Invalid inbox ref; list the inbox again."); }
}

export type InboxClientFactory = (account: Inbox, password: string) => ImapFlow;
const clientFactory: InboxClientFactory = (i, pass) => new ImapFlow({
  host: i.host, port: i.port, secure: true, auth: { user: i.address, pass },
  logger: false, connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 25_000,
});

/** When the provider received it (IMAP INTERNALDATE), not what the sender's Date says. */
const received = (m: FetchMessageObject): string | null => {
  const at = m.internalDate ? new Date(m.internalDate) : undefined;
  return at && Number.isFinite(at.getTime()) ? at.toISOString() : null;
};
const envelope = (m: FetchMessageObject) => ({
  uid: m.uid, subject: m.envelope?.subject ?? "(no subject)",
  from: m.envelope?.from ?? [], to: m.envelope?.to ?? [],
  date: m.envelope?.date?.toISOString() ?? null,
  received: received(m),
  provider_message_id:m.emailId,
  message_id: m.envelope?.messageId, in_reply_to: m.envelope?.inReplyTo,
  seen: m.flags?.has("\\Seen") ?? false, answered_flag: m.flags?.has("\\Answered") ?? false,
  thread_id: m.threadId, labels: [...(m.labels ?? [])],
  ...(m.threadId ? { url: gmailThreadUrl(m.threadId) } : {}),
});
const QUERY = { uid: true, envelope: true, flags: true, threadId: true, labels: true, size: true, internalDate: true };
const BODY_CAP = 128 * 1024;
async function message(m: FetchMessageObject) {
  const parsed = m.source ? await simpleParser(m.source, { skipHtmlToText: false, skipTextToHtml: true }) : undefined;
  const body = parsed?.text ?? "";
  return { ...envelope(m), body: body.slice(0, 18_000), body_truncated: (m.size ?? 0) > BODY_CAP || body.length > 18_000 };
}

export async function liveInboxTool(root: string, name: string, args: Record<string, unknown>, opts: { signal?: AbortSignal; client?: InboxClientFactory; authorize?: () => void } = {}): Promise<unknown> {
  if (!LIVE_INBOX_TOOLS.has(name)) throw new Error("Unknown live inbox tool");
  const writing=name==="inbox_set_unread";
  if(writing&&typeof args.unread!=="boolean")throw new Error("unread must be a boolean.");
  const ref = name === "inbox_read" || name === "email_read" || writing ? decodeRef(args.ref) : undefined;
  if(writing && ref?.mailbox)throw Error("Invalid inbox ref for a flag change.");
  const cfg = emailConfig(loadManifest(root).integrations.email);
  const address = ref?.account ?? (typeof args.account === "string" ? args.account.toLowerCase() : undefined);
  const account = address ? cfg.inboxes.find(i => i.address === address) : cfg.inboxes.length === 1 ? cfg.inboxes[0] : undefined;
  if (!account) throw new Error(cfg.inboxes.length ? "Choose a configured inbox account." : "No live inbox connected. Stored emails cannot establish current inbox state.");
  if (writing && gmailReadOnly(root, account.address)) throw new Error("Gmail connections are read-only.");
  const password = readEnvValues(root)[passwordEnvKey(account.address)];
  if (!password) throw new Error("The configured inbox has no password. Stored emails cannot establish current inbox state.");
  const client = (opts.client ?? clientFactory)(account, password);
  opts.authorize?.();
  client.on("error", () => { /* the awaited command reports its failure */ });
  const abort = () => client.close();
  opts.signal?.throwIfAborted();
  opts.signal?.addEventListener("abort", abort, { once: true });
  const deadline = setTimeout(abort, 60_000);
  deadline.unref?.();
  try {
    opts.authorize?.();
    await client.connect();
    opts.authorize?.();
    const allScope=name==='email_search'||ref?.mailbox==='all';
    const boxes=allScope?await client.list():[];
    const mailbox=allScope?boxes.find(b=>b.specialUse==='\\All')?.path:'INBOX';
    if(!mailbox || (allScope&&!client.capabilities.has('X-GM-EXT-1')))throw Error('Gmail All Mail is unavailable.');
    const lock = await client.getMailboxLock(mailbox, { readOnly: !writing });
    let seed: FetchMessageObject | undefined;
    let listed: unknown;
    try {
      if (!client.mailbox) throw new Error("Inbox could not be opened");
      const validity = String(client.mailbox.uidValidity);
      if (ref) {
        if (ref.validity !== validity) throw new Error("Inbox identity changed; list the inbox again.");
        const m = await client.fetchOne(String(ref.uid), (writing ? QUERY : { ...QUERY, source: { maxLength: BODY_CAP } }), { uid: true });
        if (m && ref.emailId && m.emailId!==ref.emailId)throw Error("Inbox identity changed; search again.");
        if (!m) throw new Error("Message is no longer in the inbox; list the inbox again.");
        if(writing){
          opts.authorize?.();opts.signal?.throwIfAborted();
          if(client.mailbox.readOnly)throw new Error("Mailbox is not writable.");
          const changed=args.unread?await client.messageFlagsRemove([ref.uid],["\\Seen"],{uid:true}):await client.messageFlagsAdd([ref.uid],["\\Seen"],{uid:true});
          if(!changed)throw new Error("Provider refused the flag change.");
          const confirmed=await client.fetchOne(String(ref.uid),QUERY,{uid:true});
          if(!confirmed||confirmed.flags?.has("\\Seen")===args.unread)throw new Error("Could not confirm the flag change.");
          return {account:account.address,ref:args.ref,unread:args.unread,changed:true,remembered:false};
        }
        seed = m;
      } else {
        const limit = Math.min(50, Math.max(1, Math.trunc(Number(args.limit)) || 25));
        const before = Number(args.before_uid);
        if (args.before_uid !== undefined && (!Number.isSafeInteger(before) || before < 2)) throw new Error("Invalid inbox cursor");
        if(name==='email_search'&&before&&args.uidvalidity!==validity)throw Error('Inbox identity changed; search again.');
        if(args.query!==undefined&&(typeof args.query!=='string'||args.query.length>1000||/[\r\n\0]/.test(args.query)))throw Error('Invalid inbox search query.');
        const found = await client.search({ all: true, ...(before ? { uid: `1:${before - 1}` } : {}),...(name==='email_search'&&args.query?{gmraw:String(args.query)}:{}) }, { uid: true });
        const uids = (found || []).sort((a, b) => b - a);
        const page = uids.slice(0, limit);
        const rows = page.length ? await client.fetchAll(page, QUERY, { uid: true }) : [];
        listed = {
          scope: allScope ? "live_mail" : "live_inbox", account: account.address, checked_at: new Date().toISOString(), mailbox, uidvalidity:validity, coverage:allScope?"All Mail: inbox, sent and archive; excludes spam/trash":"INBOX",
          total: client.mailbox.exists, remaining_in_page_range: uids.length, truncated: uids.length > page.length,
          next_before_uid: uids.length > page.length ? page[page.length - 1] : null,
          reply_state: "Unknown until thread evidence is inspected; seen/answered flags are not a to-do list.",
          messages: rows.sort((a, b) => b.uid - a.uid).map(m => ({ ...envelope(m),
            ref: Buffer.from(JSON.stringify({ account: account.address, uid: m.uid, validity, ...(allScope?{mailbox:"all"}:{}),...(m.emailId?{emailId:m.emailId}:{}) })).toString("base64url") })),
        };
      }
    } finally { lock.release(); }
    if (!seed) return listed;
    const selected = await message(seed);
    opts.authorize?.();
    const mailboxes = seed.threadId ? await client.list() : [];
    const allMail = client.capabilities.has("X-GM-EXT-1") ? mailboxes.find(m => m.specialUse === "\\All") : undefined;
    let thread: Awaited<ReturnType<typeof message>>[] = [];
    let truncated = false;
    let nextThreadBeforeUid:number|null=null;
    let threadValidity:string|undefined;
    if (allMail && seed.threadId) {
      const threadLock = await client.getMailboxLock(allMail.path, { readOnly: true });
      try {
        threadValidity=client.mailbox?String(client.mailbox.uidValidity):undefined;
        const before=Number(args.thread_before_uid);
        if(args.thread_before_uid!==undefined&&(!Number.isSafeInteger(before)||before<2))throw Error('Invalid inbox thread cursor.');
        if(before&&args.thread_uidvalidity!==threadValidity)throw Error('Inbox identity changed; read the thread again.');
        const found = await client.search({ threadId: seed.threadId, ...(before?{uid:`1:${before-1}`}:{}) }, { uid: true });
        const ids = (found || []).sort((a, b) => b - a);
        truncated = ids.length > 12;
        nextThreadBeforeUid=truncated?ids[11]!:null;
        const rows = ids.length ? await client.fetchAll(ids.slice(0, 12), { ...QUERY, source: { maxLength: BODY_CAP } }, { uid: true }) : [];
        thread = await Promise.all(rows.sort((a, b) => a.uid - b.uid).map(message));
      } finally { threadLock.release(); }
    }
    return { scope: allScope ? "live_mail" : "live_inbox", account: account.address, checked_at: new Date().toISOString(), ref: args.ref,
      selected, thread, thread_coverage: thread.length ? "All Mail: inbox, sent and archive; up to 12 messages per page; excludes spam/trash" : "Selected message only; sent replies were not checked",
      next_thread_before_uid:nextThreadBeforeUid,thread_uidvalidity:threadValidity,
      thread_truncated: truncated, reply_state: "Infer only from actual thread participants and sent-message evidence; unanswered does not mean action required." };
  } catch (e) {
    // Never relay a provider error containing credentials or protocol traffic.
    if (opts.signal?.aborted && !writing) throw new Error("Inbox read canceled");
    const text = e instanceof Error ? e.message : "";
    if (/^(Invalid inbox|Inbox identity|Message is no longer)/.test(text)) throw e;
    throw new Error(writing ? "Could not confirm the read/unread change. Read current state before retrying; the provider may have applied it." : "Live inbox read failed or timed out. Check the inbox connection; no mail was changed.");
  } finally {
    clearTimeout(deadline);
    opts.signal?.removeEventListener("abort", abort);
    client.close();
  }
}
