import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { arrangeDesktop, autoTile, closeView, desktopLayout, emptyDesktop, openView, MAX_VIEWS, type PilotDesktop } from "../lib/pilotDesktop";
import { PilotChats } from "./support/pilotSession";
import { nativeVault } from "./support/vault";

const at = "2026-01-01T00:00:00.000Z";
const note = (path: string) => ({ kind: "note" as const, path, title: path, at });
const open = (...paths: string[]) => paths.reduce<PilotDesktop>((d, p, i) => openView(d, note(p), `v${i + 1}`), emptyDesktop());

describe("a desktop's views", () => {
  test("no views: nothing tiles, so the chat stands alone", () => {
    expect(desktopLayout(emptyDesktop())).toBeUndefined();
  });

  test("views tile themselves: one fills, two side by side, more in stacked columns", () => {
    expect(autoTile([{ id: "a" }])).toEqual({ view: "a" });
    expect(autoTile([{ id: "a" }, { id: "b" }])).toEqual({ dir: "row", weights: [1, 1], kids: [{ view: "a" }, { view: "b" }] });
    expect(autoTile(["a", "b", "c"].map((id) => ({ id })))).toEqual({ dir: "row", weights: [1, 1], kids: [{ dir: "col", weights: [1, 1], kids: [{ view: "a" }, { view: "b" }] }, { view: "c" }] });
  });

  test("opening the same note twice does nothing; there is a ceiling", () => {
    const d = open("notes/orrery.md");
    expect(openView(d, note("notes/orrery.md"), "dup")).toBe(d);
    const full = open(...Array.from({ length: MAX_VIEWS }, (_, i) => `notes/${i}.md`));
    expect(() => openView(full, note("notes/one-more.md"), "x")).toThrow(/At most/);
  });

  test("a layout places every open view exactly once", () => {
    const d = open("notes/a.md", "notes/b.md");
    expect(arrangeDesktop(d, { dir: "col", weights: [3, 1], kids: [{ view: "v1" }, { view: "v2" }] }, "agent").layout).toEqual({ dir: "col", weights: [3, 1], kids: [{ view: "v1" }, { view: "v2" }] });
    expect(() => arrangeDesktop(d, { view: "v1" }, "agent")).toThrow(/every open view/);
    expect(() => arrangeDesktop(d, { dir: "row", kids: [{ view: "v1" }, { view: "v1" }] }, "agent")).toThrow(/every open view/);
    expect(() => arrangeDesktop(d, { dir: "diagonal", kids: [{ view: "v1" }, { view: "v2" }] }, "agent")).toThrow(/row/);
  });

  test("the person's hand wins: a layout they set, a view they closed", () => {
    const d = arrangeDesktop(open("notes/a.md", "notes/b.md"), { dir: "row", weights: [2, 1], kids: [{ view: "v1" }, { view: "v2" }] }, "human");
    expect(() => arrangeDesktop(d, { dir: "col", kids: [{ view: "v1" }, { view: "v2" }] }, "agent")).toThrow(/person arranged/);
    const closed = closeView(d, "v2", "human");
    expect(closed.layout).toEqual({ view: "v1" });
    expect(() => openView(closed, note("notes/b.md"), "v3")).toThrow(/person closed/);
    expect(openView(closed, note("notes/b.md"), "v3", { userAsked: true }).views.map((v) => v.path)).toEqual(["notes/a.md", "notes/b.md"]);
    // the agent closing its own view leaves no mark
    expect(closeView(open("notes/a.md"), "v1", "agent").closed).toBeUndefined();
  });

  test("a view opened into an arranged desktop joins beside it, displacing nothing", () => {
    const d = arrangeDesktop(open("notes/a.md", "notes/b.md"), { dir: "col", weights: [1, 1], kids: [{ view: "v1" }, { view: "v2" }] }, "human");
    expect(openView(d, note("notes/c.md"), "v3").layout).toEqual({ dir: "row", weights: [2, 1], kids: [{ dir: "col", weights: [1, 1], kids: [{ view: "v1" }, { view: "v2" }] }, { view: "v3" }] });
  });
});

const roots: string[] = [];
afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

describe("the agent's desktop tools", () => {
  test("open, arrange and close through the Pilot's own tools; the person's close sticks", async () => {
    const root = nativeVault(); roots.push(root);
    const tool = async (name: string, args: Record<string, unknown>) =>
      name === "read_note" && String(args.path).startsWith("notes/") ? { path: args.path, title: `Title of ${args.path}`, markdown: "x" } : { error: "no such note" };
    const sessions = new PilotChats(root, { graph: () => [], tool });
    const s = sessions.create([]), signal = new AbortController().signal;
    const run = (name: string, args: Record<string, unknown>) => (sessions as unknown as { executeTool(s: unknown, n: string, a: unknown, sig: AbortSignal): Promise<any> }).executeTool(s, name, args, signal);

    expect((await run("open_view", { path: "missing/thing.md" })).error).toMatch(/could not be read/);
    const opened = await run("open_view", { path: "notes/orrery.md" });
    expect(opened.views).toEqual([{ id: expect.stringMatching(/^v-/), kind: "note", path: "notes/orrery.md", title: "Title of notes/orrery.md" }]);
    await run("open_view", { path: "notes/gears.md" });
    const [a, b] = s.desktop!.views.map((v) => v.id);
    expect((await run("arrange_desktop", { layout: { dir: "col", weights: [2, 1], kids: [{ view: a }, { view: b }] } })).arrangedBy).toBe("agent");

    sessions.desktop(s.id, "close", { view: b });
    expect((await run("open_view", { path: "notes/gears.md" })).error).toMatch(/person closed/);
    expect((await run("close_view", { view: a })).views).toEqual([]);
    sessions.close();
  });
});
