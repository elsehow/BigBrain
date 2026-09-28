import { emailDiscovered } from "../../lib/emailDiscovery";
import { integrationActive, accountPolicy } from "../../lib/integrationAccess";
/**
 * email — inbound integration (#744). Poll every inbox over IMAP, drop what
 * a standing skip rule already covers (lib/skipRules.ts, zero tokens), and
 * STAGE the rest whole — the message as it would land, one head line, and
 * the scopes a rule may name (lib/stage.ts). The gardener sees the heads
 * in its own `next`, opens a body when the line is not enough, and admits
 * (the message lands through the intake waist and is filed like any
 * arrival) or passes (nothing lands; optionally a rule that keeps this
 * sender or list from ever being staged again). One queue, one model, one
 * prompt (Nick, 2026-09-04): this door decides nothing and never spawns a
 * model; it fetches and stages.
 *
 * A message is an event: it arrived once and never changes. So the cursor
 * is IMAP's own UID per mailbox (Gmail's All Mail where the server has
 * one, so mail the owner archives before a poll is still seen), the first
 * run initializes it to "now" and pulls nothing, and `--since <date>`
 * backfills once.
 *
 * Credentials are app passwords in the vault's .env under a key derived
 * from the address (lib/emailConfig.ts), never in vault.yaml. The gardener
 * never holds one: it reads the staged copy.
 *
 * Cadence is the supervisor's table (lib/desktopSchedule.ts CADENCE, every
 * minute). Pending bodies and source checkpoints live in .spool and survive
 * deletion of disposable .state caches. Back up .spool with the vault.
 *
 * Usage: bun integrations/email/run.ts [--since <ISO date>]
 */

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ImapFlow, type FetchMessageObject } from "imapflow";
import { simpleParser, type AddressObject, type ParsedMail } from "mailparser";
import { VAULT_ROOT } from "../../lib/vaultRoot";
import type { Attachment } from "../../lib/intake";
import { readEnvValues } from "../../lib/envFile";
import { flagValue, hasFlag } from "../../lib/cliflags";
import { requireIntegrationEnabled } from "../../lib/integrationPoll";
import { loadManifest } from "../../lib/manifest";
import { ownerLabelsFor } from "../../lib/assertionAgent";
import { friendlyImapError as friendly } from "../../lib/imapProbe";
import { skipMatches } from "../../lib/skipRules";
import { stage } from "../../lib/stage";
import { emailConfig, passwordEnvKey, type EmailConfig, type Inbox } from "../../lib/emailConfig";
import { readEmailState, writeEmailState, type EmailState } from "../../lib/emailState";
import { emailItem, emailScopes, headLine, type EmailBody, type Head } from "../../lib/emailItem";

requireIntegrationEnabled("email", VAULT_ROOT);

const root = VAULT_ROOT;
/** Messages fetched per inbox per poll; a CLI backfill takes a larger first
 * batch. The durable cursor resumes the remainder on subsequent scheduled polls. */
const HEADS_PER_POLL = 300;
const HEADS_PER_BACKFILL = 5_000;
/** Bodies come in one FETCH per chunk, so a backfill never holds a
 * thousand parsed messages at once. */
const BODIES_PER_FETCH = 200;
/** Bound each download; oversized messages remain visible as retry failures. */
const MAX_SOURCE_BYTES = 25 * 1024 * 1024;
const ATTACHMENT_CAP = 10 * 1024 * 1024;
const HEADER_FIELDS = ["list-id", "list-unsubscribe", "precedence", "auto-submitted", "references"];

const log = (s: string): void => console.log(`email: ${s}`);

// ── one poll at a time ───────────────────────────────────────────────────────

const lockDir = join(root, ".state", "email.lock");

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** A backfill can outlive the minute the supervisor fires on; a second poll
 * must not start beside it. Stale locks (a dead pid) are taken over. */
