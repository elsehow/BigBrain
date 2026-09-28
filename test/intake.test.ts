import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readBlob } from "../lib/blobs";
import { IntakeError, MAX_BYTES, receive, stampIntake, stripFmKeys } from "../lib/intake";
import { intakeWireReceipt } from "../lib/intakeWire";
import { landedText } from "./support/landed";
import { mdVault } from "./support/vault";

const vault = (): string => mdVault({ prefix: "bb-vault-", dirs: ["inbox"] });

describe("receive — the immutable landing", () => {
  test("returns a complete, readable receipt", () => {
    const root = vault();
    const receipt = receive({ root, content: "hello" });
    expect(receipt.path).toMatch(/^log\/insertions\/[^/]+\/ins_[a-f0-9]{24}\.json$/);
    expect(receipt.insertionId).toMatch(/^ins_[a-f0-9]{24}$/);
    expect(receipt.deduped).toBe(false);
    expect(landedText(root, receipt)).toContain("hello");
    expect(receive({ root, content: "hello" })).toEqual({ ...receipt, deduped: true });
  });

  test("HTTP compatibility labels do not change the canonical receipt", () => {
    const receipt = receive({ root: vault(), content: "hello" });
    const wire = intakeWireReceipt(receipt, "../../a note.md");
    expect(wire).toEqual({ id: receipt.id, path: "inbox/a-note.md", ref_path: receipt.path });
    expect(receipt.path).toStartWith("log/insertions/");
    expect(intakeWireReceipt(receipt).path).toBe(`inbox/${receipt.insertionId}.md`);
  });

  test("empty refuses with code", () => {
    expect(() => receive({ root: vault(), content: "  \n" })).toThrow(IntakeError);
    try {
      receive({ root: vault(), content: "" });
    } catch (e) {
      expect((e as IntakeError).code).toBe("empty");
    }
  });

  test("oversize refuses with code", () => {
    try {
      receive({ root: vault(), content: "x".repeat(MAX_BYTES + 1) });
      expect.unreachable();
    } catch (e) {
      expect((e as IntakeError).code).toBe("too-large");
    }
  });
});

describe("stripFmKeys", () => {
  test("removes a simple key", () => {
    expect(stripFmKeys("title: hi\nsource: forged\nkind: note", ["source"])).toBe(
      "title: hi\nkind: note"
    );
  });

  test("removes indented continuation (block scalar)", () => {
    const fm = "source: |\n  evil line\n  source: attacker\ntitle: hi";
    expect(stripFmKeys(fm, ["source"])).toBe("title: hi");
  });

  test("removes column-0 sequence items under the key", () => {
    const fm = "source:\n- a\n- b\ntitle: hi";
    expect(stripFmKeys(fm, ["source"])).toBe("title: hi");
  });

  test("removes quoted-key variants", () => {
    const fm = `"source": forged\n'submitted_by': me\ntitle: hi`;
    expect(stripFmKeys(fm, ["source", "submitted_by"])).toBe("title: hi");
  });

  test("does not touch keys that merely share a prefix", () => {
    const fm = "source_url: https://x\ntitle: hi";
    expect(stripFmKeys(fm, ["source"])).toBe(fm);
  });
});

describe("receive — attachments", () => {
  test("binary lands in the CAS and the item links it as blob:<sha256>", () => {
    const root = vault();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const sha = createHash("sha256").update(png).digest("hex");
    const r = receive({
      root,
      content: "---\ntitle: pic\n---\n",
      attachments: [{ name: "photo.jpg", b64: png.toString("base64") }],
    });
    expect(landedText(root, r)).toContain(`![photo.jpg](blob:${sha})`);
    expect(readBlob(root, sha)).toEqual(png);
    expect(existsSync(join(root, "inbox", "attachments"))).toBe(false); // the old tree is gone
  });

  test("attachment names are sanitized against traversal", () => {
    const root = vault();
    const r = receive({
      root,
      content: "x",
      attachments: [{ name: "../../.ssh/keys", b64: Buffer.from("x").toString("base64") }],
    });
    const item = landedText(root, r);
    expect(item).not.toContain("../");
    expect(item).toContain("[__.._.ssh_keys](blob:");
  });

  test("attachments are UNCAPPED — a blob bigger than the text limit lands (2026-08-06)", () => {
    // the CAS is add-only disk, never git history — only item TEXT is capped
    const root = vault();
    const big = Buffer.alloc(MAX_BYTES + 1);
    const sha = createHash("sha256").update(big).digest("hex");
    const r = receive({
      root,
      content: "x",
      attachments: [{ name: "big.bin", b64: big.toString("base64") }],
    });
    expect(landedText(root, r)).toContain(`[big.bin](blob:${sha})`);
    expect(readBlob(root, sha)).toEqual(big);
  });
});


