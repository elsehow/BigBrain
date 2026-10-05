/**
 * emailItem.ts — the email door's decisions that need no network and no
 * model (#744): what a message looks like as a head line, how a body loses
 * its quoted history, and what a message lands as. The poller
 * (integrations/email/run.ts) fetches; lib/stage.ts holds what it staged.
 */

import { frontmatter, slugify } from "./fsx";
import { sha256hex } from "./hash";

/** One message as the manifest knows it — headers only, no body. */
export interface Head {
  /** The inbox it arrived in (the address). */
  inbox: string;
  uid: number;
  uidvalidity?: number;
  mailbox?: string;
  emailId?: string;
  labels?: string[];
  messageId: string;
  from: string;
  fromName: string;
  to: string[];
  subject: string;
  /** ISO date from the message's own Date header (or the server's). */
  date: string;
  size: number;
  /** RFC 2919 List-Id, lowercased, when present. */
  listId?: string;
  /** List headers present (List-Unsubscribe, Precedence: bulk/list). */
  bulk: boolean;
  /** Auto-Submitted, or a Precedence of auto_reply. */
  auto: boolean;
  /** In-Reply-To or References present: part of a thread. */
  reply: boolean;
  /** Gmail's thread id (X-GM-THRID), when the server is Gmail. */
  threadId?: string;
  /** The sender is already a person in the record: the head says `known`. */
  known: boolean;
}

// ── the head line ────────────────────────────────────────────────────────────

const kb = (n: number): string => (n < 1024 ? `${n}b` : n < 1024 * 1024 ? `${Math.round(n / 1024)}k` : `${(n / 1024 / 1024).toFixed(1)}M`);

/** The one line the gardener sees first — a few dozen tokens: date,
 * sender, subject, size and the marks. `inboxes` > 1 appends the inbox so
 * a work thread reads apart from a personal one; with one inbox the mark
 * is noise. */
export function headLine(h: Head, inboxes: number): string {
  const who = h.fromName && h.fromName.toLowerCase() !== h.from.toLowerCase() ? `${h.fromName} <${h.from}>` : h.from;
  const marks = [
    h.reply ? "reply" : "",
    h.bulk ? "bulk" : "",
    h.auto ? "auto" : "",
    h.known ? "known" : "",
    h.listId ? `list:${h.listId}` : "",
    inboxes > 1 ? `→ ${h.inbox}` : "",
  ].filter(Boolean);
  return `${h.date.slice(0, 10)} · ${who} · ${JSON.stringify(h.subject || "(no subject)")} · ${kb(h.size)}${marks.length ? ` · ${marks.join(" · ")}` : ""}`;
}

// ── the body ─────────────────────────────────────────────────────────────────

