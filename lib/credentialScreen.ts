/** credentialScreen.ts — sign-in material withheld from agents, locally.
 *
 * The intake firewall (lib/firewall.ts) asks a model whether an arrival
 * carries a credential, only while a Jev key is set, and live reads never
 * pass through it. This screen runs on what agents read of mail, meeting
 * notes and stored sources: no network, no model. It replaces what would let
 * an agent finish a sign-in (a one-time code, a reset, magic-login or
 * verification link, a temporary or app password, recovery codes) with a
 * visible placeholder and leaves the rest of the text as it was.
 *
 * Each rule needs the secret's shape AND sign-in context, so order numbers,
 * tracking links and shared documents pass. test/credentialScreen.test.ts
 * holds the corpus, both ways. */

export interface Screened { text: string; withheld: number }
export interface ScreenOptions {
  /** Where the person can see what was withheld: "open in Mail". */
  where?: string;
  /** Text around the screened text that sets context, such as a message's subject. */
  context?: string;
}

/** Words that make a nearby code a sign-in code. */
const CODE_CONTEXT = /\b(?:verification|verify|one[- ]?time|otp|passcodes?|security code|log[- ]?in code|sign[- ]?in code|2fa|mfa|two[- ]factor|multi[- ]factor|authenticat\w*|passwords?|passwort|recovery codes?|backup codes?|sign(?:ing)?[- ]?in|log(?:ging)?[- ]?in)\b|v[ée]rification|contraseña|senha|código|確認コード|認証コード|ワンタイム|パスワード/iu;
/** Weaker words: enough only beside the code, and only without an order's words on its line. */
const CODE_WORD = /\b(?:code|pin|expires?)\b|コード/iu;
/** How far from its words a code in a line of prose may stand. */
const NEAR = 60;
/** A placeholder this screen wrote, which must not count as context for the next match. */
const PLACEHOLDER = /\[[^\]\n]* withheld — [^\]\n]*\]/gu;
/** Lines about orders, parcels and the like, whose numbers are not credentials. */
const NOT_SIGN_IN = /\b(?:orders?|tracking|track|parcel|shipment|shipped|invoice|receipt|ticket|booking|reservation|reference|pickup|promo|discount|coupon|voucher|gift|referral|% off|sale|deals?|zip|postal|area code|dress code|source code|qr code|error code|status code|code review|pull request|commit|card ending)\b/iu;
/** Words that make an opaque link a sign-in link. */
const LINK_CONTEXT = /\b(?:passwords?|passwort|reset|magic|verify|verification|activate|unlock|one[- ]?time|single[- ]use|approve|2fa|two[- ]factor|invit\w*|log in as|sign in as|(?:sign[- ]?in|log[- ]?in|login) link|confirm (?:your|this|the) (?:new )?(?:email|address|account|sign[- ]?in))\b|(?:link|code)\b[^.\n]{0,40}\bexpire|v[ée]rification|contraseña|senha|restablecer|zurücksetzen|redefinir|réinitialiser/iu;
/** Path and parameter words of sign-in links. */
const LINK_WORD = /(?:^|[/_\-.?=&])(?:reset|password|passwd|pw|pwd|verify|verification|confirm|magic|login|signin|sign-in|sign_in|web_login|auth|oauth|unlock|activate|activation|approve|2fa|mfa|otp|recover|recovery|invite|accept|restablecer|zuruecksetzen|zurucksetzen|redefinir|reinitialiser|sso)(?=$|[/_\-.?=&])/iu;
/** Parameters that carry a link's secret. */
const SECRET_PARAM = /^(?:token|nonce|code|key|k|t|sig|signature|hash|otp|auth|ticket|req|session|magic|uidb\d*)$/iu;