describe("stampIntake", () => {
  const opts = {
    tokenId: "a1b2c3d4",
    tokenName: "chrome extension",
    now: new Date("2026-07-13T10:00:00.000Z"),
  };

  test("bare body gains a frontmatter block with all stamps and an id", () => {
    const out = stampIntake("just a thought", opts);
    expect(out).toContain("source: api");
    expect(out).toContain("submitted_by: a1b2c3d4");
    expect(out).toContain("submitted_via: chrome extension");
    expect(out).toContain("received: 2026-07-13T10:00:00.000Z");
    expect(out).toMatch(/id: api-2026-07-13T10-00-00-[a-z0-9]{6}/);
    expect(out.endsWith("just a thought")).toBe(true);
  });

  test("forged reserved keys are overridden, not duplicated", () => {
    const out = stampIntake(
      "---\nsource: email\nsubmitted_by: root\nreceived: 1999\ntitle: hi\n---\nbody",
      opts
    );
    expect(out.match(/^source:/gm)).toHaveLength(1);
    expect(out).toContain("source: api");
    expect(out).not.toContain("source: email");
    expect(out).not.toContain("submitted_by: root");
    expect(out).toContain("title: hi");
    expect(out.trim().endsWith("body")).toBe(true);
  });

  test("block-scalar smuggling cannot orphan a forged key", () => {
    const out = stampIntake("---\nsource: |\n  x\n  source: attacker\ntitle: hi\n---\nbody", opts);
    expect(out).not.toContain("attacker");
    expect(out.match(/source:/g)).toHaveLength(1);
  });

  test("existing id is kept", () => {
    const out = stampIntake("---\nid: email-abc123\ntitle: hi\n---\nbody", opts);
    expect(out).toContain("id: email-abc123");
    expect(out.match(/^id:/gm)).toHaveLength(1);
  });

  test("non-reserved frontmatter and body pass through", () => {
    const out = stampIntake(
      "---\ntitle: hi\nurl: https://x.com\nkind: web-clip\n---\n# Heading\n\ntext\n",
      opts
    );
    expect(out).toContain("title: hi");
    expect(out).toContain("url: https://x.com");
    expect(out).toContain("kind: web-clip");
    expect(out).toContain("# Heading\n\ntext");
  });

  test("quoted agent claim is recognized (the claim regex matches quoted scalars too)", () => {
    const out = stampIntake("---\nfrom: 'claude-opus'\nfrom_kind: 'agent'\n---\nbody", {
      ...opts,
      fromKind: "person",
      from: "nick@example.com",
    });
    expect(out).toContain("from: claude-opus");
    expect(out).toContain("from_kind: agent");
  });

  test("no space after the colon is still recognized (line regex, not a YAML parse — a payload's claim must not hinge on YAML niceties)", () => {
    const out = stampIntake("---\nfrom:claude-opus\nfrom_kind:agent\n---\nbody", {
      ...opts,
      fromKind: "person",
      from: "nick@example.com",
    });
    expect(out).toContain("from: claude-opus");
    expect(out).toContain("from_kind: agent");
  });

  test("a well-formed claim survives malformed YAML elsewhere in the block (line-wise read: a whole-block parse would drop the claim and mis-stamp the person credential)", () => {
    const out = stampIntake(
      "---\ntitle: [unclosed\nfrom: claude-opus\nfrom_kind: agent\n---\nbody",
      { ...opts, fromKind: "person", from: "nick@example.com" }
    );
    expect(out).toContain("from: claude-opus");
    expect(out).toContain("from_kind: agent");
    expect(out).not.toContain("from: nick@example.com");
  });
});

// ══════════════════════════════════════════════════════════════════════
// Issue #50: a client can only say something ABOUT what it just shipped
// if the landing tells it the reference id.
// ══════════════════════════════════════════════════════════════════════
describe("receive — the landing receipt", () => {

  test("a fresh landing reports the reference id it landed under", () => {
    const root = vault();
    const r = receive({
      root,
      content: "---\nid: k-1\n---\nthe page\n",
    });
    expect(r.id).toBe("k-1");
    // and it is really the id of the item now in the record — the insertion
    // event (#496: no references/*.md is written)
    expect(r.path).toMatch(/^log\/insertions\//);
    const event = JSON.parse(readFileSync(join(root, r.path!), "utf8")) as {
      envelope: { id?: string };
    };
    expect(event.envelope.id).toBe("k-1");
  });

  test("a DEDUP hit reports the id already there — a re-clip points at the original", () => {
    // the whole reason the receipt is worth having: re-capturing an
    // unchanged page must attach a follow-up directive to the FIRST
    // landing, never orphan it against an id that was never minted
    const root = vault();
    const content = "---\nid: k-2\n---\nunchanged page\n";
    const first = receive({ root, content });
    const second = receive({ root, content });
    expect(second.id).toBe(first.id);
    expect(second.path).toBe(first.path); // the same insertion event
    // The month comes from the receipt, not a literal: this hardcoded
    // "2026-08" and broke at the UTC month rollover, since `receive` files
    // an event under the month it lands in.
    expect(readdirSync(join(root, dirname(first.path)))).toHaveLength(1);
  });

  test("a kind: request lands natively (#521) — an insertion, still no references/", () => {
    const root = vault();
    const r = receive({
      root,
      content: "---\nkind: request\n---\nmerge the two dossiers\n",
    });
    expect(r.id).toBeDefined();
    expect(r.path).toMatch(/^log\/insertions\//);
    expect(existsSync(join(root, "references"))).toBe(false);
    expect(existsSync(join(root, "queue"))).toBe(false); // and no file message
  });

});
