/**
 * userIdentity — the reader policy over an owner declaration.
 *
 * The readers — latestUserIdentity, userIdentityDeclarations, the graph's
 * self-suppression — run against a record built by test/support/identity.ts,
 * which fabricates the hosted shape. The WRITER's own tests are at the foot:
 * `declareUserIdentity` is the local door (#572), and what it appends has to
 * satisfy the same reader policy as the hosted one did.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAssertionGraph } from "../lib/assertionGraph";
import { assertionEntityId, createAssertionEvent, readAssertionLog } from "../lib/assertionLog";
import { appendAndProjectAssertion, projectSourceInsertion } from "../lib/assertionProjection";
import { appendSourceInsertionEvent, readSourceInsertionLog } from "../lib/insertionLog";
import {
  adoptLegacyUserDossier,
  declareUserIdentity,
  latestUserIdentity,
  legacyUserLabels,
  planLegacyUserAdoption,
  userIdentityDeclarations,
} from "../lib/userIdentity";
import { declareOwner } from "./support/identity";
import { insertion } from "./support/vault";

const owner = { account: "acct_alex", verified_email: "alex@example.com" };
const root = (): string => mkdtempSync(join(tmpdir(), "bb-user-identity-"));

describe("assertion-native user identity", () => {
  test("a declaration is a source-grounded assertion authored by the account", () => {
    const vault = root();
    const first = declareOwner(vault, {
      ...owner,
      name: "Alex Rowan",
      aliases: ["demo-user", "alex@example.com"],
      now: new Date("2026-08-21T12:00:00Z"),
    });
    expect(readSourceInsertionLog(vault, { strict: true })).toHaveLength(1);
    const assertions = readAssertionLog(vault, { strict: true });
    expect(assertions).toHaveLength(1);
    expect(assertions[0]!.author).toEqual({ kind: "user", id: "acct_alex" });
    expect(assertions[0]!.text).toContain("is the owner of this BigBrain vault");
    expect(assertions[0]!.text).toContain('"demo-user"');
    expect(first.entity_id).toBe(assertionEntityId("Alex Rowan"));
    expect(existsSync(join(vault, "entities"))).toBe(false);
    expect(latestUserIdentity(vault, { account_id: "acct_alex" }))
      .toMatchObject({ name: "Alex Rowan", aliases: ["alex@example.com", "demo-user"] });
  });

  test("a second declaration appends; the newest one is the identity", () => {
    const vault = root();
    declareOwner(vault, {
      ...owner, name: "Alex Rowan", aliases: ["demo-user"],
      now: new Date("2026-08-21T12:00:00Z"),
    });
    declareOwner(vault, {
      ...owner, name: "Alex Rowan", aliases: ["demo-user", "alpha@example.com"],
      now: new Date("2026-08-23T12:00:00Z"),
    });
    expect(readSourceInsertionLog(vault, { strict: true })).toHaveLength(2);
    expect(userIdentityDeclarations(vault)).toHaveLength(2);
    expect(latestUserIdentity(vault)?.aliases).toContain("alpha@example.com");
  });

  test("an alias match finds the declaration; an unknown one finds nothing", () => {
    const vault = root();
    declareOwner(vault, {
      ...owner, name: "Alex Rowan", aliases: ["demo-user"],
      now: new Date("2026-08-21T12:00:00Z"),
    });
    expect(latestUserIdentity(vault, { alias: "DEMO-USER" })?.name).toBe("Alex Rowan");
    expect(latestUserIdentity(vault, { alias: "someone@else.com" })).toBeUndefined();
    expect(latestUserIdentity(vault, { account_id: "acct_other" })).toBeUndefined();
  });

  test("no declaration at all is not an error — the readers answer empty", () => {
    const vault = root();
    expect(userIdentityDeclarations(vault)).toEqual([]);
    expect(latestUserIdentity(vault)).toBeUndefined();
  });

  test("the graph omits asserted self and its edges, not the underlying record", () => {
    const vault = root();
    const identity = declareOwner(vault, {
      ...owner, name: "Alex Rowan", aliases: ["demo-user"],
      now: new Date("2026-08-21T12:00:00Z"),
    });
    const meeting = insertion({
      id: `ins_${"a".repeat(24)}`, source_id: "meeting-1",
      author: { kind: "service", id: "granola" }, title: "Alex and Ada",
      body: "Alex and Ada discussed Atlas.", envelope: { source: "granola" },
      received_at: "2026-08-21T13:00:00Z", content_sha256: "meeting-hash",
    });
    appendSourceInsertionEvent(vault, meeting);
    projectSourceInsertion(vault, meeting);
    const alex = { id: identity.entity_id, label: "Alex Rowan" };
    const ada = { id: assertionEntityId("Ada Lovelace"), label: "Ada Lovelace" };
    appendAndProjectAssertion(vault, createAssertionEvent({
      text: `[[${alex.id}|Alex]] and [[${ada.id}|Ada]] discussed Atlas.`,
      entities: [alex, ada], sources: [meeting.id],
      author: { kind: "model", id: "test", invocation_id: "run-1" },
      confidence: "direct", created_at: "2026-08-21T13:01:00Z",
      produced_by: { procedure: "test", version: "1" },
    }, new Map([[meeting.id, meeting]])));

    const graph = buildAssertionGraph(vault);
    expect(graph.userNote?.ids).toContain(identity.entity_id);
    expect(graph.userNote?.names).toContain("Alex Rowan");
    expect(graph.userNote?.names).toContain("demo-user");
    expect(graph.userNote?.names).not.toContain("Ada Lovelace");
    expect(graph.nodes.some((node) => node.id === identity.entity_id)).toBe(false);
    // the declaration's own source draws too, as a lone point: a source
    // whose every entity was self keeps its node (2026-09-05), edges or not
    expect(graph.nodes.map((node) => node.title).sort()).toEqual(["About Alex Rowan", "Ada Lovelace", "Alex and Ada"]);
    expect(graph.edges).toEqual([{ source: ada.id, target: `source:${meeting.id}` }].map((edge) => {
      const [source, target] = [edge.source, edge.target].sort();
      return { source, target };
    }));
    expect(readAssertionLog(vault, { strict: true })).toHaveLength(2);
  });
});

describe("declareUserIdentity — the local door (#572)", () => {
  const say = (vault: string, name: string, now: string) =>
    declareUserIdentity(vault, { name, email: "ada@example.com", now: new Date(now) });

  test("what it writes, its own readers read back", () => {
    const vault = root();
    const me = say(vault, "Ada Lovelace", "2026-08-31T09:00:00Z");
    // The round trip is the whole contract: the reader policy checks the
    // procedure, the authorship agreement, the envelope kind and that the
    // entity id is hash(the declared name) — a writer that gets any of them
    // wrong produces a declaration nothing can find.
    expect(latestUserIdentity(vault)).toEqual(me);
    expect(me.entity_id).toBe(assertionEntityId("Ada Lovelace"));
    expect(me.account_id).toBe("ada@example.com");
    expect(me.aliases).toEqual(["ada@example.com"]);
  });

  test("the email is the first alias, and duplicates collapse", () => {
    const vault = root();
    const me = declareUserIdentity(vault, {
      name: "Ada Lovelace",
      email: "ada@example.com",
      aliases: ["Ada", "ADA@EXAMPLE.COM"],
    });
    expect(me.aliases).toEqual(["ada@example.com", "Ada"]);
  });

  test("an exact retry converges — a lost reply is safe to replay", () => {
    const vault = root();
    const first = say(vault, "Ada Lovelace", "2026-08-31T09:00:00Z");
    const again = say(vault, "Ada Lovelace", "2026-08-31T11:00:00Z");
    expect(again.source_id).toBe(first.source_id);
    expect(again.created_at).toBe(first.created_at); // the FIRST saying stands
    expect(readSourceInsertionLog(vault, { strict: true })).toHaveLength(1);
    expect(userIdentityDeclarations(vault)).toHaveLength(1);
  });

  test("a new name is a new declaration, and the newest wins", () => {
    const vault = root();
    say(vault, "Ada Lovelace", "2026-08-31T09:00:00Z");
    const second = say(vault, "Ada Byron", "2026-08-31T10:00:00Z");
    expect(userIdentityDeclarations(vault)).toHaveLength(2);
    expect(latestUserIdentity(vault)?.name).toBe("Ada Byron");
    // Immutable, not an edit: the old declaration is still readable, which
    // is what lets `bigbrain entity supersede` move the assertions across.
    expect(userIdentityDeclarations(vault)[0]!.name).toBe("Ada Lovelace");
    expect(second.entity_id).not.toBe(assertionEntityId("Ada Lovelace"));
  });

  test("a name that would forge a wikilink is refused", () => {
    const vault = root();
    // The assertion text wikilinks the name; a bracket in it would open a
    // second link inside the sentence the record keeps forever.
    expect(() => declareUserIdentity(vault, { name: "Ada [[Alex]]", email: "a@b.c" })).toThrow();
    expect(() => declareUserIdentity(vault, { name: "  ", email: "a@b.c" })).toThrow();
    expect(() => declareUserIdentity(vault, { name: "Ada", email: "" })).toThrow();
    expect(userIdentityDeclarations(vault)).toEqual([]);
  });
});

describe("the hosted-era dossier, adopted (#683)", () => {
  const dossier = (vault: string, front: string): void => {
    mkdirSync(join(vault, "entities"), { recursive: true });
    writeFileSync(join(vault, "entities", "alex-rowan.md"), `---\n${front}\n---\n\nbody\n`);
  };
  const FRONT =
    "type: entity\nentity_type: person\nhuman_user: true\naliases:\n  - Alex Rowan\n  - Alex\n  - Alexander Rowan\n  - alex+fri@example.com\n  - demo-user";

  test("no flagged dossier: nothing to plan, nothing to adopt", () => {
    const vault = root();
    expect(planLegacyUserAdoption(vault)).toBeUndefined();
    expect(legacyUserLabels(vault)).toEqual([]);
    expect(() => adoptLegacyUserDossier(vault, { email: "x@example.com" })).toThrow("nothing to adopt");
  });

  test("a dossier and no declaration: no prior to restate — adopt refuses and names --declare, which carries the labels itself", () => {
    const vault = root();
    dossier(vault, FRONT);
    const plan = planLegacyUserAdoption(vault)!;
    expect(plan.dossiers).toEqual(["entities/alex-rowan.md"]);
    expect(plan.prior).toBeUndefined();
    expect(plan.missing).toEqual(["Alex Rowan", "Alex", "Alexander Rowan", "alex+fri@example.com", "demo-user"]);
    expect(plan.email).toBe("alex+fri@example.com");
    expect(() => adoptLegacyUserDossier(vault, { email: "alex@example.com" })).toThrow("--declare");
    // the door: the name itself is not an alias, everything else comes along
    declareUserIdentity(vault, { name: "Alex Rowan", email: "alex@example.com", aliases: legacyUserLabels(vault) });
    expect(latestUserIdentity(vault)?.aliases).toEqual([
      "alex@example.com", "Alex", "Alexander Rowan", "alex+fri@example.com", "demo-user",
    ]);
    expect(planLegacyUserAdoption(vault)?.missing).toEqual([]);
  });

  test("a hosted-era declaration beside the dossier: adopt restates it — same name and entity, its aliases first, the dossier's after, attributed to its first email", () => {
    const vault = root();
    dossier(vault, FRONT);
    const first = declareOwner(vault, {
      ...owner, name: "Alex Rowan", aliases: ["alex@example.com", "demo-user"],
      now: new Date("2026-08-23T00:00:00Z"),
    });
    const plan = planLegacyUserAdoption(vault)!;
    expect(plan.prior?.assertion_id).toBe(first.assertion_id);
    expect(plan.missing).toEqual(["Alex", "Alexander Rowan", "alex+fri@example.com"]);
    expect(plan.email).toBe("alex@example.com"); // acct_alex is a tenant id, not an email
    const adopted = adoptLegacyUserDossier(vault, { email: plan.email!, now: new Date("2026-09-01T00:00:00Z") });
    expect(adopted.name).toBe("Alex Rowan");
    expect(adopted.entity_id).toBe(first.entity_id);
    expect(adopted.account_id).toBe("alex@example.com");
    expect(adopted.aliases).toEqual(["alex@example.com", "demo-user", "Alex", "Alexander Rowan", "alex+fri@example.com"]);
    expect(userIdentityDeclarations(vault)).toHaveLength(2);
    expect(latestUserIdentity(vault)?.assertion_id).toBe(adopted.assertion_id);
    // once is enough, and the dossier is the person's — untouched
    expect(planLegacyUserAdoption(vault)?.missing).toEqual([]);
    expect(() => adoptLegacyUserDossier(vault, { email: "alex@example.com" })).toThrow("nothing to adopt");
    expect(readFileSync(join(vault, "entities", "alex-rowan.md"), "utf8")).toContain("human_user: true");
  });

  test("a dossier title that differs from the declared name becomes an alias, never a rename", () => {
    const vault = root();
    dossier(vault, "title: Alexander Rowan\nhuman_user: true\naliases:\n  - demo-user");
    const first = declareOwner(vault, {
      ...owner, name: "Alex Rowan", aliases: ["demo-user"], now: new Date("2026-08-23T00:00:00Z"),
    });
    const adopted = adoptLegacyUserDossier(vault, { email: "alex@example.com" });
    expect(adopted.name).toBe("Alex Rowan");
    expect(adopted.entity_id).toBe(first.entity_id);
    expect(adopted.aliases).toEqual(["alex@example.com", "demo-user", "Alexander Rowan"]);
  });

  test("two flagged dossiers merge, unique by normalization, path order", () => {
    const vault = root();
    mkdirSync(join(vault, "entities", "sub"), { recursive: true });
    writeFileSync(join(vault, "entities", "a.md"), "---\ntitle: Ada\nhuman_user: true\naliases:\n  - ADA\n  - Countess\n---\n");
    writeFileSync(join(vault, "entities", "sub", "b.md"), "---\ntitle: Countess\nhuman_user: true\naliases:\n  - Lovelace\n---\n");
    expect(legacyUserLabels(vault)).toEqual(["Ada", "Countess", "Lovelace"]);
    expect(planLegacyUserAdoption(vault)?.dossiers).toEqual(["entities/a.md", "entities/sub/b.md"]);
  });
});
