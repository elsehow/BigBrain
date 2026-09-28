import { openExternal } from "./native";

/** Does this href leave the viewer's own document?
 *
 * The viewer is ONE page — every route is a hash on it — so the only
 * navigations it means are `#/…`. Anything else a note carries (a clipped
 * page's links, a mail's, an agent transcript's) is a page of its own, and
 * under the desktop shell a click on it loaded that page INTO the app's
 * webview: no tabs, no back button, no way out but quitting (Nick,
 * 2026-09-02). Those open outside the app instead — see openExternalLinks.
 *
 * "Outside" is judged against the page's own URL: another origin, or another
 * path on this one (`/api/file?…` — an attachment is a document too, and the
 * browser is the better reader of a PDF). mailto:/tel: go out as well; a
 * scheme the webview can't hand off (blob:, data:) is left to it. */
export function isExternalHref(href: string, here: string): boolean {
  let u: URL;
  let h: URL;
  try {
    u = new URL(href, here);
    h = new URL(here);
  } catch {
    return false;
  }
  if (u.protocol === "http:" || u.protocol === "https:") return u.origin !== h.origin || u.pathname !== h.pathname;
  return u.protocol === "mailto:" || u.protocol === "tel:";
}

/** The window's click handler: a plain click on a link that leaves the
 * document opens it outside the app (the opener plugin under the shell, a
 * new tab in a browser — lib/native.ts). Modified and non-primary clicks are
 * the browser's own (⌘-click already means "elsewhere"), and anything a
 * closer handler already answered stays answered. */
export function openExternalLinks(e: MouseEvent): void {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
  if (!a) return;
  if (!isExternalHref(a.getAttribute("href") ?? "", location.href)) return;
  e.preventDefault();
  openExternal(a.href);
}
