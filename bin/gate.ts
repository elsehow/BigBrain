/**
 * bigbrain gate — the worth gate (lib/worthGate.ts, #80): its cut-off now,
 * what it has decided, and what it passed lately, so a drop is never silent.
 *
 *   bigbrain gate          status, and the latest items it passed
 *   bigbrain gate --json   the same, as JSON
 *
 * Needs a `gate:` block in vault.yaml (vault.example.yaml has one).
 */

import { requireVaultRoot } from "../lib/engine";
import { hasFlag } from "../lib/cliflags";
import { loadManifest } from "../lib/manifest";
import { MANAGED_INTEGRATIONS } from "../lib/integrationAccess";
import { currentGate, gateDecisions, gated } from "../lib/worthGate";

const root = requireVaultRoot();
const cfg = loadManifest(root).gate;
if (!cfg) {
  console.error("gate: off — add a gate: block to vault.yaml (see vault.example.yaml)");
  process.exit(2);
}

const all = gateDecisions(root);
const status = [...MANAGED_INTEGRATIONS].filter((source) => gated(cfg, source)).map((source) => {
  const decisions = all.filter((d) => d.source === source);
  const { threshold, kept } = currentGate(root, cfg, source);
  const answered = decisions.filter((d) => d.insertion_id && kept.has(d.insertion_id));
  return {
    source,
    threshold,
    scored: decisions.filter((d) => d.score != null).length,
    admitted: decisions.filter((d) => d.admitted && !d.sampled).length,
    sampled: decisions.filter((d) => d.sampled).length,
    passed: decisions.filter((d) => !d.admitted).length,
    unscored: decisions.filter((d) => d.score == null).length,
    answered: answered.length,
    filed: answered.filter((d) => kept.get(d.insertion_id!)).length,
    recentPasses: decisions.filter((d) => !d.admitted).slice(-10).reverse().map((d) => ({ at: d.at, score: d.score, title: d.title })),
  };
});

if (hasFlag(process.argv.slice(2), "json")) {
  console.log(JSON.stringify({ config: cfg, sources: status }, null, 2));
} else {
  for (const s of status) {
    console.log(`${s.source}: cut-off ${s.threshold.toFixed(2)}${s.answered < cfg.min ? ` (learning: ${s.answered}/${cfg.min} verdicts)` : ""}`);
    console.log(`  ${s.scored} scored · ${s.admitted} admitted · ${s.sampled} sampled under the cut-off · ${s.passed} passed · ${s.unscored} admitted unscored`);
    console.log(`  the gardener has answered ${s.answered} and filed ${s.filed}`);
    for (const p of s.recentPasses) console.log(`  passed ${p.at.slice(0, 16).replace("T", " ")}  ${p.score?.toFixed(2)}  ${p.title}`);
  }
}
