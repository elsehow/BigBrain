// Run the firewall eval: every fixture through lib/firewall.ts's screen()
// against a live endpoint, then how each question's threshold would do.
//
//   bun deploy/firewall/eval/run.ts [url]   (default: the local Clef server)
//
// Fixtures are invented. `expect` is credential | malicious | benign; the
// gate withholds when either score clears its own threshold.

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { screen } from "../../../lib/firewall";
import { FIREWALL_THRESHOLDS } from "../../../lib/manifest";

const url = process.argv[2] ?? "http://127.0.0.1:4750/v1/systemone";
const root = mkdtempSync(join(tmpdir(), "bb-firewall-eval-"));
writeFileSync(join(root, "vault.yaml"), `firewall:\n  url: ${url}\n`);

type Fixture = { id: string; expect: "credential" | "malicious" | "benign"; text: string };
const fixtures = JSON.parse(readFileSync(join(import.meta.dir, "fixtures.json"), "utf8")) as Fixture[];

const rows: { id: string; expect: Fixture["expect"]; credential: number; malicious: number; ms: number }[] = [];
for (const f of fixtures) {
  const t = performance.now();
  const v = await screen(root, f.text);
  const s = v.scores ?? { credential: 0, malicious: 0 };
  rows.push({ id: f.id, expect: f.expect, ...s, ms: Math.round(performance.now() - t) });
  const gate = Math.max(s.credential, s.malicious);
  console.log(`${f.expect.padEnd(10)} ${f.id.padEnd(28)} cred ${s.credential.toFixed(3)}  mal ${s.malicious.toFixed(3)}  gate ${gate.toFixed(3)}`);
}

type Row = (typeof rows)[number];
const of = (e: Fixture["expect"]) => rows.filter((r) => r.expect === e);
const count = (e: Fixture["expect"], hit: (r: Row) => boolean) => `${of(e).filter(hit).length}/${of(e).length}`;
console.log("\nthreshold  credential q: caught / benign held   malicious q: caught / benign held");
for (const t of [0.1, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.85, 0.9]) {
  const c = (r: Row) => r.credential >= t, m = (r: Row) => r.malicious >= t;
  console.log(`${t.toFixed(2).padEnd(10)} ${count("credential", c).padStart(8)} / ${count("benign", c).padEnd(18)} ${count("malicious", m).padStart(8)} / ${count("benign", m)}`);
}
const { credential: tc, malicious: tm } = FIREWALL_THRESHOLDS;
const held = (r: Row) => r.credential >= tc || r.malicious >= tm;
console.log(`\ndefaults (credential ${tc}, malicious ${tm}): withheld ${count("credential", held)} credential, ${count("malicious", held)} malicious, ${count("benign", held)} benign`);
const ms = rows.map((r) => r.ms).sort((a, b) => a - b);
console.log(`\nlatency: median ${ms[ms.length >> 1]} ms, max ${ms[ms.length - 1]} ms`);