const URL = /https?:\/\/[^\s<>"'`\]]+/giu;
/** Code shapes, each guarded so a price, date, time or phone number does not match. */
const CODES = [
  /(?<![\w$€£#:/.,-])(?:[A-Z]-)?\d{4,8}(?![\w%]|[:/.,-]\d)/gu,
  /(?<![\w$€£#:/.,-]|\d[ -])\d{3,4}[ -]\d{3,4}(?![\w]|[ -]?\d)/gu,
  /(?<![\w-])(?=[A-Z0-9-]*\d)(?=[A-Z0-9-]*[A-Z])[A-Z0-9]{3,4}-[A-Z0-9]{3,4}(?![\w-])/gu,
  /(?<![\w-])(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{6,8}(?![\w-])/gu,
];
const YEAR = /^(?:19|20)\d\d$/u;
/** A password given after its label: "Temporary password: Tq7#mVx2!pL9". */
const LABELLED = /(\b(?:temporary |temp |one-time |initial |new |your )?(?:password|passcode|passwort|contraseña|senha)\s*(?:is\s*)?[:=]\s*)((?=\S*[\d!@#$%^&*])\S{6,})/giu;
/** An app password: four groups of four letters, said to be one. */
const APP_PASSWORD = /\b[a-z]{4}(?: [a-z]{4}){3}\b/gu;

/** A link's secret: an opaque path segment or parameter value, or a parameter named for one. */
function opaque(url: URL): boolean {
  const token = (v: string) => /^(?=.*\d)(?=.*[A-Za-z])[\w\-.~=+%]{8,}$/u.test(v) || /^[\w-]{16,}$/u.test(v);
  if (url.pathname.split("/").some(token)) return true;
  for (const [k, v] of url.searchParams) if (token(v) || (SECRET_PARAM.test(k) && v.length >= 4)) return true;
  return false;
}

/** A subject or opening line that says the message is about signing in. */
const SIGN_IN_SUBJECT = /\b(?:verification|verify|passcodes?|passwords?|passwort|sign(?:ing)?[- ]?in|log(?:ging)?[- ]?in|login|2fa|mfa|two[- ]factor|one[- ]?time|otp|security (?:alert|code)|confirm your (?:new )?(?:email|e-mail|address|account)|magic link|new device|unlock|recovery codes?|backup codes?|authenticat\w*|reset (?:request|link|code))\b|v[ée]rification|contraseña|senha|確認コード|認証/iu;
/** Senders that only send about accounts and signing in. A no-reply sender
 * says nothing either way: orders and newsletters come from one too. */
const SIGN_IN_SENDER = new Set(["security", "account", "accounts", "verify", "verification", "auth", "authentication", "login", "signin", "otp", "2fa", "mfa", "identity"]);
/** Sender words that make an account sender a billing or marketing one. */
const NOT_SIGN_IN_SENDER = new Set(["billing", "payable", "receivable", "invoice", "invoices", "orders", "sales", "news", "newsletter", "marketing"]);

/** Does this message look like sign-in mail? Its sender's mailbox, its subject,
 * or the opening of its body (the preheader) says so. "Code" alone counts
 * only without an order's or a promotion's words beside it. */
export function signInMail(m: { from?: string[]; subject?: string | undefined; preheader?: string | undefined }): boolean {
  const says = (text = "") => SIGN_IN_SUBJECT.test(text) || (/\bcodes?\b/iu.test(text) && !NOT_SIGN_IN.test(text));
  if (says(m.subject) || says(m.preheader?.slice(0, 300))) return true;
  return (m.from ?? []).some(address => {
    const words = (address.split("@")[0] ?? "").toLowerCase().split(/[-_.+]/u);
    return words.some(w => SIGN_IN_SENDER.has(w)) && !words.some(w => NOT_SIGN_IN_SENDER.has(w));
  });
}

/** Withhold what would let an agent finish a sign-in from `text`. */
export function screenCredentials(text: string, options: ScreenOptions = {}): Screened {
  if (!text) return { text, withheld: 0 };
  const where = options.where ?? "open the original";
  const said = (what: string) => `[${what} withheld — ${where}]`;
  const lines = text.split("\n");
  const context = options.context ?? "";
  let withheld = 0;
  /** The line itself, the two non-blank lines before it and the one after, and the context. */
  const around = (i: number): string => {
    const near: string[] = [];
    for (let j = i - 1; j >= 0 && near.length < 2; j--) if (lines[j]!.trim()) near.push(lines[j]!);
    for (let j = i + 1; j < lines.length; j++) if (lines[j]!.trim()) { near.push(lines[j]!); break; }
    return [...near, context].join("\n");
  };
  const out = lines.map((line, i) => {
    if (!line.trim()) return line;
    const near = around(i);
    const ordered = NOT_SIGN_IN.test(line);
    // a line of nothing but codes takes its words from around it; a code in prose needs them beside it
    const alone = !CODES.reduce((t, shape) => t.replace(shape, ""), line).replace(/[\s\p{P}]/gu, "");
    const beside = (code: string, at: number, all: string): boolean => {
      const window = all.slice(Math.max(0, at - NEAR), at + code.length + NEAR).replace(PLACEHOLDER, " ");
      return CODE_CONTEXT.test(window) || (!ordered && CODE_WORD.test(window));
    };
    const links = LINK_CONTEXT.test(line) || (!ordered && LINK_CONTEXT.test(near));
    let next = line.replace(URL, raw => {
      const href = raw.replace(/[.,;:!?)]+$/u, "");
      let url: URL;
      try { url = new globalThis.URL(href); } catch { return raw; }
      const words = `${url.pathname}?${[...url.searchParams.keys()].join("&")}`;
      if (!opaque(url) || !(LINK_WORD.test(words) || links)) return raw;
      withheld++;
      return said("sign-in link") + raw.slice(href.length);
    });
    next = next.replace(LABELLED, (_, label: string) => { withheld++; return label + said("password"); });
    if (/app[- ]password|app-specific password/iu.test(`${line}\n${near}`))
      next = next.replace(APP_PASSWORD, () => { withheld++; return said("password"); });
    if (!alone || CODE_CONTEXT.test(near)) for (const shape of CODES) next = next.replace(shape, (code: string, at: number, all: string) => {
      if (YEAR.test(code) || !(alone || beside(code, at, all))) return code;
      withheld++;
      return said("one-time code");
    });
    return next;
  });
  return { text: withheld ? out.join("\n") : text, withheld };
}
