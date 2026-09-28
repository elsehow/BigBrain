/**
 * lib/wire.ts — the shared frontmatter-serialization rule for /v1/drop and
 * /v1/enqueue clients (#294, split out of #259 after #293's review flagged
 * the duplication). Two kinds of coverage live here:
 *
 *  - Unit tests of fmSerialize/fmBody/fmRaw/dropJsonBody/enqueueBody in
 *    isolation.
 *  - GOLDEN tests that pin each real caller's byte-for-byte output for
 *    fixed inputs. Every one of them was captured from — and passes
 *    unmodified against — the ORIGINAL hand-built code that predates this
 *    module (background.js's inline `yq`+join, bin/drop.ts's field array,
 *    DropZone.svelte's local fm(), omnibox.ts's inline fm array); adopting
 *    lib/wire.ts in each of those files must not move a single byte, or a
 *    landing that used to dedupe against a resend stops deduping (the
 *    payload bytes ARE the dedup identity — lib/intake.ts). Do NOT "fix"
 *    a golden string here to match a refactor — if a caller's real output
 *    changes, the caller regressed, not the test.
 *
 * The vendored plain-JS twin (clients/browser-extension/wire.js) is pinned
 * against lib/wire.ts's own output too, the same way test/slug.test.ts
 * pins slug.js against lib/slug.ts.
 *
 * background.js's post()/enqueue() are NOT re-driven here: only one test
 * file may `import` background.js per process (its listeners bind at
 * import time, and bun test shares one process across files — a second
 * importer's stub never gets bound). test/extensionPdfClip.test.ts already
 * owns that import; its "byte-exact" tests cover the wire.ts adoption.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENGINE_ROOT } from "../lib/engine";
import { readSourceInsertionLog } from "../lib/insertionLog";
import {
  dropJsonBody,
  enqueueBody,
  fmBody,
  fmRaw,
  fmSerialize,
  type FmPair,
} from "../lib/wire";
import { composeCapture } from "../web/ui/src/lib/omnibox";

// ══════════════════════════════════════════════════════════════════════
// fmSerialize / fmBody — unit behavior
// ══════════════════════════════════════════════════════════════════════
describe("fmSerialize", () => {
  test("order-as-given, one k: v line per pair, --- fences, trailing blank line", () => {
    expect(fmSerialize([["a", "1"], ["b", "2"]])).toBe('---\na: "1"\nb: "2"\n---\n');
  });

  test("the yq idiom: every scalar is JSON.stringify(String(v))-quoted", () => {
    expect(fmSerialize([["n", 3]])).toBe('---\nn: "3"\n---\n');
    expect(fmSerialize([["b", true]])).toBe('---\nb: "true"\n---\n');
    expect(fmSerialize([["nil", null]])).toBe('---\nnil: ""\n---\n');
    expect(fmSerialize([["u", undefined]])).toBe('---\nu: ""\n---\n');
    expect(fmSerialize([["s", 'has "quotes"']]))
      .toBe('---\ns: "has \\"quotes\\""\n---\n');
  });

  test("skipEmpty (off by default) drops only \"\" and nullish, not other falsy values", () => {
    const pairs: FmPair[] = [
      ["a", ""],
      ["b", null],
      ["c", undefined],
      ["d", 0],
      ["e", false],
      ["f", "kept"],
    ];
    expect(fmSerialize(pairs)).toContain('a: ""'); // unpruned by default
    const pruned = fmSerialize(pairs, { skipEmpty: true });
    expect(pruned).not.toContain("a:");
    expect(pruned).not.toContain("b:");
    expect(pruned).not.toContain("c:");
    expect(pruned).toContain('d: "0"'); // 0 survives — only "" and nullish are pruned
    expect(pruned).toContain('e: "false"');
    expect(pruned).toContain('f: "kept"');
  });

  test("fmRaw emits a value verbatim, unquoted", () => {
    expect(fmSerialize([["kind", fmRaw("pdf")], ["title", "My Title"]])).toBe(
      '---\nkind: pdf\ntitle: "My Title"\n---\n'
    );
  });

  test("empty pairs still fence correctly", () => {
    expect(fmSerialize([])).toBe("---\n---\n");
  });
});

describe("fmBody", () => {
  test("fm + blank line + body + trailing newline", () => {
    const fm = fmSerialize([["k", "v"]]);
    expect(fmBody(fm, "hello")).toBe('---\nk: "v"\n---\n\nhello\n');
  });
});

describe("dropJsonBody / enqueueBody", () => {
  test("dropJsonBody matches the JSON shape dropHandler parses", () => {
    expect(dropJsonBody("---\n---\n", [{ name: "a.png", b64: "AA==" }])).toBe(
      JSON.stringify({ content: "---\n---\n", attachments: [{ name: "a.png", b64: "AA==" }] })
    );
  });
  test("enqueueBody is a plain JSON.stringify of the draft", () => {
    expect(enqueueBody({ refs: ["r1"], guidance: "read this" })).toBe(
      JSON.stringify({ refs: ["r1"], guidance: "read this" })
    );
  });
});

// ══════════════════════════════════════════════════════════════════════
// GOLDEN — DropZone.svelte's fm(). Captured verbatim from the file before
// it adopts lib/wire.ts:
//   const yq = (s) => JSON.stringify(String(s ?? ""));
//   function fm(pairs) {
//     return ["---", ...pairs.filter(([, v]) => v !== "" && v != null)
//       .map(([k, v]) => `${k}: ${yq(v)}`), "---", ""].join("\n");
//   }
// This must equal fmSerialize(pairs, { skipEmpty: true }) for every input
// DropZone actually sends — proving the extracted helper is a byte-exact
// drop-in, not merely a similar-looking one.
// ══════════════════════════════════════════════════════════════════════
function legacyDropZoneFm(pairs: [string, unknown][]): string {
  const yq = (s: unknown) => JSON.stringify(String(s ?? ""));
  return [
    "---",
    ...pairs.filter(([, v]) => v !== "" && v != null).map(([k, v]) => `${k}: ${yq(v)}`),
    "---",
    "",
  ].join("\n");
}

describe("GOLDEN — DropZone.svelte fm() reproduced by fmSerialize(pairs, { skipEmpty: true })", () => {
  const cases: [string, [string, unknown][]][] = [
    [
      "pdf import shape",
      [
        ["source", "web-drop"],
        ["kind", "pdf-import"],
        ["from", "web-drop"],
        ["from_kind", "agent"],
        ["title", "A Paper"],
        ["filename", "a-paper.pdf"],
        ["pages", 12],
        ["author", "Jane Doe"],
        ["date", "2026-08-12"],
      ],
    ],
    [
      "pdf import with empty/undefined author (falls through extraction blank)",
      [
        ["source", "web-drop"],
        ["kind", "pdf-import"],
        ["from", "web-drop"],
        ["from_kind", "agent"],
        ["title", "A Paper"],
        ["filename", "a-paper.pdf"],
        ["pages", undefined],
        ["author", ""],
        ["date", "2026-08-12"],
      ],
    ],
    [
      "text import shape",
      [
        ["source", "web-drop"],
        ["kind", "text-import"],
        ["from", "web-drop"],
        ["from_kind", "agent"],
        ["title", "notes"],
        ["filename", "notes.txt"],
        ["date", "2026-08-12"],
      ],
    ],
    [
      "file import shape",
      [
        ["source", "web-drop"],
        ["kind", "file-import"],
        ["from", "web-drop"],
        ["from_kind", "agent"],
        ["title", "diagram"],
        ["filename", "diagram.png"],
        ["date", "2026-08-12"],
      ],
    ],
  ];

  for (const [label, pairs] of cases) {
    test(label, () => {
      expect(fmSerialize(pairs as FmPair[], { skipEmpty: true })).toBe(legacyDropZoneFm(pairs));
    });
  }
});

// ══════════════════════════════════════════════════════════════════════
// GOLDEN — web/ui/src/lib/omnibox.ts composeCapture(). Exact byte
// equality against the literal shape the file builds by hand today
// (fixed `now` — composeCapture already takes one for determinism).
// ══════════════════════════════════════════════════════════════════════
describe("GOLDEN — omnibox.ts composeCapture()", () => {
  test("byte-exact frontmatter + body for a fixed input", () => {
    const now = new Date("2026-08-02T00:00:00Z");
    const { content, filename } = composeCapture("Call the plumber about the leak\nurgent", {
      now,
    });
    expect(filename).toBe("call-the-plumber-about-the-leak.md");
    expect(content).toBe(
      '---\nkind: "capture"\ntitle: "Call the plumber about the leak"\ndate: "2026-08-02"\n---\n\nCall the plumber about the leak\nurgent\n'
    );
  });
});

// ══════════════════════════════════════════════════════════════════════
// GOLDEN — bin/drop.ts's binary-attachment envelope, as the record keeps
// it. The composed frontmatter's exact BYTES are pinned by the fmSerialize
// unit tests above (quoting included); what a drop lands is the parsed
// envelope, so this asserts the fields end to end. `date` is the one field
// that cannot be pinned exactly (bin/drop.ts stamps `new Date()` with no
// injectable clock) and is format-checked instead.
// ══════════════════════════════════════════════════════════════════════
describe("GOLDEN — bin/drop.ts attachment envelope", () => {
  function hostVault(): string {
    const root = mkdtempSync(join(tmpdir(), "bb-wire-drop-"));
    mkdirSync(join(root, ".state"), { recursive: true });
    mkdirSync(join(root, "inbox"), { recursive: true });
    writeFileSync(join(root, "vault.yaml"), "integrations: {}\n");
    return root;
  }

  test("source/kind/title land verbatim; date is ISO-8601-shaped", () => {
    const root = hostVault();
    const src = join(root, "paper.pdf");
    const PDF_BYTES = Buffer.concat([
      Buffer.from("%PDF-1.4\n"),
      Buffer.from([0, 1, 2, 3]),
      Buffer.from("\n%%EOF\n"),
    ]);
    writeFileSync(src, PDF_BYTES);

    const r = spawnSync("bun", [join(ENGINE_ROOT, "bin", "drop.ts"), src], {
      encoding: "utf8",
      env: { ...process.env, BIGBRAIN_VAULT: root },
    });
    expect(r.status).toBe(0);

    const [landed] = readSourceInsertionLog(root);
    expect(landed).toBeDefined();
    expect(landed!.envelope["source"]).toBe("cli");
    expect(landed!.envelope["kind"]).toBe("pdf");
    expect(landed!.title).toBe("paper");
    expect(String(landed!.envelope["date"])).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
    );
    expect(landed!.body).toContain(`Dropped file: paper.pdf (${PDF_BYTES.byteLength} bytes)`);
  });
});

// ══════════════════════════════════════════════════════════════════════
// Vendored twin parity — clients/browser-extension/wire.js vs lib/wire.ts.
// Same guard test/slug.test.ts runs for slug.js: if one copy drifts from
// the other, this fails loudly instead of the extension silently sending
// different bytes than the engine does.
// ══════════════════════════════════════════════════════════════════════
describe("clients/browser-extension/wire.js — the vendored copy", () => {
  let W: {
    fmSerialize: (pairs: unknown[], opts?: { skipEmpty?: boolean }) => string;
    fmBody: (fm: string, body: string) => string;
    fmRaw: (v: string) => unknown;
    dropJsonBody: (content: string, attachments: unknown[]) => string;
    enqueueBody: (draft: unknown) => string;
  };
  beforeAll(async () => {
    await import("../clients/browser-extension/wire.js");
    W = (globalThis as Record<string, unknown>)["BigBrainWire"] as typeof W;
  });

  test("fmSerialize matches lib/wire.ts's output, quoted and raw", () => {
    // Two separate raw-wrapper instances (each module's own class) around
    // the same field list — instanceof can't cross the module boundary,
    // so the parity check is same-input/same-output, not same-object.
    const base: [string, unknown][] = [
      ["from", "send-to-bigbrain"],
      ["kind", "web-clip"],
      ["n", 3],
      ["b", true],
      ["nil", null],
    ];
    const libPairs = base.map(([k, v]) => [k, k === "kind" ? fmRaw(v as string) : v]) as FmPair[];
    const jsPairs = base.map(([k, v]) => [k, k === "kind" ? W.fmRaw(v as string) : v]);
    expect(W.fmSerialize(jsPairs)).toBe(fmSerialize(libPairs));
  });

  test("fmSerialize skipEmpty matches", () => {
    const pairs: FmPair[] = [
      ["a", ""],
      ["b", null],
      ["c", "kept"],
      ["d", 0],
    ];
    expect(W.fmSerialize(pairs as unknown[], { skipEmpty: true })).toBe(
      fmSerialize(pairs, { skipEmpty: true })
    );
  });

  test("fmBody matches", () => {
    const fm = fmSerialize([["k", "v"]]);
    expect(W.fmBody(fm, "hello")).toBe(fmBody(fm, "hello"));
  });

  test("dropJsonBody matches", () => {
    const atts = [{ name: "a.png", b64: "AA==" }];
    expect(W.dropJsonBody("---\n---\n", atts)).toBe(dropJsonBody("---\n---\n", atts));
  });

  test("enqueueBody matches", () => {
    const draft = { refs: ["r1"], guidance: "look at this" };
    expect(W.enqueueBody(draft)).toBe(enqueueBody(draft));
  });
});
