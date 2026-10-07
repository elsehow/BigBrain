/** credentialScreen.test.ts — the local screen agents' reads pass through.
 *
 * Two corpora, every message invented: the firewall's evaluation set
 * (deploy/firewall/eval/fixtures.json), where every credential mail but the
 * one with nothing in it to withhold must lose something and every ordinary
 * one must come back byte for byte; and the cases below, which name the
 * exact secret that must go and the exact text that must stay. */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { screenCredentials } from "../lib/credentialScreen";

const subjectOf = (text: string) => /^Subject: (.*)$/mu.exec(text)?.[1] ?? "";

describe("the firewall's evaluation set", () => {
  const fixtures = JSON.parse(readFileSync(join(import.meta.dir, "..", "deploy", "firewall", "eval", "fixtures.json"), "utf8")) as { id: string; expect: string; text: string }[];
  // it says a reset was asked for, but carries no link or code to withhold
  const nothingToWithhold = new Set(["reset-html-only-no-url"]);
  for (const f of fixtures) test(`${f.id} (${f.expect})`, () => {
    const r = screenCredentials(f.text, { where: "open in Mail", context: subjectOf(f.text) });
    if (f.expect === "credential" && !nothingToWithhold.has(f.id)) expect(r.withheld).toBeGreaterThan(0);
    else expect(r).toEqual({ text: f.text, withheld: 0 });
  });
});

/** Credential cases: what must go, and what must stay beside it. */
const WITHHELD: { name: string; text: string; context?: string; gone: string[]; kept: string[] }[] = [
  { name: "a login code in the subject", text: "731905 is your Orchard login code", gone: ["731905"], kept: ["is your Orchard login code"] },
  { name: "a code in a sign-in sentence", text: "Use 0442-118 to sign in to Kestrel. It expires in 10 minutes.", gone: ["0442-118"], kept: ["10 minutes"] },
  { name: "a prefixed code", text: "G-552918 is your verification code.", gone: ["G-552918"], kept: ["verification code"] },
  { name: "a code on the line after its label", text: "Your Pinewood one-time passcode:\n\n58201937\n\nDon't share it.", gone: ["58201937"], kept: ["Don't share it."] },
  { name: "a letter-and-digit code", text: "Enter this security code on the sign-in page: 7HK2QX", gone: ["7HK2QX"], kept: ["sign-in page"] },
  { name: "a reset link with its token", text: "Reset your password:\nhttps://accounts.wrenfield.example/reset?token=Q8vX2mT7pL4nR9bW", gone: ["Q8vX2mT7pL4nR9bW"], kept: ["Reset your password:"] },
  { name: "a magic link in a markdown link", text: "[Sign in to Driftwood](https://driftwood.example/auth/magic?k=9c1e7b2a4f0d5e83) — this link works once.", gone: ["9c1e7b2a4f0d5e83"], kept: ["[Sign in to Driftwood](", ") — this link works once."] },
  { name: "a verification link whose words are only around it", text: "Confirm your email address to finish signing up:\nhttps://mail.thornbury.example/e/5f0c2e9a71b4d6c8", context: "Confirm your Thornbury account", gone: ["5f0c2e9a71b4d6c8"], kept: ["finish signing up"] },
  { name: "a temporary password", text: "Username: ines.vale\nTemporary password: Zp4!rw9Kq2", gone: ["Zp4!rw9Kq2"], kept: ["Username: ines.vale"] },
  { name: "backup codes", text: "Your backup codes:\n1180-2295  4417-9930", context: "Two-factor backup codes", gone: ["1180-2295", "4417-9930"], kept: ["Your backup codes:"] },
  { name: "a meeting note that repeats a code", text: "Leo read out the verification code 449021 so Mara could log in.", gone: ["449021"], kept: ["so Mara could log in."] },
];

/** Ordinary mail and notes that look a little like credentials. */
const KEPT: { name: string; text: string; context?: string }[] = [
  { name: "an order number", text: "Your order 113-4829104 has shipped. Sign in to see its status." },
  { name: "a tracking link", text: "Track your parcel: https://track.parcelpost.example/t/1Z999AA10123456784" },
  { name: "an unsubscribe link with a token", text: "Unsubscribe: https://news.longgarden.example/unsubscribe?token=8f2d1c9e7a4b" },
  { name: "a shared document behind a sign-in", text: "Log in to see the document: https://docs.example/d/1x9K2mQv7R/edit" },
  { name: "a promo code", text: "Use promo code SAVE20 at checkout." },
  { name: "a phone number", text: "Call me at 555-201-4433 and we'll log in together." },
  { name: "a price and a time", text: "Sign in before 10:30 to keep the $1250 rate." },
  { name: "a year in a password policy", text: "Our 2026 password policy asks for 14 characters." },
  { name: "an issue link", text: "Sign in to comment: https://tracker.example/fernworks/issues/4471" },
  { name: "a pickup number", text: "Your pickup code is 47.", context: "Your order is ready" },
  { name: "an invoice", text: "Invoice INV-2026-0931: $49.00 charged to the card ending 4417." },
];

describe("withheld", () => {
  for (const c of WITHHELD) test(c.name, () => {
    const r = screenCredentials(c.text, { where: "open in Mail", ...(c.context ? { context: c.context } : {}) });
    expect(r.withheld).toBeGreaterThan(0);
    for (const s of c.gone) expect(r.text).not.toContain(s);
    for (const s of c.kept) expect(r.text).toContain(s);
    expect(r.text).toContain("withheld — open in Mail]");
  });
});

describe("kept", () => {
  for (const c of KEPT) test(c.name, () => {
    expect(screenCredentials(c.text, c.context ? { context: c.context } : {})).toEqual({ text: c.text, withheld: 0 });
  });
});

test("the placeholder says what was withheld and where the person sees it", () => {
  expect(screenCredentials("Reset your password: https://a.example/reset/7c2e91ab55f04d1c8e3a").text)
    .toBe("Reset your password: [sign-in link withheld — open the original]");
  expect(screenCredentials("482910 is your verification code", { where: "open in Mail" }).text)
    .toBe("[one-time code withheld — open in Mail] is your verification code");
});
