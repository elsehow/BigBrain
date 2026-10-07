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
const CODE_CONTEXT = /\b(?:verification|verify|one[- ]?time|otp|passcodes?|security code|log[- ]?in code|sign[- ]?in code|2fa|mfa|two[- ]factor|multi[- ]factor|authenticat\w*|passwords?|passwort|reset|recovery codes?|backup codes?|sign(?:ing)?[- ]?in|log(?:ging)?[- ]?in)\b|v[ée]rification|contraseña|senha|código|確認コード|認証コード|ワンタイム|パスワード/iu;
/** Weaker words: enough only on the code's own line, and only without an order's words beside it. */
const CODE_WORD = /\b(?:code|pin)\b|コード/iu;
/** Lines about orders, parcels and the like, whose numbers are not credentials. */
const NOT_SIGN_IN = /\b(?:orders?|tracking|track|parcel|shipment|shipped|invoice|receipt|ticket|booking|reservation|reference|pickup|promo|discount|coupon|voucher|gift|referral|zip|postal|area code|dress code|source code|qr code|error code|status code|pull request|commit|card ending)\b/iu;
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
  /(?<![\w$€£#:/.,-]|\d[ -])\d{3}[ -]\d{3}(?![\w]|[ -]?\d)/gu,
  /(?<![\w$€£#:/.,-]|\d[ -])\d{4}-\d{4}(?![\w]|[ -]\d)/gu,
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
    const codes = CODE_CONTEXT.test(line) || (!ordered && (CODE_WORD.test(line) || CODE_CONTEXT.test(near)));
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
    if (codes) for (const shape of CODES) next = next.replace(shape, code => {
      if (YEAR.test(code)) return code;
      withheld++;
      return said("one-time code");
    });
    return next;
  });
  return { text: withheld ? out.join("\n") : text, withheld };
}
