// Run the firewall eval: every fixture through lib/firewall.ts's screen()
// against Jev, then how each threshold would do.
//
//   bun deploy/firewall/eval/run.ts [url]   (default: Jev itself)
//
// It screens with this machine's Jev key (lib/jevSettings.ts); `url` points
// the same request at a stand-in instead (BIGBRAIN_FIREWALL_URL).
//
// Fixtures are invented. `expect` is credential | benign; the gate withholds
// when the credential score clears the threshold.

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIREWALL_THRESHOLD, firewallKey, screen } from "../../../lib/firewall";

if (process.argv[2]) process.env["BIGBRAIN_FIREWALL_URL"] = process.argv[2];
const root = mkdtempSync(join(tmpdir(), "bb-firewall-eval-"));
writeFileSync(join(root, "vault.yaml"), "integrations: {}\n");
if (!firewallKey(root)) {
  console.error("firewall eval: no Jev key on this machine (lib/jevSettings.ts)");
  process.exit(2);
}

type Fixture = { id: string; expect: "credential" | "benign"; text: string };
const fixtures = JSON.parse(readFileSync(join(import.meta.dir, "fixtures.json"), "utf8")) as Fixture[];

const rows: { id: string; expect: Fixture["expect"]; credential: number; ms: number }[] = [];
for (const f of fixtures) {
  const t = performance.now();
  const v = await screen(root, f.text);
  const credential = v.scores?.credential ?? 0;
  rows.push({ id: f.id, expect: f.expect, credential, ms: Math.round(performance.now() - t) });
  console.log(`${f.expect.padEnd(10)} ${f.id.padEnd(28)} credential ${credential.toFixed(3)}`);
}

const of = (e: Fixture["expect"]) => rows.filter((r) => r.expect === e);
const count = (e: Fixture["expect"], t: number) => `${of(e).filter((r) => r.credential >= t).length}/${of(e).length}`;
console.log("\nthreshold  credential caught  benign withheld");
for (const t of [0.1, 0.2, 0.25, 0.3, 0.35, 0.4, 0.5, 0.6, 0.7, 0.8])
  console.log(`${t.toFixed(2).padEnd(10)} ${count("credential", t).padStart(16)}  ${count("benign", t).padStart(15)}`);
const lo = Math.min(...of("credential").map((r) => r.credential));
const hi = Math.max(...of("benign").map((r) => r.credential));
console.log(`\ndefault ${FIREWALL_THRESHOLD}: withheld ${count("credential", FIREWALL_THRESHOLD)} credential, ${count("benign", FIREWALL_THRESHOLD)} benign`);
console.log(`margin: weakest credential ${lo.toFixed(3)}, strongest benign ${hi.toFixed(3)}`);
const ms = rows.map((r) => r.ms).sort((a, b) => a - b);
console.log(`latency: median ${ms[ms.length >> 1]} ms, max ${ms[ms.length - 1]} ms`);
