/**
 * pilotDesktop.ts — a Pilot session's desktop: the views beside its chat.
 *
 * A desktop is one conversation plus whatever the agent chose to show
 * beside it (a vault note, for now), tiled however it arranged them. With
 * no views the chat stands alone, centred. The state lives on the session
 * (PilotChatSession.desktop), so it survives reloads and the agent sees what
 * is open; this module is every change to it, pure.
 *
 * The person's hand wins. A view they close stays closed to the agent
 * unless they ask for it again, and once they arrange the tiles the agent
 * no longer rearranges them — the same rule as a title they typed
 * (lib/pilotTaskName.ts).
 */

export type DesktopTile = { view: string } | { dir: "row" | "col"; weights: number[]; kids: DesktopTile[] };

export interface DesktopView {
  id: string;
  /** "note": a vault note. "url": a page served on this machine's loopback, such as an agent's dev server.
   * "html": a page the agent wrote, shown in the person's theme (web/ui/src/lib/pageTheme.ts). */
  kind: "note" | "url" | "html";
  /** What the view shows: the note's vault path, the page's address, or (html) a key from its title. */
  path: string;
  /** html views: the agent's semantic HTML. */
  html?: string;
  title: string;
  at: string;
}

export interface PilotDesktop {
  views: DesktopView[];
  /** Absent: the views tile themselves (autoTile). */
  layout?: DesktopTile;
  /** Who set `layout`; "human" means the agent leaves it alone. */
  arrangedBy?: "agent" | "human";
  /** Paths the person closed: the agent reopens one only when asked. */
  closed?: string[];
}

export const MAX_VIEWS = 6;
const MAX_DEPTH = 3;

export class DesktopError extends Error {}

export const emptyDesktop = (): PilotDesktop => ({ views: [] });

/** One view fills; two sit side by side; more go in columns of stacked views. */
export function autoTile(views: readonly Pick<DesktopView, "id">[]): DesktopTile | undefined {
  if (!views.length) return undefined;
  if (views.length === 1) return { view: views[0]!.id };
  const cols = Math.ceil(Math.sqrt(views.length)), per = Math.ceil(views.length / cols);
  const kids: DesktopTile[] = [];
  for (let c = 0; c < cols; c++) {
    const col = views.slice(c * per, c * per + per);
    if (col.length) kids.push(col.length === 1 ? { view: col[0]!.id } : { dir: "col", weights: col.map(() => 1), kids: col.map((v) => ({ view: v.id })) });
  }
  return { dir: "row", weights: kids.map(() => 1), kids };
}

/** The tiling actually drawn: the stored layout, or the automatic one. */
export const desktopLayout = (d: PilotDesktop): DesktopTile | undefined => d.layout ?? autoTile(d.views);

const tileViews = (t: DesktopTile): string[] => ("view" in t ? [t.view] : t.kids.flatMap(tileViews));

/** A layout must place every open view exactly once, with sane weights and depth. */
export function checkLayout(d: PilotDesktop, layout: unknown, depth = 0): DesktopTile {
  if (!layout || typeof layout !== "object" || Array.isArray(layout)) throw new DesktopError("A layout is a view ({view}) or a split ({dir, weights, kids}).");
  const t = layout as Record<string, unknown>;
  if (depth > MAX_DEPTH) throw new DesktopError(`Nest splits at most ${MAX_DEPTH} deep.`);
  let tile: DesktopTile;
  if (typeof t.view === "string") tile = { view: t.view };
  else {
    if (t.dir !== "row" && t.dir !== "col") throw new DesktopError('A split\'s dir is "row" (side by side) or "col" (stacked).');
    if (!Array.isArray(t.kids) || t.kids.length < 2) throw new DesktopError("A split holds at least two tiles.");
    const weights = Array.isArray(t.weights) ? t.weights : t.kids.map(() => 1);
    if (weights.length !== t.kids.length || !weights.every((w) => typeof w === "number" && Number.isFinite(w) && w > 0 && w <= 12))
      throw new DesktopError("Give one positive weight (up to 12) per tile.");
    tile = { dir: t.dir, weights: weights as number[], kids: t.kids.map((k) => checkLayout(d, k, depth + 1)) };
  }
  if (depth === 0) {
    const placed = tileViews(tile), open = d.views.map((v) => v.id);
    if (placed.length !== new Set(placed).size || placed.length !== open.length || !open.every((id) => placed.includes(id)))
      throw new DesktopError(`Place every open view exactly once: ${open.join(", ") || "(none open)"}.`);
  }
  return tile;
}