const QUOTE_INTRO = /^(On\s.{0,200}\bwrote:|Le\s.{0,200}\ba écrit\s?:|Am\s.{0,200}\bschrieb\s.*:)\s*$/u;
const HEADER_BLOCK = /^(From|De|Von):\s.+$/u;
const HEADER_FOLLOW = /^(Sent|To|Date|Subject|Cc|À|An|Gesendet|Datum|Betreff):\s/u;
const SEPARATOR = /^(-{2,}\s*(Original Message|Forwarded message|Ursprüngliche Nachricht|Message d'origine)\s*-{2,}|_{5,}|-{10,})\s*$/iu;

/** Strip quoted history and the signature, and cap the length. The
 * biggest single saving in the whole path: every reply carries the
 * thread below it, so the prototype read 167k characters of a 16-message
 * thread for about 8k of new prose. Deterministic and at the door, as
 * design principle 3 wants. */
export function trimQuotes(text: string, cap = 6_000): string {
  const lines = text.replace(/\r\n?/gu, "\n").split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const t = line.trimEnd();
    if (t.startsWith(">")) continue;
    if (QUOTE_INTRO.test(t) || SEPARATOR.test(t)) break;
    // an "On … wrote:" intro wrapped onto two lines
    if (/^On\s/u.test(t) && lines[i + 1] && /\bwrote:\s*$/u.test(lines[i + 1]!.trimEnd())) break;
    // a pasted header block: From: … then To:/Sent:/Date: within three lines
    if (HEADER_BLOCK.test(t) && lines.slice(i + 1, i + 4).some((l) => HEADER_FOLLOW.test(l ?? ""))) break;
    if (t === "--" && out.length) break; // the signature separator ("-- " loses its space in many clients)
    out.push(t);
  }
  const joined = out.join("\n").replace(/\n{3,}/gu, "\n\n").trim();
  return joined.length > cap ? `${joined.slice(0, cap).trimEnd()}\n[cut at ${cap} characters of ${joined.length}]` : joined;
}

// ── the item ─────────────────────────────────────────────────────────────────

export interface EmailBody {
  text: string;
  to: { name?: string; address: string }[];
  cc: { name?: string; address: string }[];
  attachments: { name: string; size: number }[];
}

/** The insertion this door lands for a kept message — one message, one
 * item, whole. `id` is derived from the Message-ID so a re-poll converges
 * on the same item instead of landing a second copy. */
export function emailItem(h: Head, body: EmailBody, now: Date): { content: string; name: string; id: string } {
  const key = h.emailId ? `gmail:${h.inbox}:${h.emailId}` : h.messageId || `${h.inbox}:${h.mailbox ?? "INBOX"}:${h.uidvalidity ?? 0}:${h.uid}`;
  const id = `email-${sha256hex(key).slice(0, 20)}`;
  const title = h.subject.trim() || "(no subject)";
  const date = h.date.slice(0, 10) || now.toISOString().slice(0, 10);
  const person = (p: { name?: string; address: string }) => ({
    raw: p.name ? `${p.name} <${p.address}>` : p.address,
    ...(p.name ? { name: p.name } : {}),
    emails: [p.address.toLowerCase()],
  });
  const participants = [
    { ...person({ name: h.fromName || undefined, address: h.from }), role: "from" },
    ...body.to.map((p) => ({ ...person(p), role: "to" })),
    ...body.cc.map((p) => ({ ...person(p), role: "cc" })),
  ];
  const line = (ps: { raw: string }[]) => ps.map((p) => p.raw).join(", ");
  const url = h.threadId ? gmailThreadUrl(h.threadId) : "";
  const text = trimQuotes(body.text);
  const content =
    frontmatter([
      ["id", id],
      ["source", "email"],
      // the sender composed it — a person, in their own words; the door
      // itself is the integration, named in `stream`
      ["from", participants[0]!.raw],
      ["from_kind", "person"],
      ["kind", "email"],
      ["type", "reference"],
      ["tags", ["email"]],
      ["title", title],
      ["date", date],
      ["participants", participants],
      ["inbox", h.inbox],
      ["message_id", h.messageId],
      ...(h.emailId ? [["provider_message_id", h.emailId], ["provider", "gmail"]] as [string, string][] : []),
      ...(h.threadId ? [["thread_id", h.threadId]] as [string, string][] : []),
      ...(h.labels ? [["labels", h.labels]] as [string, string[]][] : []),
      ...(url ? ([["url", url]] as [string, string][]) : []),
      ["fetched", now.toISOString()],
      ["stream", `email:${h.inbox}`],
      ["key", key],
      ["seq", h.date],
    ]) +
    "\n" +
    [
      `# ${title}`,
      ``,
      `From: ${participants[0]!.raw}`,
      `To: ${line(body.to.map(person)) || "(none)"}`,
      ...(body.cc.length ? [`Cc: ${line(body.cc.map(person))}`] : []),
      `Date: ${h.date}`,
      `Inbox: ${h.inbox}`,
      ``,
      text || "(empty body)",
      ...(body.attachments.length
        ? [``, `Attachments: ${body.attachments.map((a) => `${a.name} (${kb(a.size)})`).join(", ")}`]
        : []),
      ``,
    ].join("\n");
  return { content, name: `${date}-${slugify(title)}-${id.slice(6, 14)}.md`, id };
}

/** Gmail's X-GM-THRID is a decimal 64-bit id; the web client wants hex. */
export function gmailThreadUrl(threadId: string): string {
  try {
    return `https://mail.google.com/mail/u/0/#all/${BigInt(threadId).toString(16)}`;
  } catch {
    return "";
  }
}
