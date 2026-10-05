import { describe, expect, test } from "bun:test";
import { emailItem, gmailThreadUrl, headLine, trimQuotes, type Head } from "../lib/emailItem";

// The pure half of the email integration (#744): no network, no vault. What
// a message looks like as the head line the gardener sees first, which
// scopes a rule may name, how a body loses its quoted history, and what an
// admitted message lands as.

const head = (over: Partial<Head> = {}): Head => ({
  inbox: "alpha@example.com",
  uid: 41,
  messageId: "<m41@mail.example.com>",
  from: "evan@fri.example.org",
  fromName: "Evan Keller",
  to: ["alpha@example.com"],
  subject: "Re: Ridgeways timing",
  date: "2026-09-04T15:02:00.000Z",
  size: 4_300,
  bulk: false,
  auto: false,
  reply: true,
  known: false,
  ...over,
});

describe("headLine — a few dozen tokens per message", () => {
  test("date, sender, subject, size and the marks", () => {
    expect(headLine(head(), 1)).toBe('2026-09-04 · Evan Keller <evan@fri.example.org> · "Re: Ridgeways timing" · 4k · reply');
    expect(
      headLine(head({ uid: 42, from: "noreply@github.com", fromName: "GitHub", subject: "[org/repo] CI failed", size: 120_000, bulk: true, listId: "repo.org.github.com", reply: false }), 1)
    ).toBe('2026-09-04 · GitHub <noreply@github.com> · "[org/repo] CI failed" · 117k · bulk · list:repo.org.github.com');
  });

  test("with several inboxes the line says which one; a bare address is not repeated as its own name", () => {
    expect(headLine(head({ fromName: "evan@fri.example.org", known: true }), 2)).toBe(
      '2026-09-04 · evan@fri.example.org · "Re: Ridgeways timing" · 4k · reply · known · → alpha@example.com'
    );
  });

  test("an empty subject is said, not blank", () => {
    expect(headLine(head({ subject: "" }), 1)).toContain('"(no subject)"');
  });
});

describe("trimQuotes — the quoted thread stays in the mailbox", () => {
  test("cuts at an 'On … wrote:' intro and drops '>' lines", () => {
    const t = trimQuotes("Sounds good, Friday works.\n\nOn Thu, Sep 3, 2026 at 4:02 PM Evan <evan@x.org> wrote:\n> Does Friday work?\n> Evan\n");
    expect(t).toBe("Sounds good, Friday works.");
  });
  test("cuts at a wrapped intro, an Outlook header block, and a separator", () => {
    expect(trimQuotes("Yes.\n\nOn Thu, Sep 3, 2026 at 4:02 PM Evan Keller\n<evan@x.org> wrote:\nold stuff")).toBe("Yes.");
    expect(trimQuotes("Yes.\n\nFrom: Evan Keller\nSent: Thursday\nTo: Alpha\nSubject: Re: x\n\nold stuff")).toBe("Yes.");
    expect(trimQuotes("Yes.\n\n-----Original Message-----\nold")).toBe("Yes.");
    expect(trimQuotes("Yes.\n\n________________________________\nold")).toBe("Yes.");
  });
  test("cuts at the signature separator, collapses blank runs, caps and says so", () => {
    expect(trimQuotes("Body.\n\n\n\n-- \nAlpha\nSome Org")).toBe("Body.");
    const long = trimQuotes("x".repeat(100), 40);
    expect(long.startsWith("x".repeat(40))).toBe(true);
    expect(long).toContain("[cut at 40 characters of 100]");
  });
  test("a body that is nothing but a quote is empty, not the quote", () => {
    expect(trimQuotes("> a\n> b\n")).toBe("");
  });
});

describe("emailItem — one message, one item, whole", () => {
  const body = {
    text: "Friday works.\n\nOn Thu Evan wrote:\n> Does Friday work?",
    to: [{ name: "Alpha Example", address: "alpha@example.com" }],
    cc: [{ address: "cc@example.com" }],
    attachments: [{ name: "agenda.pdf", size: 120_000 }],
  };
  const now = new Date("2026-09-04T16:00:00Z");

  test("the id is derived from the Message-ID, so a re-poll converges", () => {
    const a = emailItem(head(), body, now);
    const b = emailItem(head({ uid: 99 }), body, now);
    expect(a.id).toBe(b.id);
    expect(a.id).toMatch(/^email-[a-f0-9]{20}$/u);
    expect(emailItem(head({ messageId: "" }), body, now).id).not.toBe(a.id);
  });

  test("the envelope names the sender as a person and every participant with an address; the body is header lines then the trimmed text", () => {
    const { content, name } = emailItem(head({ threadId: "1841234567890123456" }), body, now);
    expect(content).toContain('from: "Evan Keller <evan@fri.example.org>"');
    expect(content).toContain("from_kind: person");
    expect(content).toContain("kind: email");
    expect(content).toContain('title: "Re: Ridgeways timing"');
    expect(content).toContain("date: 2026-09-04");
    expect(content).toContain("emails:\n      - evan@fri.example.org");
    expect(content).toContain("role: cc");
    expect(content).toContain('url: "https://mail.google.com/mail/u/0/#all/198d61158f42bac0"');
    expect(content).toContain('stream: "email:alpha@example.com"');
    expect(content).toContain("\n# Re: Ridgeways timing\n\nFrom: Evan Keller <evan@fri.example.org>\nTo: Alpha Example <alpha@example.com>\nCc: cc@example.com\n");
    expect(content).toContain("\nFriday works.\n");
    expect(content).not.toContain("Does Friday work");
    expect(content).toContain("Attachments: agenda.pdf (117k)");
    expect(name).toMatch(/^2026-09-04-re-ridgeways-timing-[a-f0-9]{8}\.md$/u);
  });

  test("gmailThreadUrl: decimal X-GM-THRID to the web client's hex; junk answers nothing", () => {
    expect(gmailThreadUrl("1841234567890123456")).toBe("https://mail.google.com/mail/u/0/#all/198d61158f42bac0");
    expect(gmailThreadUrl("not a number")).toBe("");
  });
});
