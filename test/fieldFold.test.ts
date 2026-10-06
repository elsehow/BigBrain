import { expect, test } from "bun:test";
import { buildField, foldOffer, twinsOf } from "../web/ui/src/lib/v2/model";
import type { GraphData } from "../web/ui/src/lib/types";

const A = "ent_aaaaaaaaaaaaaaaaaaaa", B = "ent_bbbbbbbbbbbbbbbbbbbb", C = "ent_cccccccccccccccccccc";
const node = (id: string, title: string, degree: number, x: number) => ({ id, title, group: "entity", entity: true, degree, path: `projection/entities/${id}.md`, x, y: x });
const field = (...nodes: ReturnType<typeof node>[]) => buildField({ hash: "h", nodes, edges: [] } as unknown as GraphData);
const at = (f: ReturnType<typeof field>, id: string) => f.byId.get(id)!;

test("same-name twins fold into the one the record knows best", () => {
  const f = field(node(A, "Avery Quill", 2, 1), node(B, "Avery-Quill", 40, 2), node(C, "Bo Lark", 5, 3));
  expect(foldOffer(f, at(f, A), twinsOf(f), [])).toEqual({ keep: B, fold: [A] });
  expect(foldOffer(f, at(f, B), twinsOf(f), [])).toEqual({ keep: B, fold: [A] });
  expect(foldOffer(f, at(f, C), twinsOf(f), [])).toBeNull();
});

test("the memory pass's proposal wins, its own pick kept", () => {
  const f = field(node(A, "Trail Map", 9, 1), node(B, "TrailAtlas", 3, 2), node(C, "Bo Lark", 5, 3));
  const proposals = [{ canonical: B, members: [{ id: A }, { id: B }], why: "renamed" }];
  expect(foldOffer(f, at(f, A), twinsOf(f), proposals)).toEqual({ keep: B, fold: [A], why: "renamed" });
});

test("only this vault's recorded entities fold: a joined vault's node is left out", () => {
  const f = field(node(A, "Avery Quill", 2, 1), node(`shared:v1:${B}`, "Avery Quill", 4, 2));
  expect(foldOffer(f, at(f, A), twinsOf(f), [])).toBeNull();
});

test("a twin you said is a different thing is not offered again", () => {
  const f = field(node(A, "Avery Quill", 2, 1), node(B, "Avery-Quill", 40, 2), node(C, "Avery quill", 3, 3));
  expect(foldOffer(f, at(f, A), twinsOf(f), [], [[A, B]])).toEqual({ keep: C, fold: [A] });
  expect(foldOffer(f, at(f, A), twinsOf(f), [], [[A, B], [A, C]])).toBeNull();
});