/** Add a split beside a stored layout for a newly opened view; it never displaces the others. */
const withView = (layout: DesktopTile | undefined, id: string): DesktopTile | undefined =>
  !layout ? undefined : "dir" in layout && layout.dir === "row" ? { ...layout, weights: [...layout.weights, 1], kids: [...layout.kids, { view: id }] }
    : { dir: "row", weights: [2, 1], kids: [layout, { view: id }] };

const withoutView = (layout: DesktopTile | undefined, id: string): DesktopTile | undefined => {
  if (!layout) return undefined;
  if ("view" in layout) return layout.view === id ? undefined : layout;
  const kept = layout.kids.map((k, i) => [withoutView(k, id), layout.weights[i]!] as const).filter(([k]) => k);
  if (!kept.length) return undefined;
  if (kept.length === 1) return kept[0]![0];
  return { dir: layout.dir, weights: kept.map(([, w]) => w), kids: kept.map(([k]) => k!) };
};

export function openView(d: PilotDesktop, view: Omit<DesktopView, "id">, id: string, opts: { userAsked?: boolean } = {}): PilotDesktop {
  const already = d.views.find((v) => v.kind === view.kind && v.path === view.path);
  // a page shown again under the same title is updated in place
  if (already) return view.kind === "html" && view.html !== already.html
    ? { ...d, views: d.views.map((v) => (v === already ? { ...v, html: view.html, title: view.title, at: view.at } : v)) } : d;
  if (d.closed?.includes(view.path) && !opts.userAsked)
    throw new DesktopError("The person closed this view. Reopen it only if they ask to see it again (set user_asked).");
  if (d.views.length >= MAX_VIEWS) throw new DesktopError(`At most ${MAX_VIEWS} views are open at once; close one first.`);
  return { ...d, views: [...d.views, { ...view, id }], layout: withView(d.layout, id), closed: d.closed?.filter((p) => p !== view.path) };
}

export function closeView(d: PilotDesktop, id: string, by: "agent" | "human"): PilotDesktop {
  const view = d.views.find((v) => v.id === id);
  if (!view) throw new DesktopError("No such view on this desktop.");
  const views = d.views.filter((v) => v.id !== id);
  const layout = withoutView(d.layout, id);
  return { ...d, views, layout, ...(layout ? {} : { arrangedBy: undefined }),
    ...(by === "human" ? { closed: [...new Set([...(d.closed ?? []), view.path])] } : {}) };
}

export function arrangeDesktop(d: PilotDesktop, layout: unknown, by: "agent" | "human"): PilotDesktop {
  if (by === "agent" && d.arrangedBy === "human") throw new DesktopError("The person arranged this desktop; leave its layout as they set it.");
  return { ...d, layout: checkLayout(d, layout), arrangedBy: by };
}

/** What the app is sent: the views, and the tiling to draw. */
export const desktopDetail = (d: PilotDesktop) => ({
  views: d.views.map(({ id, kind, path, title, at, html }) => ({ id, kind, path, title, at, ...(html !== undefined ? { html } : {}) })),
  layout: desktopLayout(d) ?? null,
  arrangedBy: d.arrangedBy ?? null,
});

