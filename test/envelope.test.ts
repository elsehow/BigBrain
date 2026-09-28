import { describe, expect, test } from "bun:test";
import {
  ENTITY_TYPES,
  envelopeOrSniff,
  isEntity,
  parseEnvelope,
  normalizeType,
  resolveType,
  serializeEnvelope,
  sniffDeepPass,
  sniffRequest,
  type Envelope,
} from "../lib/envelope";

// The two pre-envelope ad-hoc regexes (the retired editor's and the
// server's) — now exported verbatim as sniffRequest/sniffDeepPass, the
// shared tolerant path.
const KIND_REQUEST_RE = /^kind:\s*request\s*$/m;
const PASS_DEEP_RE = /^pass:\s*deep\s*$/m;

describe("round-trip fidelity", () => {
  test("known + unknown keys survive, in order", () => {
    const raw = [
      "---",
      "id: abc",
      "custom_field: xyz",
      "kind: request",
      "nested_alias: q",
      "---",
      "",
      "body text\n",
    ].join("\n");
    const { envelope, body } = parseEnvelope(raw);
    expect(envelope).toEqual({
      id: "abc",
      custom_field: "xyz",
      kind: "request",
      nested_alias: "q",
    });
    expect(body).toBe("body text\n");
    expect(Object.keys(envelope)).toEqual(["id", "custom_field", "kind", "nested_alias"]);

    const out = serializeEnvelope(envelope, body);
    const reparsed = parseEnvelope(out);
    expect(reparsed.envelope).toEqual(envelope);
    expect(reparsed.body).toBe(body);
  });

  test("empty envelope round-trips to no frontmatter block at all", () => {
    const out = serializeEnvelope({}, "just a body\n");
    expect(out).toBe("just a body\n");
    expect(parseEnvelope(out)).toEqual({ envelope: {}, body: "just a body\n" });
  });

  test("undefined-valued known fields are dropped, not emitted as nulls", () => {
    const env: Envelope = { id: "x", title: undefined };
    const out = serializeEnvelope(env, "b\n");
    expect(out).not.toContain("title");
    expect(parseEnvelope(out).envelope).toEqual({ id: "x" });
  });
});

describe("tolerance", () => {
  test("no frontmatter at all → empty envelope, full body unchanged", () => {
    expect(parseEnvelope("just prose\nno frontmatter here\n")).toEqual({
      envelope: {},
      body: "just prose\nno frontmatter here\n",
    });
  });

  test("empty string → empty envelope, empty body", () => {
    expect(parseEnvelope("")).toEqual({ envelope: {}, body: "" });
  });

  test("unterminated frontmatter (no closing ---) → treated as no frontmatter", () => {
    const raw = "---\nid: abc\n\nno closing marker\n";
    expect(parseEnvelope(raw)).toEqual({ envelope: {}, body: raw });
  });

  test("malformed YAML inside a well-formed block never throws", () => {
    const raw = "---\nkind: [unclosed\n---\n\nbody\n";
    expect(() => parseEnvelope(raw)).not.toThrow();
    expect(parseEnvelope(raw)).toEqual({ envelope: {}, body: raw }); // whole text preserved, nothing lost
  });

  test("a frontmatter block that parses to a scalar (not a mapping) is treated as malformed", () => {
    const raw = "---\njust a plain string, no colon\n---\n\nbody\n";
    expect(parseEnvelope(raw)).toEqual({ envelope: {}, body: raw });
  });

  test("empty frontmatter block → valid empty envelope, body correctly sliced", () => {
    // "---\n---\n" (fences with nothing between, not even a blank line) has no
    // closing fence of its own by this convention (there's no line between the
    // markers) — matches the old splitNote regex too, which also fails to
    // match it. A blank line between the fences is the well-formed empty case.
    const raw = "---\n\n---\n\nbody\n";
    expect(parseEnvelope(raw)).toEqual({ envelope: {}, body: "body\n" });
  });
});

describe("block scalars and sequences", () => {
  test("aliases sequence round-trips as a string array", () => {
    const raw = ["---", "id: x", "aliases:", "  - foo", "  - bar baz", "---", "", "b\n"].join("\n");
    const { envelope, body } = parseEnvelope(raw);
    expect(envelope.aliases).toEqual(["foo", "bar baz"]);
    expect(parseEnvelope(serializeEnvelope(envelope, body)).envelope).toEqual(envelope);
  });

  test("block-scalar value round-trips with embedded newlines", () => {
    const raw = ["---", "id: x", "note: |", "  line one", "  line two", "---", "", "b\n"].join(
      "\n"
    );
    const { envelope, body } = parseEnvelope(raw);
    expect(envelope.note).toBe("line one\nline two\n");
    expect(parseEnvelope(serializeEnvelope(envelope, body)).envelope).toEqual(envelope);
  });
});