function takeLock(): boolean {
  const claim = (): void => {
    mkdirSync(join(root, ".state"), { recursive: true });
    mkdirSync(lockDir, { recursive: false });
    writeFileSync(join(lockDir, "pid"), `${process.pid}\n`);
  };
  try {
    claim();
    return true;
  } catch {
    let pid = 0;
    try {
      pid = Number(readFileSync(join(lockDir, "pid"), "utf8").trim());
    } catch {
      /* no pid file: stale */
    }
    if (pid && alive(pid)) return false;
    rmSync(lockDir, { recursive: true, force: true });
    try {
      claim();
      return true;
    } catch {
      return false;
    }
  }
}

const releaseLock = (): void => rmSync(lockDir, { recursive: true, force: true });

// ── heads ────────────────────────────────────────────────────────────────────

/** The requested header fields, unfolded, lowercased keys, first value wins. */
function headerFields(buf: Buffer | undefined): Map<string, string> {
  const m = new Map<string, string>();
  if (!buf) return m;
  for (const line of buf.toString("utf8").replace(/\r?\n[ \t]+/gu, " ").split(/\r?\n/u)) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    const k = line.slice(0, i).trim().toLowerCase();
    if (!m.has(k)) m.set(k, line.slice(i + 1).trim());
  }
  return m;
}

function toHead(inbox: string, msg: FetchMessageObject, known: ReadonlySet<string>, now: Date): Head {
  const env = msg.envelope;
  const h = headerFields(msg.headers);
  const from = env?.from?.[0];
  const fromAddr = (from?.address ?? "").toLowerCase();
  const rawList = h.get("list-id");
  const listId = rawList ? (/<([^>]+)>/u.exec(rawList)?.[1] ?? rawList).trim().toLowerCase() : undefined;
  const precedence = (h.get("precedence") ?? "").toLowerCase();
  const autoSubmitted = (h.get("auto-submitted") ?? "no").toLowerCase();
  const date = env?.date instanceof Date && !Number.isNaN(env.date.getTime()) ? env.date : now;
  return {
    inbox,
    uid: msg.uid,
    ...(msg.emailId ? {emailId: String(msg.emailId)} : {}),
    labels: [...msg.labels ?? []],
    messageId: env?.messageId ?? "",
    from: fromAddr,
    fromName: from?.name ?? "",
    to: (env?.to ?? []).map((a) => (a.address ?? "").toLowerCase()).filter(Boolean),
    subject: env?.subject ?? "",
    date: date.toISOString(),
    size: msg.size ?? 0,
    ...(listId ? { listId } : {}),
    bulk: Boolean(listId || h.has("list-unsubscribe") || precedence === "bulk" || precedence === "list"),
    auto: autoSubmitted !== "no" || precedence === "auto_reply",
    reply: Boolean(env?.inReplyTo || h.has("references")),
    ...(msg.threadId ? { threadId: String(msg.threadId) } : {}),
    known: known.has(fromAddr),
  };
}

/** Addresses the record already knows: the owner's own, plus every
 * address that appears in a projected entity dossier when the projection
 * is on disk. A staged head marks its sender scope `protect` on these, and
 * the engine refuses a rule on it (lib/stage.ts). */
function knownAddresses(labels: readonly string[]): Set<string> {
  const set = new Set<string>();
  const re = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/giu;
  for (const l of labels) for (const m of l.matchAll(re)) set.add(m[0].toLowerCase());
  const dir = join(root, "projection", "entities");
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return set;
  }
  for (const f of files) {
    try {
      for (const m of readFileSync(join(dir, f), "utf8").matchAll(re)) set.add(m[0].toLowerCase());
    } catch {
      /* a dossier mid-write */
    }
  }
  return set;
}

// ── IMAP ─────────────────────────────────────────────────────────────────────