/** What the agent sees of its own desktop, each turn. */
export const desktopReference = (d: PilotDesktop | undefined) => ({
  views: (d?.views ?? []).map((v) => ({ id: v.id, kind: v.kind, path: v.path, title: v.title })),
  layout: d ? desktopLayout(d) ?? null : null,
  arrangedBy: d?.arrangedBy ?? null,
  closedByPerson: d?.closed ?? [],
});

/** A page a desktop may embed: http on a loopback address only, so a view can
 * show an agent's dev server and nothing from the wider web. */
export function loopbackUrl(raw: unknown): string {
  let url: URL;
  try { url = new URL(String(raw)); } catch { throw new DesktopError("Give a full address, such as http://127.0.0.1:5173/."); }
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname))
    throw new DesktopError("Only pages served on this machine (http://127.0.0.1 or localhost) can be shown on a desktop.");
  return url.href;
}

/** For agents that run servers (coding desktops): show one beside the chat. */
export const SHOW_PAGE_TOOL = { type: "function", name: "show_page", strict: false,
  description: "Show a page served on this machine, such as a dev server you started, on your desktop beside this chat. Use it when the person should see the running result. Only loopback addresses (http://127.0.0.1:<port>, localhost) can be shown. Showing a page that is already open does nothing.",
  parameters: { type: "object", properties: { url: { type: "string", description: "The page's address, e.g. http://127.0.0.1:5173/." }, title: { type: "string", description: "A short label for the view." }, user_asked: { type: "boolean", description: "True only when the person asked to see a page they had closed." } }, required: ["url"], additionalProperties: false } };

/** The most HTML one page may carry. */
export const MAX_PAGE_HTML = 200_000;

/** For agents that make things to show (coding desktops): a page in the person's own style. */
export const SHOW_HTML_TOOL = { type: "function", name: "show_html", strict: false,
  description: "Show a page you wrote on your desktop, beside this chat: a report, a comparison, a table of results, a chart. Write plain semantic HTML only (h1–h3, p, ul/ol, table with th/td, pre/code, figure/figcaption, inline svg for charts). Do NOT write CSS, style attributes or scripts: the page is dressed in the person's BigBrain theme, and scripts don't run. Classes you may use: muted, faint, accent, num (right-aligned figures), grid and card (a grid of cards). Showing a page with the same title again updates it.",
  parameters: { type: "object", properties: { title: { type: "string", description: "A short title; it names the view." }, html: { type: "string", description: "The page's body: semantic HTML, no CSS or scripts." } }, required: ["title", "html"], additionalProperties: false } };

export const DESKTOP_TOOLS = [
  { type: "function", name: "open_view", strict: false,
    description: "Show a vault note on your desktop, beside this chat, for the person to read. Use discretion: open one only when seeing the source itself serves them better than your summary — they asked to see it, or your answer rests on one document they will want to read or check. Do not open views for routine reads or to show your work. Opening a note that is already open does nothing.",
    parameters: { type: "object", properties: { path: { type: "string", description: "The note's exact vault path, from a read or search result." }, user_asked: { type: "boolean", description: "True only when the person asked to see a note they had closed." } }, required: ["path"], additionalProperties: false } },
  { type: "function", name: "close_view", strict: false,
    description: "Close a view on your desktop when it no longer serves the conversation. With no views, the chat stands alone.",
    parameters: { type: "object", properties: { view: { type: "string", description: "The view's id, from your desktop reference." } }, required: ["view"], additionalProperties: false } },
  { type: "function", name: "arrange_desktop", strict: false,
    description: 'Tile your desktop\'s open views. A layout is a view {"view": id} or a split {"dir": "row" (side by side) | "col" (stacked), "weights": [relative sizes], "kids": [tiles]}, placing every open view exactly once. Views tile themselves sensibly by default; arrange only when that does not serve, e.g. one main document and a smaller reference. If the person arranged the desktop, leave it.',
    parameters: { type: "object", properties: { layout: { type: "object" } }, required: ["layout"], additionalProperties: false } },
];