// The parity describes that stood here compared the typed successors — the
// typed successors to KIND_REQUEST_RE / PASS_DEEP_RE — against the regexes,
// case by case, and documented two divergences. No site ever moved onto the
// predicates: every live one runs the sniffs, which the "sniffs" describe
// below pins against the same regexes. Both predicates went on 2026-08-30.

describe("entities (phase 3 — recognition only, no extraction pipeline)", () => {
  test("isEntity recognizes kind: entity, and only that", () => {
    expect(isEntity(parseEnvelope("---\nkind: entity\n---\n\nbody\n").envelope)).toBe(true);
    expect(isEntity(parseEnvelope("---\nkind: note\n---\n\nbody\n").envelope)).toBe(false);
    expect(isEntity({})).toBe(false);
  });

  test("ENTITY_TYPES is the SSOT — person | org | project | place (ruled 2026-08-05); changing it is a vocabulary decision, not a refactor", () => {
    expect([...ENTITY_TYPES]).toEqual(["person", "org", "project", "place"]);
  });

  test("entity_type round-trips for every known type", () => {
    for (const et of ENTITY_TYPES) {
      const raw = `---\nkind: entity\nentity_type: ${et}\naliases:\n  - x\n---\n\nbody\n`;
      const { envelope, body } = parseEnvelope(raw);
      expect(envelope.entity_type).toBe(et);
      expect(isEntity(envelope)).toBe(true);
      // and it round-trips back out unchanged, same as any other field
      expect(parseEnvelope(serializeEnvelope(envelope, body)).envelope.entity_type).toBe(et);
    }
  });

  test("an unrecognized entity_type value passes through untouched — tolerant, never rejected, surfaces render it as-is", () => {
    const raw = "---\nkind: entity\nentity_type: organization\n---\n\nbody\n";
    const { envelope } = parseEnvelope(raw);
    expect(envelope.entity_type).toBe("organization");
    expect(isEntity(envelope)).toBe(true);
  });

  test("kind: entity with no entity_type at all is still a recognized entity", () => {
    const { envelope } = parseEnvelope("---\nkind: entity\ntitle: Some Thread\n---\n\nbody\n");
    expect(isEntity(envelope)).toBe(true);
    expect(envelope.entity_type).toBeUndefined();
  });
});

describe("sniffs — the shared tolerant path the live sites run on", () => {
  test("sniffRequest/sniffDeepPass ARE the old regexes", () => {
    for (const fm of [
      "kind: request",
      "kind:request",
      "kind: 'request'",
      "kind: note",
      "title: x\nkind: request",
      "",
    ])
      expect(sniffRequest(fm)).toBe(KIND_REQUEST_RE.test(fm));
    for (const fm of [
      "pass: deep",
      "pass:deep",
      "pass: 'deep'",
      "pass: shallow",
      "kind: request\npass: deep",
      "",
    ])
      expect(sniffDeepPass(fm)).toBe(PASS_DEEP_RE.test(fm));
  });

  test("a well-formed pass line survives malformed YAML elsewhere in the block — where the whole-block parse sees nothing (why the queue split stays a sniff)", () => {
    const fm = "title: [unclosed\npass: deep";
    expect(sniffDeepPass(fm)).toBe(true);
    // the whole-block parse gives up on the malformed line and sees no keys
    expect(parseEnvelope(`---\n${fm}\n---\n\nbody\n`).envelope).toEqual({});
  });

  test("envelopeOrSniff: well-formed blocks take the parsed path (typed values, quotes handled)", () => {
    const raw = "---\nsource: 'granola'\ndate: 2026-07-01\n---\n\nbody\n";
    expect(envelopeOrSniff(raw, ["source", "date"])).toEqual({
      source: "granola",
      date: "2026-07-01",
    });
  });

  test("envelopeOrSniff: a malformed line elsewhere falls back to line-wise sniffing of just the asked-for keys", () => {
    const raw = "---\ntitle: [unclosed\nsource: granola\ndate: 2026-07-01\n---\n\nbody\n";
    expect(parseEnvelope(raw).envelope).toEqual({}); // the whole-block parse is blind
    expect(envelopeOrSniff(raw, ["source", "date"])).toEqual({
      source: "granola",
      date: "2026-07-01",
    });
  });

  test("envelopeOrSniff: no frontmatter at all → empty envelope, no sniff hits", () => {
    expect(envelopeOrSniff("just prose\nsource: fake\n", ["source"])).toEqual({});
  });
});