function connect(inbox: Inbox, pass: string): ImapFlow {
  const client = new ImapFlow({
    host: inbox.host,
    port: inbox.port,
    secure: true,
    auth: { user: inbox.address, pass },
    logger: false,
    emitLogs: false,
    socketTimeout: 90_000,
  });
  // the socket can still emit after a failed login or a logout; an
  // unhandled 'error' event would take the whole poll down, and one after
  // our own logout is not news
  client.on("error", (e: unknown) => {
    if (!client.usable) return;
    log(`${inbox.address}: ${friendly(e)}`);
  });
  return client;
}

/** Gmail's All Mail where the server marks one (`\All`), else INBOX. All
 * Mail is the complete log: a message the owner archives before a poll is
 * still there, and a filter that skips the inbox still lands here. */
async function pickMailbox(client: ImapFlow): Promise<string> {
  const boxes = await client.list();
  return boxes.find((b) => b.specialUse === "\\All")?.path ?? "INBOX";
}

interface PollResult {
  staged: number;
  skipped: number;
  unfetched: number;
  note?: string;
}

/** One inbox, one connection: new UIDs past the cursor become heads, a
 * rule drops what it covers, the rest are fetched whole and staged. A body
 * the server would not give or the parser would not read is remembered
 * and retried on later polls, with durable failure status until resolved. */
