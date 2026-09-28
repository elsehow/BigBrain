// Issue #34: drop-zone imports must not land as the user's own voice. The
// interesting assertions round-trip through the REAL stampIntake — the
// contract is what the server honors, not what the client writes.
import { describe, expect, test } from "bun:test";
import { stampIntake } from "../lib/intake";
import { AGENT_VOICE, claimAgentVoice } from "../web/ui/src/lib/dropVoice";

// The edge credential as /api/drop passes it: a verified person.
const EDGE = {
  tokenId: "nick@example.com",
  tokenName: "web-edge",
  source: "web",
  from: "nick@example.com",
  fromKind: "person" as const,
};

const fmOf = (stamped: string): string => /^---\n([\s\S]*?)\n---\n/.exec(stamped)![1]!;

describe("claimAgentVoice", () => {
  test("bare text gains a minimal frontmatter block carrying the claim", () => {
    const out = claimAgentVoice("Just some prose.\n");
    expect(out.startsWith('---\nfrom: "web-drop"\nfrom_kind: "agent"\n---\n')).toBe(true);
    expect(out).toContain("Just some prose.");
  });

  test("existing frontmatter keeps its keys and gains the claim", () => {
    const out = claimAgentVoice("---\ntitle: Essay\ndate: 2013-10-24\n---\n\nBody.\n");
    const fm = fmOf(out);
    expect(fm).toContain("title: Essay");
    expect(fm).toContain('from: "web-drop"');
    expect(fm).toContain('from_kind: "agent"');
    expect(out).toContain("\nBody.\n");
  });

  test("a forged person claim is dropped, not left beside ours", () => {
    const out = claimAgentVoice(
      "---\nfrom: nick@example.com\nfrom_kind: person\ntitle: T\n---\nBody.\n"
    );
    const fm = fmOf(out);
    expect(fm).not.toContain("person");
    expect(fm.match(/^from:/gm)).toHaveLength(1);
    expect(fm.match(/^from_kind:/gm)).toHaveLength(1);
  });

  test("a complete existing agent claim is preserved untouched", () => {
    const text = "---\nfrom: send-to-bigbrain\nfrom_kind: agent\ntitle: Clip\n---\nBody.\n";
    expect(claimAgentVoice(text)).toBe(text);
  });
});

describe("through stampIntake (the server's honoring of the claim)", () => {
  test("a claimed import lands agent-voiced despite the person credential", () => {
    const stamped = stampIntake(
      claimAgentVoice("---\ntitle: Dropped doc\n---\nSomeone else's words.\n"),
      EDGE
    );
    const fm = fmOf(stamped);
    expect(fm).toContain("from: web-drop");
    expect(fm).toContain("from_kind: agent");
    // delivery is still recorded — the claim rewrites voice, never provenance
    expect(fm).toContain("submitted_by: nick@example.com");
  });

  test("a composed import head (the fm()-pairs path) lands agent-voiced too", () => {
    const head = [
      "---",
      'kind: "pdf-import"',
      ...AGENT_VOICE.map(([k, v]) => `${k}: ${JSON.stringify(v)}`),
      'title: "Doc"',
      "---",
      "",
      "Extracted text.",
      "",
    ].join("\n");
    const fm = fmOf(stampIntake(head, EDGE));
    expect(fm).toContain("from: web-drop");
    expect(fm).toContain("from_kind: agent");
  });

  test("an unclaimed item (the typed capture) still inherits the person stamp", () => {
    const fm = fmOf(stampIntake("---\ntitle: A thought\n---\nMy own words.\n", EDGE));
    expect(fm).toContain("from: nick@example.com");
    expect(fm).toContain("from_kind: person");
  });
});
