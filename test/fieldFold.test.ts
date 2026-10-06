import { expect, test } from "bun:test";
import { buildField, foldOffer, twinsOf } from "../web/ui/src/lib/v2/model";
import type { GraphData } from "../web/ui/src/lib/types";

const A = "ent_aaaaaaaaaaaaaaaaaaaa", B = "ent_bbbbbbbbbbbbbbbbbbbb", C = "ent_cccccccccccccccccccc";
const node = (id: string, title: string, degree: number, x: number) => ({ id, title, group: "entity", entity: true, degree, path: `projection/entities/${id}.md`, x, y: x });
const field = (...nodes: ReturnType<typeof node>[]) => buildField({ hash: "h", nodes, edges: [] } as unknown as GraphData);
const at = (f: ReturnType<typeof field>, id: string) => f.byId.get(id)!;

const D = "ent_dddddddddddddddddddd";

test("on the keeper, every other twin is a row to fold in, most-tied first", () => {
  const f = field(node(A, "Avery Quill", 2, 1), node(B, "Avery-Quill", 40, 2), node(C, "avery quill", 5, 3), node(D, "Bo Lark", 5, 4));
  expect(foldOffer(f, at(f, B), twinsOf(f), [])).toEqual({ keep: B, rows: [C, A], kind: "twins" });
  expect(foldOffer(f, at(f, D), twinsOf(f), [])).toBeNull();
});

test("off the keeper, the keeper is the one row: fold into it", () => {
  const f = field(node(A, "Avery Quill", 2, 1), node(B, "Avery-Quill", 40, 2), node(C, "avery quill", 5, 3));
  expect(foldOffer(f, at(f, A), twinsOf(f), [])).toEqual({ keep: B, rows: [B], kind: "twins" });
});

test("a proposal keeps its own pick, wherever you open it", () => {
  const f = field(node(A, "Trail Map", 9, 1), node(B, "TrailAtlas", 3, 2), node(C, "Trailmap app", 1, 3));
  const proposals = [{ canonical: B, members: [{ id: A }, { id: B }, { id: C }], why: "renamed" }];
  expect(foldOffer(f, at(f, A), twinsOf(f), proposals)).toEqual({ keep: B, rows: [B], kind: "proposal", why: "renamed" });
  expect(foldOffer(f, at(f, B), twinsOf(f), proposals)).toEqual({ keep: B, rows: [A, C], kind: "proposal", why: "renamed" });
});

test("only this vault's recorded entities fold: a joined vault's node is left out", () => {
  const f = field(node(A, "Avery Quill", 2, 1), node(`shared:v1:${B}`, "Avery Quill", 4, 2));
  expect(foldOffer(f, at(f, A), twinsOf(f), [])).toBeNull();
});

test("a twin you said is a different thing is not offered again", () => {
  const f = field(node(A, "Avery Quill", 2, 1), node(B, "Avery-Quill", 40, 2), node(C, "Avery quill", 3, 3));
  expect(foldOffer(f, at(f, A), twinsOf(f), [], [[A, B]])).toEqual({ keep: C, rows: [C], kind: "twins" });
  expect(foldOffer(f, at(f, A), twinsOf(f), [], [[A, B], [A, C]])).toBeNull();
});
