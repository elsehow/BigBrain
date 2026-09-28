import { expect, test } from "bun:test";
import { createPagedSearch, emptyPagedResults, type ResultPage } from "../web/ui/src/lib/pagedSearch";
const hit = (path: string) => ({ note: { path } });
type Hit = ReturnType<typeof hit>;
const pause = () => Bun.sleep(15);

test("local sessions appear before remote pages and reconcile without moving the selected identity", async () => {
  const state = emptyPagedResults<Hit>();
  let locals = [hit("pilot-draft")];
  let complete!: (page: ResultPage<Hit>) => void;
  const runner = createPagedSearch(state, (_, offset) => offset ? Promise.resolve({ hits: [hit("b")], nextOffset: null })
    : new Promise(resolve => complete = resolve), { project: hits => [...locals, ...hits] });
  runner.start("", "revision");
  expect(state.hits.map(h => h.note.path)).toEqual(["pilot-draft"]);
  expect(state.building).toBe(false);
  await pause(); complete({ hits: [hit("a")], nextOffset: 1 }); await pause();
  runner.select(1);
  locals = [hit("new-pilot"), ...locals]; runner.reconcile();
  expect(state.hits[state.sel].note.path).toBe("a");
  runner.more(true); await pause(); expect(state.hits[state.sel].note.path).toBe("b");
  locals = []; runner.reconcile();
  expect(state.hits.map(h => h.note.path)).toEqual(["a", "b"]);
  expect(state.hits[state.sel].note.path).toBe("b");
  runner.cancel();
});

test("recents and search page lazily, preserve selection, deduplicate, and cache separately", async () => {
  const state = emptyPagedResults<Hit>();
  const calls: string[] = [];
  const runner = createPagedSearch(state, async (q, offset) => {
    calls.push(`${q}:${offset}`);
    return offset ? { hits: [hit("c"), hit("d")], nextOffset: null }
      : { hits: [hit(q || "a"), hit("b"), hit("c")], nextOffset: 3 };
  }, { debounceMs: 0 });
  runner.start("", "rev1"); await pause();
  expect(calls).toEqual([":0"]);
  expect(state.sel).toBe(0);
  runner.select(2);
  runner.more(true); await pause();
  expect(state.hits.map(h => h.note.path)).toEqual(["a", "b", "c", "d"]);
  expect(state.sel).toBe(3);
  expect(state.nextOffset).toBeNull();
  runner.more(); await pause();
  expect(calls.length).toBe(2);
  runner.start("query", "rev1"); await pause();
  expect(state.hits[0].note.path).toBe("query");
  runner.start("", "rev1");
  expect(state.hits[0].note.path).toBe("a");
  expect(state.sel).toBe(0);
  expect(calls.length).toBe(3);
  runner.start("", "rev2"); await pause();
  expect(calls.length).toBe(4);
});

test("late pages cannot contaminate new queries; failed pages retain rows and retry", async () => {
  const state = emptyPagedResults<Hit>();
  let late!: (page: ResultPage<Hit>) => void;
  let signal!: AbortSignal;
  let fail = false;
  const runner = createPagedSearch(state, async (q, offset, abort) => {
    if (!offset) return { hits: [hit(q)], nextOffset: 1 };
    if (fail) throw Error("offline");
    signal = abort;
    return new Promise(resolve => { late = resolve; });
  }, { debounceMs: 0 });
  runner.start("old", "1"); await pause();
  runner.more(); await pause();
  runner.start("new", "1");
  expect(signal.aborted).toBe(true);
  await pause();
  late({ hits: [hit("stale")], nextOffset: null }); await pause();
  expect(state.hits.map(h => h.note.path)).toEqual(["new"]);
  fail = true; runner.more(); await pause();
  expect(state.moreFailed).toBe("error");
  expect(state.hits.map(h => h.note.path)).toEqual(["new"]);
  expect(state.sel).toBe(0);
  fail = false; runner.more(); await pause();
  runner.select(-1); // a changed cursor must not be moved by the page response
  late({ hits: [hit("next")], nextOffset: null }); await pause();
  expect(state.hits.map(h => h.note.path)).toEqual(["new", "next"]);
  expect(state.moreFailed).toBe("");
  expect(state.sel).toBe(-1);
});


test("cached recents paint before revalidation and retain the highlighted path", async () => {
  const state = emptyPagedResults<Hit>();
  let done!: (page: ResultPage<Hit>) => void;
  const runner = createPagedSearch(state, () => new Promise(resolve => { done = resolve; }), {
    cached: query => query ? undefined : { hits: [hit("a"), hit("b")], nextOffset: 2 },
  });
  runner.start("", "new revision");
  expect(state.hits.map(h => h.note.path)).toEqual(["a", "b"]);
  expect(state.building).toBe(false);
  runner.select(1);
  await pause();
  done({ hits: [hit("new arrival"), hit("a"), hit("b")], nextOffset: 3 });
  await pause();
  expect(state.sel).toBe(2);
  expect(state.hits[state.sel].note.path).toBe("b");
});


test("automatic selection follows the top result when remote hits outrank optimistic sessions", async () => {
  const state = emptyPagedResults<Hit>();
  let complete!: (page: ResultPage<Hit>) => void;
  const runner = createPagedSearch(state, () => new Promise(resolve => complete = resolve), {
    debounceMs: 0, project: hits => [...hits, hit("pilot-atlas")],
  });
  runner.start("atlas", "revision");
  expect(state.hits[state.sel].note.path).toBe("pilot-atlas");
  await pause();
  complete({ hits: [hit("entity-atlas"), hit("source-atlas"), hit("memory-atlas")], nextOffset: null });
  await pause();
  expect(state.sel).toBe(0);
  expect(state.hits[state.sel].note.path).toBe("entity-atlas");
  runner.reconcile();
  expect(state.sel).toBe(0);
  runner.cancel();
});

test("explicitly choosing even the first optimistic result preserves it when server results arrive", async () => {
  const state = emptyPagedResults<Hit>();
  let complete!: (page: ResultPage<Hit>) => void;
  const runner = createPagedSearch(state, () => new Promise(resolve => complete = resolve), {
    debounceMs: 0, project: hits => [...hits, hit("pilot-atlas")],
  });
  runner.start("atlas", "revision");
  runner.select(0);
  await pause();
  complete({ hits: [hit("entity-atlas"), hit("source-atlas")], nextOffset: null });
  await pause();
  expect(state.sel).toBe(2);
  expect(state.hits[state.sel].note.path).toBe("pilot-atlas");
  runner.start("atlas next", "revision");
  await pause();
  complete({ hits: [hit("entity-next")], nextOffset: null });
  await pause();
  expect(state.sel).toBe(0);
  runner.cancel();
});