async function pollInbox(
  inbox: Inbox,
  pass: string,
  state: EmailState,
  cfg: EmailConfig,
  known: ReadonlySet<string>,
  now: Date,
  since: string | undefined
): Promise<PollResult> {
  if (!integrationActive(root,"email",inbox.address)) return {staged:0,skipped:0,unfetched:0,note:"Automatic remembering is off."};
  const st = state.inboxes[inbox.address] ?? (state.inboxes[inbox.address] = {});
  const client = connect(inbox, pass);
  await client.connect();
  try {
    const discovered=emailDiscovered(root);
    const policy=accountPolicy(root,'email',inbox.address);
    const mailbox = await pickMailbox(client);
    if(inbox.provider==='gmail' && mailbox==='INBOX')throw Error('All Mail is unavailable. Show All Mail in IMAP before remembering.');
    const lock = await client.getMailboxLock(mailbox, {readOnly:true});
    try {
      const mb = client.mailbox;
      if (!mb) throw new Error(`${mailbox} did not open`);
      const uidValidity = Number(mb.uidValidity);
      const highest = mb.uidNext - 1;
      let uids: number[] = [];
      const requested=policy.email?.backfill;
      const requestedSince=since ?? (requested && requested.request!==st.backfillRequest ? requested.since : undefined);
      if(requestedSince) {
        st.since=st.since && st.since<requestedSince ? st.since : requestedSince;
        st.lastUid=0;
        if(requested)st.backfillRequest=requested.request;
      }
      const reset=st.uidvalidity!==undefined&&(st.uidvalidity!==uidValidity||st.mailbox!==mailbox);
      if(reset) {
        if(!st.since)throw Error('Mailbox identity changed. Choose a history start date to recover this legacy account.');
        st.lastUid=0;st.retry=[];st.failed=[];
      }
      if(st.lastUid===undefined) {
        st.since=policy.email?.startAt ?? now.toISOString();
        st.lastUid=policy.email ? 0 : highest;
      }
      st.uidvalidity=uidValidity;st.mailbox=mailbox;
      // IMAP SINCE ignores time zones. Overlap a day, then apply the exact
      // consent boundary to INTERNALDATE before fetching any bodies.
      if(highest>st.lastUid) {
        const found=await client.search({uid:`${st.lastUid+1}:*`,...(st.since?{since:new Date(Date.parse(st.since)-86_400_000)}:{})},{uid:true});
        uids=(Array.isArray(found)?found:[]).filter(u=>u>st.lastUid! && u<=highest);
      }
      uids.sort((a, b) => a - b);
      const batch = uids.slice(0, since ? HEADS_PER_BACKFILL : HEADS_PER_POLL);
      // bodies owed from earlier polls ride along with this one's
      const retry = new Map((st.retry ?? []).slice(0,HEADS_PER_POLL).map((r) => [r.uid, r.tries]));
      const wanted = [...new Set([...batch, ...retry.keys()])].sort((a, b) => a - b);
      const heads = new Map<number, Head>();
      let skipped = 0;
      const settled=new Set<number>();
      const failed=new Map((st.failed??[]).map(f=>[f.uid,f.reason]));
      if (wanted.length) {
        for await (const msg of client.fetch(
          wanted,
          { uid: true, envelope: true, internalDate:true, size: true, labels:true, threadId: true, headers: HEADER_FIELDS },
          { uid: true }
        )) {
          const h = {...toHead(inbox.address, msg, known, now),uidvalidity:uidValidity,mailbox};
          if(!client.capabilities.has('X-GM-EXT-1'))delete h.emailId;
          if(inbox.provider==='gmail'&&!h.emailId){failed.set(h.uid,'Gmail message identity unavailable; retry pending.');continue;}
          const identity=emailItem(h,{text:'',to:[],cc:[],attachments:[]},now).id;
          if ((st.since && msg.internalDate instanceof Date && msg.internalDate.toISOString()<st.since) || discovered(h,identity) || skipMatches(emailScopes(h),cfg.skip)) {skipped++;settled.add(h.uid);}
          else if(h.size>MAX_SOURCE_BYTES)failed.set(h.uid,'Message exceeds 25 MiB; not downloaded.');
          else heads.set(h.uid, h);
        }
      }
      let staged = 0;
      const owed: { uid: number; tries: number }[] = (st.retry??[]).slice(HEADS_PER_POLL);
      const pending = [...heads.keys()];
      for (let i = 0; i < pending.length; i += BODIES_PER_FETCH) {
        const chunk = pending.slice(i, i + BODIES_PER_FETCH);
        const got = new Set<number>();
        // one FETCH for the whole chunk: a round trip per message made a
        // hundred bodies a minutes-long affair
        for await (const msg of client.fetch(chunk, { uid: true, source: true }, { uid: true })) {
          const h = heads.get(msg.uid);
          if (!h || !msg.source) continue;
          try {
            if (!integrationActive(root, "email", inbox.address)) throw new Error("Email integration became inactive.");
            const parsed = await simpleParser(msg.source);
            if (!integrationActive(root, "email", inbox.address)) throw new Error("Email integration became inactive.");
            const item = emailItem(h, toBody(parsed), now);
            if(discovered(h,item.id,item.content)){got.add(msg.uid);settled.add(msg.uid);skipped++;continue;}
            if (
              stage(root, {
                id: item.id,
                source: "email",
                account: inbox.address,
                at: h.date,
                line: headLine(h, cfg.inboxes.length),
                scopes: emailScopes(h),
                ...(h.known ? { protect: ["sender"] } : {}),
                name: item.name,
                content: item.content,
                attachments: inbox.provider!=="gmail" || policy.email?.attachments === true ? attachmentsOf(parsed) : [],
              })
            )
              staged++;
            got.add(msg.uid);settled.add(msg.uid);failed.delete(msg.uid);
          } catch (e) {
            log(`${inbox.address} uid ${h.uid}: body not parsed — ${friendly(e)}`);
          }
        }
        for (const uid of chunk)if(!got.has(uid))failed.set(uid,'Body unavailable; retry pending.');
      }
      for(const uid of settled)failed.delete(uid);
      for(const uid of wanted)if(!settled.has(uid)) {
        owed.push({uid,tries:(retry.get(uid)??0)+1});
        if(!failed.has(uid))failed.set(uid,'Headers unavailable; retry pending.');
      }
      Object.assign(st, {
        uidvalidity: uidValidity,
        mailbox,
        // A backfill and a normal poll advance only through processed UIDs.
        // Failures remain durable retry work; a reset replays from the consented date.
        lastUid: batch.length ? Math.max(st.lastUid ?? 0, ...batch) : highest,
        failed: [...failed].map(([uid,reason])=>({uid,reason})),
        retry: [...new Map(owed.filter(r=>!settled.has(r.uid)).map(r=>[r.uid,r])).values()],
      });
      return {
        staged, skipped, unfetched: st.retry!.length,
        ...(uids.length > batch.length ? { note: `${uids.length - batch.length} more wait for the next poll` } : {}),
      };
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

// ── bodies ───────────────────────────────────────────────────────────────────

function htmlToText(html: string): string {
  return html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/giu, "")
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h[1-6]|blockquote)>/giu, "\n")
    .replace(/<[^>]+>/gu, "")
    .replace(/&nbsp;/gu, " ")
    .replace(/&amp;/gu, "&")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&#39;|&apos;/gu, "'")
    .replace(/[ \t]+\n/gu, "\n");
}

