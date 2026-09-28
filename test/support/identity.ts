/**
 * The owner-identity record, fabricated for tests.
 *
 * lib/userIdentity.ts reads declarations; nothing in the product writes one
 * since the hosted edge's POST /api/me went with the exe.dev contract (#570),
 * and where the local door lands is open in #572. The READERS are live — the
 * projected entity page's `you` flag (#501) and the graph's self-suppression
 * both ask — so the shape they recognize is built here instead, once.
 *
 * This is deliberately the production procedure spelled out: a declaration is
 * one source insertion carrying the person's own words plus one assertion
 * authored by the same account, and a reader that stopped requiring all three
 * to agree should fail these tests.
 */

import { createHash } from "node:crypto";
import {
  assertionEntityId,
  commitAssertionEvents,
  createAssertionEvent,
} from "../../lib/assertionLog";
import { appendAndProjectAssertion, projectSourceInsertion } from "../../lib/assertionProjection";
import {
  appendSourceInsertionEvent,
  commitSourceInsertionEvents,
  sourceInsertion,
  type SourceInsertion,
} from "../../lib/insertionLog";
import {
  USER_IDENTITY_PROCEDURE,
  USER_IDENTITY_VERSION,
  type UserIdentityDeclaration,
} from "../../lib/userIdentity";

const norm = (value: string): string => value.trim().toLocaleLowerCase().replace(/\s+/gu, " ");

function sentence(name: string, aliases: readonly string[]): string {
  const also = aliases.filter((alias) => norm(alias) !== norm(name));
  return (
    `[[${assertionEntityId(name)}|${name}]] is the owner of this BigBrain vault` +
    (also.length ? ` and is also known as ${also.map((a) => JSON.stringify(a)).join(", ")}` : "") +
    "."
  );
}

/** Write one owner declaration into `root` and answer what a reader should
 * find. `aliases` are stored verbatim after the verified email, which leads
 * (as the hosted door recorded them). Committing is real: the readers walk
 * the logs, not the working tree. */
export function declareOwner(
  root: string,
  input: {
    account: string;
    name: string;
    aliases?: readonly string[];
    verified_email: string;
    now?: Date;
  }
): UserIdentityDeclaration {
  const { account, name, verified_email: email } = input;
  const aliases = [...new Set([email, ...(input.aliases ?? [])])];
  const createdAt = (input.now ?? new Date()).toISOString();
  const identity = JSON.stringify({ account, name, aliases });
  const sourceId = `identity-${createHash("sha256").update(identity).digest("hex").slice(0, 24)}`;
  const body =
    `${name} says they are the owner of this BigBrain vault` +
    ` and are known by ${aliases.map((a) => JSON.stringify(a)).join(", ")}.`;
  const source: SourceInsertion = {
    ...sourceInsertion(
      {
        id: sourceId,
        title: `About ${name}`,
        kind: "identity-declaration",
        source: "user-bootstrap",
        from: email,
        from_kind: "person",
        received: createdAt,
        identity_name: name,
        identity_aliases: aliases,
      },
      body
    ),
    author: { kind: "user", id: account },
  };
  const sourceResult = appendSourceInsertionEvent(root, source);
  projectSourceInsertion(root, source);

  const entity = { id: assertionEntityId(name), label: name };
  const event = createAssertionEvent(
    {
      text: sentence(name, aliases),
      entities: [entity],
      sources: [source.id],
      author: { kind: "user", id: account },
      confidence: "direct",
      created_at: createdAt,
      produced_by: { procedure: USER_IDENTITY_PROCEDURE, version: USER_IDENTITY_VERSION },
    },
    new Map([[source.id, source]])
  );
  const assertionResult = appendAndProjectAssertion(root, event);

  commitSourceInsertionEvents(root, [sourceResult.path], "identity: record user declaration");
  commitAssertionEvents(root, [assertionResult.path], "identity: assert vault owner");
  return {
    account_id: account,
    entity_id: entity.id,
    name,
    aliases,
    assertion_id: event.id,
    source_id: source.source_id,
    insertion_id: source.id,
    created_at: createdAt,
  };
}
