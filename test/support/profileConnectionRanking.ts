/** Local-only comparison. Optional graph JSON must come from a scratch snapshot;
 * this script neither reads a vault nor calls a model. Default: fabricated graph. */
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { selectionConnections, type ConnectionRanking } from "../../lib/graphImportance";
import { connectionRankingFixture } from "./connectionRankingFixture";

const [file, ...keys] = process.argv.slice(2);
const graph = file ? JSON.parse(readFileSync(file, "utf8")) : connectionRankingFixture();
const selected = (keys.length ? keys : ["focus"]).map(key => {
  const titles = graph.nodes.filter((node: { title?: string }) => node.title === key);
  return titles.length === 1 ? titles[0].id : key;
});
const rankings: ConnectionRanking[] = ["importance", "personalized", "normalized", "discounted"];
for (const ranking of rankings) {
  let links: ReturnType<typeof selectionConnections> = [];
  const times: number[] = [];
  for (let run = 0; run < 6; run++) {
    const start = performance.now();
    links = selectionConnections(graph, selected, [], ranking);
    if (run) times.push(performance.now() - start);
  }
  console.log(JSON.stringify({ ranking, medianMs: times.sort((a, b) => a - b)[2], candidates: links.length,
    top: links.slice(0, 8).map(({ node }) => ({ id: node.id, title: (node as { title?: string }).title })) }));
}