describe("substrate types (note retired 2026-08-05: reference | entity; memory is tree-typed)", () => {
  test("a declared strong type is kept as-is", () => {
    expect(normalizeType({ type: "reference" })).toEqual({
      type: "reference",
      tags: [],
      category: "drop",
    });
    expect(normalizeType({ type: "entity" })).toEqual({
      type: "entity",
      tags: [],
      category: "drop",
    });
  });

  test("a flavor word maps to its strong type and survives as a tag (and as the category)", () => {
    expect(normalizeType({ type: "transcript" })).toEqual({
      type: "reference",
      tags: ["transcript"],
      category: "transcript",
    });
    expect(normalizeType({ type: "paper" })).toEqual({
      type: "reference",
      tags: ["paper"],
      category: "paper",
    });
    expect(normalizeType({ kind: "meeting" })).toEqual({
      type: "reference",
      tags: ["meeting"],
      category: "meeting",
    });
    expect(normalizeType({ kind: "email" })).toEqual({
      type: "reference",
      tags: ["email"],
      category: "email",
    });
  });

  test("the retired note type and its old flavors re-normalize to reference, word kept as tag", () => {
    expect(normalizeType({ type: "note" })).toEqual({
      type: "reference",
      tags: ["note"],
      category: "note",
    });
    expect(normalizeType({ kind: "note" })).toEqual({
      type: "reference",
      tags: ["note"],
      category: "note",
    });
    expect(normalizeType({ type: "dream" })).toEqual({
      type: "reference",
      tags: ["dream"],
      category: "dream",
    });
    expect(normalizeType({ kind: "idea" })).toEqual({
      type: "reference",
      tags: ["idea"],
      category: "idea",
    });
    expect(normalizeType({ kind: "meeting-dossier" })).toEqual({
      type: "reference",
      tags: ["meeting-dossier"],
      category: "meeting-dossier",
    });
  });

  test("an unknown word never becomes a type: strong default reference, word kept as tag", () => {
    expect(normalizeType({ type: "voicemail" })).toEqual({
      type: "reference",
      tags: ["voicemail"],
      category: "voicemail",
    });
    // `request` normalizes like any word, but intake ROUTES requests to the
    // queue before typing — one never reaches a landing (intake.test.ts)
    expect(normalizeType({ kind: "request" })).toEqual({
      type: "reference",
      tags: ["request"],
      category: "request",
    });
  });

  test("nothing declared → reference (every content arrival is record); declared tags carry through, deduped", () => {
    expect(normalizeType({})).toEqual({ type: "reference", tags: [], category: "drop" });
    expect(normalizeType({ type: "   " })).toEqual({
      type: "reference",
      tags: [],
      category: "drop",
    });
    expect(normalizeType({ type: "reference", tags: ["transcript", "meeting"] })).toEqual({
      type: "reference",
      tags: ["transcript", "meeting"],
      category: "transcript",
    });
    expect(normalizeType({ type: "transcript", tags: ["transcript"] })).toEqual({
      type: "reference",
      tags: ["transcript"],
      category: "transcript",
    });
  });

  test("the ONE category resolves declared → flavor word → first tag → source → drop", () => {
    // a declared category wins outright — the editor's reassignment must
    // survive every later re-normalization of the landed file
    expect(normalizeType({ category: "lab-result", kind: "pdf-import" }).category).toBe(
      "lab-result"
    );
    expect(normalizeType({ kind: "transcript", tags: ["meeting"] }).category).toBe("transcript");
    expect(normalizeType({ tags: ["paper", "ai"] }).category).toBe("paper");
    expect(normalizeType({ source: "granola" }).category).toBe("granola");
    // a landed file (strong type stamped, kind preserved) re-resolves to
    // the same word it landed with — kind is read before type
    expect(normalizeType({ type: "reference", kind: "transcript" }).category).toBe("transcript");
  });

  test("declared type beats a conflicting legacy kind; resolveType is the type alone", () => {
    expect(normalizeType({ type: "reference", kind: "meeting" }).type).toBe("reference");
    expect(resolveType({ type: "transcript" })).toBe("reference");
    expect(resolveType({})).toBe("reference");
  });
});

// ── yscalar: strings that YAML would read back as another type ─────────────
import { yscalar } from "../lib/fsx";
import { parse as yamlParse } from "yaml";

describe("yscalar quotes anything YAML would read back as a non-string", () => {
  test("an all-digit id survives a YAML round trip as a STRING", () => {
    // found live: a hex token id that happened to be all digits was emitted
    // bare, read back as a number, and failed strict comparison (#498).
    for (const v of ["54275549", "007", "1e5", "123.45", "true", "no", "null"]) {
      const back = yamlParse(`k: ${yscalar(v)}`) as { k: unknown };
      expect(back.k).toBe(v);
    }
    // boring strings stay unquoted
    expect(yscalar("granola")).toBe("granola");
    expect(yscalar("nick@example.com")).toBe("nick@example.com");
  });
});
