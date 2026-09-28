// #683: the reference-era entities/ dossiers, read as data by the two doors
// that fold one into the record (seed-aliases, whoami --adopt-dossier). The
// walk is path-sorted, subdirectory-aware, and tolerant: a malformed
// envelope reads as empty, a missing tree as no dossiers.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { entityEnvelopes, legacyDossiers, legacyUserDossiers } from "../lib/entityDossiers";

function scratchVault(): string {
  const root = mkdtempSync(join(tmpdir(), "bb-dossiers-"));
  mkdirSync(join(root, "entities", "sub"), { recursive: true });
  writeFileSync(
    join(root, "entities", "alex-rowan.md"),
    "---\ntype: entity\nentity_type: person\nhuman_user: true\naliases:\n  - Alex Rowan\n  - Alex\n  - alpha@example.com\n  - agent-chat-0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b-1-1890\n---\n\nDossier body.\n"
  );
  writeFileSync(
    join(root, "entities", "ada-lovelace.md"),
    "---\ntype: entity\ntitle: Ada   Lovelace\naliases:\n  - Ada\n---\n\nNot the user.\n"
  );
  writeFileSync(join(root, "entities", "impostor.md"), "---\ntitle: Impostor\nhuman_user: false\n---\n\nFlag present, false.\n");
  writeFileSync(join(root, "entities", "broken.md"), "---\ntitle: [unclosed\nhuman_user: true\n---\n\nMalformed YAML.\n");
  writeFileSync(join(root, "entities", "sub", "second-user.md"), "---\ntitle: Second User\nhuman_user: true\n---\n\nPlural-safe.\n");
  writeFileSync(join(root, "entities", "notes.txt"), "not a dossier\n");
  return root;
}

describe("entityEnvelopes", () => {
  test("every entities/*.md, path-sorted, subdirectories included, nothing else", () => {
    expect(entityEnvelopes(scratchVault()).map((e) => e.path)).toEqual([
      "entities/ada-lovelace.md",
      "entities/alex-rowan.md",
      "entities/broken.md",
      "entities/impostor.md",
      "entities/sub/second-user.md",
    ]);
  });

  test("no entities tree, no dossiers", () => {
    expect(entityEnvelopes(mkdtempSync(join(tmpdir(), "bb-empty-")))).toEqual([]);
  });
});

describe("legacyDossiers", () => {
  test("title from the frontmatter, else the alias spelling the filename, else the slug; source-id aliases dropped", () => {
    const byPath = new Map(legacyDossiers(scratchVault()).map((d) => [d.path, d]));
    expect(byPath.get("entities/alex-rowan.md")).toEqual({
      path: "entities/alex-rowan.md",
      title: "Alex Rowan",
      aliases: ["Alex Rowan", "Alex", "alpha@example.com"],
      person: true,
      humanUser: true,
    });
    expect(byPath.get("entities/ada-lovelace.md")).toMatchObject({ title: "Ada Lovelace", aliases: ["Ada"], person: false, humanUser: false });
    expect(byPath.get("entities/impostor.md")).toMatchObject({ title: "Impostor", humanUser: false });
    // a malformed envelope reads as no envelope: the slug is the title
    expect(byPath.get("entities/broken.md")).toMatchObject({ title: "broken", aliases: [], humanUser: false });
  });

  test("legacyUserDossiers is the flagged subset, path-sorted", () => {
    expect(legacyUserDossiers(scratchVault()).map((d) => d.path)).toEqual([
      "entities/alex-rowan.md",
      "entities/sub/second-user.md",
    ]);
  });
});
