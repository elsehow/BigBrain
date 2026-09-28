/** Local HH:MM for timestamps; older-than-today gets a "Jul 2" prefix.
 * Exact UTC midnight is the server's sentinel for a date-only source
 * (frontmatter `date: YYYY-MM-DD`) — show just that date, read in UTC so
 * every viewer timezone sees the same day, not a fictitious 12:00 AM. */
export function fmtTs(ms?: number): string {
  if (!ms) return "";
  const d = new Date(ms);
  if (d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0)
    return d.toLocaleDateString([], { month: "short", day: "numeric", timeZone: "UTC" });
  const day = d.toLocaleDateString([], { month: "short", day: "numeric" });
  const hm = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString() ? hm : `${day} ${hm}`;
}

/** The mockup feed's Gmail-rule timestamp: same calendar day as `now` →
 * just the time ("1:04 PM"), anything older → just the date ("Jul 23").
 * Keeps fmtTs's UTC-midnight sentinel: a date-only source renders its date,
 * read in UTC so every viewer timezone sees the same day. `now`/`locale`
 * parameters exist so tests can pin both. */
export function gmailTs(ms?: number, now: Date = new Date(), locale?: string): string {
  if (!ms) return "";
  const d = new Date(ms);
  if (d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0)
    return d.toLocaleDateString(locale, { month: "short", day: "numeric", timeZone: "UTC" });
  if (d.toDateString() === now.toDateString())
    return d.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
  return d.toLocaleDateString(locale, { month: "short", day: "numeric" });
}

export const isoMs = (iso: string): number | undefined => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? undefined : t;
};

/** filename → readable title: drop ".md", dashes to spaces. */
export const titleOf = (n: string): string => n.replace(/\.md$/, "").replace(/-/g, " ");

/** How long ago, in the coarsest unit that still reads as a duration: a
 * credential's "last used 3h ago". Deliberately imprecise — the question a
 * settings row answers is "recently, or not for ages?", and minutes past the
 * first hour are noise.
 *
 * Takes a timestamp, never a null: "it never happened" is a different
 * sentence on every screen ("never used", "no captures yet"), so the caller
 * says it in its own words rather than passing a fallback through here. */
/** When the memory pass runs, from vault.yaml's `memory.interval` as the
 * engine serves it (ms). Whole days and whole hours read as such; anything
 * else in minutes. No number (an older engine) reads as the default. */
export function memoryCadence(ms?: number): string {
  const m = ms !== undefined && Number.isFinite(ms) && ms > 0 ? Math.round(ms / 60_000) : 1440;
  if (m % 1440 === 0) return m === 1440 ? "Runs once per day." : `Runs every ${m / 1440} days.`;
  if (m % 60 === 0) return m === 60 ? "Runs every hour." : `Runs every ${m / 60} hours.`;
  return m === 1 ? "Runs every minute." : `Runs every ${m} minutes.`;
}

export function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 90) return "just now";
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 172800) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