const addrs = (a: AddressObject | AddressObject[] | undefined): { name?: string; address: string }[] => {
  const list = Array.isArray(a) ? a : a ? [a] : [];
  return list
    .flatMap((x) => x.value)
    .filter((v) => v.address)
    .map((v) => ({ ...(v.name ? { name: v.name } : {}), address: v.address!.toLowerCase() }));
};

function bodyText(p: ParsedMail): string {
  if (p.text && p.text.trim()) return p.text;
  if (typeof p.html === "string" && p.html.trim()) return htmlToText(p.html);
  return "";
}

function toBody(p: ParsedMail): EmailBody {
  return {
    text: bodyText(p),
    to: addrs(p.to),
    cc: addrs(p.cc),
    attachments: p.attachments.map((a) => ({ name: a.filename ?? "attachment", size: a.size })),
  };
}

/** Real attachments (not inline images), up to the cap in total. */
function attachmentsOf(p: ParsedMail): Attachment[] {
  const out: Attachment[] = [];
  let total = 0;
  for (const a of p.attachments) {
    if (a.contentDisposition === "inline" || !a.content?.length) continue;
    if (total + a.content.length > ATTACHMENT_CAP) continue;
    total += a.content.length;
    out.push({ name: a.filename ?? "attachment", b64: a.content.toString("base64") });
  }
  return out;
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!takeLock()) {
    log("another poll is still running");
    return;
  }
  try {
    const manifest = loadManifest(root);
    const cfg = emailConfig(manifest.integrations["email"]);
    if (!cfg.inboxes.length) {
      log("no inboxes yet — add one in settings › integrations");
      return;
    }
    const state = readEmailState(root);
    const now = new Date();
    const env = readEnvValues(root);
    const known = knownAddresses(ownerLabelsFor(root));
    const since = hasFlag(process.argv, "since") ? new Date(flagValue(process.argv, "since")!).toISOString() : undefined;

    for (const inbox of cfg.inboxes) {
      if (!integrationActive(root,"email",inbox.address)) continue;
      const st = state.inboxes[inbox.address] ?? (state.inboxes[inbox.address] = {});
      const pass = env[passwordEnvKey(inbox.address)];
      if (!pass) {
        st.last = { at: now.toISOString(), ok: false, error: "no password" };
        continue;
      }
      const priorState=structuredClone(st);
      try {
        const r = await pollInbox(inbox, pass, state, cfg, known, now, since);
        st.last = { at: now.toISOString(), ok: r.unfetched===0, ...(r.unfetched?{error:`${r.unfetched} messages pending retry`}:{}) };
        if (r.staged || r.skipped || r.note)
          log(
            `${inbox.address}: ${r.staged} staged, ${r.skipped} dropped by rules` +
              (r.unfetched ? `, ${r.unfetched} body(ies) owed` : "") +
              (r.note ? ` — ${r.note}` : "")
          );
      } catch (e) {
        state.inboxes[inbox.address]=priorState;
        const error = friendly(e);
        priorState.last = { at: now.toISOString(), ok: false, error };
        log(`${inbox.address}: ${error}`);
      }
    }
    writeEmailState(root, state);
  } finally {
    releaseLock();
  }
}

await main();
