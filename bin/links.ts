/**
 * links.ts — the editor's wikilink tool (lib/links.ts as a CLI).
 *
 *   bun bin/links.ts check               validate every link (Obsidian rule)
 *                                        and every sources: ref (citation
 *                                        contract; unsourced notes are
 *                                        grandfathered)
 *   bun bin/links.ts migrate [--write]   one-time old-dialect cleanup;
 *                                        dry-run unless --write
 *
 * check validates edges that exist — informational (exit 0). Deciding what
 * a broken link MEANS is the editor's job. (The `suggest`/`decline`
 * candidate machinery died 2026-08-05: a replay A/B measured no linking
 * benefit from feeding the editor an embedding-backed shortlist.)
 */

import { VAULT_ROOT } from "../lib/vaultRoot";
import { checkLinks, checkSources, checkTypes, migrateLinks, type Link } from "../lib/links";

const cmd = process.argv[2];
const fmt = (l: Link): string =>
  `  ${l.file}:${l.line}  [[${l.target}${l.sub}${l.label ? `|${l.label}` : ""}]]`;

if (cmd === "check") {
  const r = checkLinks(VAULT_ROOT);
  if (r.broken.length) {
    console.log(`UNRESOLVED (${r.broken.length}) — no note has this filename:`);
    for (const l of r.broken) console.log(fmt(l));
  }
  if (r.ambiguous.length) {
    console.log(
      `AMBIGUOUS (${r.ambiguous.length}) — several notes share this basename; link by path or rename:`
    );
    for (const l of r.ambiguous) console.log(fmt(l));
  }
  if (r.boundary.length) {
    console.log(
      `MEMORY BOUNDARY (${r.boundary.length}) — record notes never link into memory/ (cache, not evidence):`
    );
    for (const l of r.boundary) console.log(fmt(l));
  }
  if (r.unqualified.length) {
    // a pre-migration vault reports thousands of these; print a readable
    // window and SAY what was withheld — a silent cap reads as "that's all"
    const SHOWN = 20;
    console.log(
      `UNQUALIFIED (${r.unqualified.length}) — bare basename, not a vault-root path; run \`migrate\`:`
    );
    for (const l of r.unqualified.slice(0, SHOWN)) console.log(fmt(l));
    if (r.unqualified.length > SHOWN)
      console.log(`  … ${r.unqualified.length - SHOWN} more (not shown)`);
  }
  if (r.markdown.length) {
    console.log(
      `MARKDOWN LINKS (${r.markdown.length}) — these point at real notes but the link graph ` +
        `cannot see them; make them wikilinks (\`migrate\` does it):`
    );
    for (const l of r.markdown.slice(0, 20)) {
      console.log(`  ${l.file}:${l.line}  [${l.label}](${l.href})  →  ${l.resolved}`);
    }
    if (r.markdown.length > 20) console.log(`  … ${r.markdown.length - 20} more (not shown)`);
  }
  console.log(
    `links: ${r.total} total, ${r.broken.length} unresolved, ${r.ambiguous.length} ambiguous, ` +
      `${r.boundary.length} boundary, ${r.unqualified.length} unqualified, ` +
      `${r.markdown.length} markdown`
  );
  // the citation contract — same informational discipline (exit 0): notes
  // WITHOUT sources: are grandfathered and never reported
  const s = checkSources(VAULT_ROOT);
  if (s.unresolved.length) {
    console.log(`UNRESOLVED SOURCES (${s.unresolved.length}) — no reference has this id/path:`);
    for (const u of s.unresolved) console.log(`  ${u.file}  sources: ${u.ref}`);
  }
  console.log(
    `sources: ${s.total} ref(s) across ${s.citing} citing note(s), ${s.unresolved.length} unresolved`
  );
  // the type vocabulary — reference|entity by tree, memory tree-typed,
  // `note` retired, `request` a routing kind (same informational discipline)
  const t = checkTypes(VAULT_ROOT);
  if (t.violations.length) {
    console.log(
      `TYPE VIOLATIONS (${t.violations.length}) — the vault's types are reference | entity | memory (by tree):`
    );
    for (const v of t.violations)
      console.log(`  ${v.file}  type: ${v.declared} (expected ${v.expected})`);
  }
  console.log(`types: ${t.checked} item(s) checked, ${t.violations.length} violation(s)`);
} else if (cmd === "migrate") {
  const write = process.argv.includes("--write");
  const r = migrateLinks(VAULT_ROOT, write);
  if (r.unmatched.length) {
    console.log(`UNMATCHED (${r.unmatched.length}) — no date-stripped match either; fix by hand:`);
    for (const l of r.unmatched) console.log(fmt(l));
  }
  if (r.contested.length) {
    console.log(`CONTESTED (${r.contested.length}) — several dated files match; pick one by hand:`);
    for (const c of r.contested)
      console.log(`${fmt(c.link)}\n    → ${c.candidates.join("\n    → ")}`);
  }
  console.log(
    `migrate${write ? "" : " (dry-run)"}: ${r.rewritten} link(s) rewritten across ${r.filesTouched} file(s), ` +
      `${r.unmatched.length} unmatched, ${r.contested.length} contested`
  );
} else {
  console.error("usage: bun bin/links.ts check | migrate [--write]");
  process.exit(2);
}
