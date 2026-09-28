import { describe, expect, test } from "bun:test";
import {
  directivesFor,
  directiveStatus,
  directiveVoice,
  guidanceIsLong,
  GUIDANCE_CLAMP_CHARS,
  ingestEtaLabel,
  messageKind,
} from "../web/ui/src/lib/queueView";
import { msg } from "../web/ui/src/dev/fixtures";

describe("messageKind", () => {
  test("facts → repair, guidance → directive, bare refs → arrival", () => {
    expect(messageKind({ facts: { broken: ["y.md"] } })).toBe("repair");
    expect(messageKind({ guidance: "merge these" })).toBe("directive");
    expect(messageKind({})).toBe("arrival");
  });
  test("facts win over guidance — a repair is a repair even if prose leaked in", () => {
    expect(messageKind({ facts: { broken: [] }, guidance: "g" })).toBe("repair");
  });
  test("legacy rows keep showing their verb; legacy file reads as an arrival", () => {
    expect(messageKind({ verb: "synthesize" })).toBe("synthesize");
    expect(messageKind({ verb: "file" })).toBe("arrival");
  });
});

describe("ingestEtaLabel — the recent feed's spinner tooltip: the WORK, and when", () => {
  test("a row a live run has claimed is happening now, whatever the gate says", () => {
    expect(ingestEtaLabel(300_000, true)).toBe("building links now");
    expect(ingestEtaLabel(null, true)).toBe("building links now");
  });
  test("an open gate reads now — the next tick starts the run", () => {
    expect(ingestEtaLabel(0)).toBe("building links now");
    expect(ingestEtaLabel(-5000)).toBe("building links now");
  });
  test("a future gate names its own number, on the shared clock format", () => {
    expect(ingestEtaLabel(300_000)).toBe("building links in 5m");
    expect(ingestEtaLabel(61_000)).toBe("building links in 2m");
    expect(ingestEtaLabel(171 * 60_000)).toBe("building links in 2h 51m");
  });
  test("an unknown eta (no local stamp — the host owns the pass) also reads now", () => {
    expect(ingestEtaLabel(null)).toBe("building links now");
  });
  test("an INEXACT open gate names the tick bound instead of claiming to be underway", () => {
    // The regression this exists for: with a 300s tick and no supervisor
    // clock, "now" was the label from the moment of arrival — so the
    // spinner said the gardener had the item for the whole wait before it
    // did. `tickMs` present = the eta is a floor, so hedge to the bound.
    expect(ingestEtaLabel(0, false, 300_000)).toBe("building links within ~5m");
    expect(ingestEtaLabel(-5000, false, 300_000)).toBe("building links within ~5m");
    expect(ingestEtaLabel(0, false, 90_000)).toBe("building links within ~2m");
  });
  test("a sub-minute tick is not worth a hedge, and an exact 0 is genuinely now", () => {
    expect(ingestEtaLabel(0, false, 60_000)).toBe("building links now");
    expect(ingestEtaLabel(0, false, null)).toBe("building links now");
  });
  test("a claimed row still beats the bound — the lock outranks the clock", () => {
    expect(ingestEtaLabel(0, true, 300_000)).toBe("building links now");
    expect(ingestEtaLabel(300_000, true, 300_000)).toBe("building links now");
  });
});

describe("directivesFor — a note shows what was ASKED about it", () => {
  test("directives only: an arrival and a repair naming the note are not things anyone said", () => {
    const rows = directivesFor([
      msg({ id: "a", refs: ["url-8f42"] }),
      msg({ id: "g", refs: ["url-8f42"], guidance: "compare spring and autumn" }),
      msg({ id: "r", refs: ["url-8f42"], facts: { broken: ["x.md"] } }),
    ]);
    expect(rows.map((r) => r.id)).toEqual(["g"]);
  });

  test("newest first, whatever order the route handed over", () => {
    const rows = directivesFor([
      msg({ id: "old", guidance: "first thought", enqueued: "2026-08-01T10:00:00Z" }),
      msg({ id: "new", guidance: "second thought", enqueued: "2026-08-06T10:00:00Z" }),
    ]);
    expect(rows.map((r) => r.id)).toEqual(["new", "old"]);
  });

  test("a repair with prose in guidance stays out — facts outrank guidance, as everywhere", () => {
    expect(directivesFor([msg({ id: "r", facts: { broken: [] }, guidance: "g" })])).toEqual([]);
  });
});

describe("directiveStatus — a directive's fate in the reader's terms", () => {
  test("pending and running both read as an open question", () => {
    expect(directiveStatus({ state: "pending" })).toBe("waiting");
    expect(directiveStatus({ state: "running" })).toBe("waiting");
  });
  test("terminal states carry the runner's verdict, never model prose", () => {
    expect(directiveStatus({ state: "done", outcome: "url-8f42 absorbed → entities/a.md" })).toBe(
      "absorbed"
    );
    expect(directiveStatus({ state: "done", outcome: "declined: junk" })).toBe("declined");
    expect(directiveStatus({ state: "failed", error: "429" })).toBe("failed");
  });
  test("done with no recorded outcome says nothing rather than guessing", () => {
    expect(directiveStatus({ state: "done" })).toBe("");
  });
});

describe("guidanceIsLong — a directive must not bury the note it sits under", () => {
  test("the common case is a phrase, and renders whole", () => {
    expect(guidanceIsLong("compare spring and autumn")).toBe(false);
    expect(guidanceIsLong(undefined)).toBe(false);
    expect(guidanceIsLong("   ")).toBe(false);
  });
  test("one unbroken paragraph is long without having lines", () => {
    expect(guidanceIsLong("x".repeat(GUIDANCE_CLAMP_CHARS))).toBe(false);
    expect(guidanceIsLong("x".repeat(GUIDANCE_CLAMP_CHARS + 1))).toBe(true);
  });
  test("a stack of short lines is tall without being long", () => {
    expect(guidanceIsLong("a\nb\nc\nd")).toBe(false);
    expect(guidanceIsLong("a\nb\nc\nd\ne")).toBe(true);
  });
  // the real shape this was written for
  test("a migration-era directive (750 chars, 12 lines) clamps", () => {
    expect(guidanceIsLong(`compare spring and autumn\n\n(Migration note${"y".repeat(700)})`)).toBe(true);
  });
});

describe("directiveVoice — credential-derived, never payload-claimed", () => {
  test("a verified person's words are their voice", () => {
    expect(
      directiveVoice({ from: "nick@example.com", via: "extension", from_kind: "person" })
    ).toEqual({
      who: "nick@example.com",
      person: true,
    });
  });
  // any agent can name itself mallory@evil.example — only from_kind decides
  test("an email-shaped `from` earns nothing without the person credential", () => {
    expect(
      directiveVoice({ from: "mallory@evil.example", via: "http", from_kind: "agent" }).person
    ).toBe(false);
    expect(directiveVoice({ from: "mallory@evil.example", via: "http" }).person).toBe(false);
  });
  test("a nameless principal still renders something", () => {
    expect(directiveVoice({ from: "", via: "http" }).who).toBe("unknown");
  });
});
