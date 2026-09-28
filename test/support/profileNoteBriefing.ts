/** Optional live model benchmark, using only fabricated notes. */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { briefingPrompt, noteBriefingInput, noteBriefingPreview, noteBriefingSchema, NOTE_BRIEFING_MODEL_OPTIONS, NOTE_BRIEFING_SYSTEM, parseNoteBriefing } from "../../lib/noteBriefing";
import { runBriefingModel } from "../../lib/entityBriefing";

const [agent = "claude", model = "haiku", mode = "prepare", limit = "10", samples = "3"] = process.argv.slice(2);
if (!["claude", "pi"].includes(agent) || !/^[a-zA-Z0-9._-]+$/.test(model) || !["live", "prepare"].includes(mode) || !["5", "10"].includes(limit) || !/^[1-5]$/.test(samples))
  throw new Error("Usage: bun test/support/profileNoteBriefing.ts [claude|pi] [model] [live|prepare] [5|10] [samples=3]");
const root = mkdtempSync(join(tmpdir(), "bb-synthetic-briefing-profile-"));
try {
const files: Record<string, string> = {
  'vault.yaml': 'quick:\n  agent: claude\n  model: haiku\n',
  'entities/maya.md': '# Maya Chen\nMaya is a volunteer coordinator at [[entities/atlas|Atlas]], a fictional neighborhood tool library. Maya leads [[entities/expansion|Second location]] and recruits [[entities/volunteers|Volunteer team]]. She works with [[entities/leo|Leo Park]] on the expansion. [[memory/planning|Planning notebook]] records the delayed opening. [[references/meeting|Planning meeting]] records their decision. [[references/session|Claude Code session]] mentions Atlas while fixing an unrelated CSS issue.\n',
  'entities/atlas.md': '# Atlas\nAtlas is a fictional neighborhood tool library. [[entities/maya|Maya Chen]] coordinates its [[entities/expansion|Second location]] project and [[entities/volunteers|Volunteer team]]. [[entities/leo|Leo Park]] manages the lease. [[memory/planning|Planning notebook]] and [[references/meeting|Planning meeting]] record the delayed opening after a lease fell through. [[references/session|Claude Code session]] mentions Atlas during an unrelated CSS fix.\n',
  'entities/expansion.md': '# Second location\nAtlas plans to open a second location; the opening is postponed because its lease fell through.\n',
  'entities/volunteers.md': '# Volunteer team\nVolunteers staff Atlas and prepare its expansion. Maya recruits the team.\n',
  'entities/leo.md': '# Leo Park\nLeo manages the lease for Atlas and coordinates the expansion with Maya.\n',
  'memory/planning.md': '# Planning notebook\nThe [[entities/atlas|Atlas]] expansion is postponed after the lease fell through. [[entities/maya|Maya]] coordinates volunteers; [[entities/leo|Leo]] seeks another lease.\n',
  'references/meeting.md': '# Planning meeting\nMaya and Leo postponed the Atlas opening after the lease fell through.\n',
  'references/session.md': '# Claude Code session\nA programmer changed CSS padding in an unrelated web app and mentioned Atlas in passing.\n',
};
const extra = [
  ["lena", "Lena Ortiz", "Lena trains Atlas volunteers with Maya."],
  ["repair", "Repair team", "The repair team maintains tools at Atlas and advises Maya on training."],
  ["donors", "Donor circle", "The donor circle funds tools for Atlas; Maya reports expansion progress to it."],
  ["board", "Library board", "The library board approved the expansion plan Maya coordinates at Atlas."],
  ["training", "Volunteer training", "Volunteer training prepares Maya's Atlas team to staff the new location."],
  ["shed", "Community shed", "The community shed stores Atlas equipment during the delayed expansion."],
];
for (const [id, title, text] of extra) {
  files[`entities/${id}.md`] = `# ${title}\n${text}\n`;
  for (const anchor of ["maya", "atlas"]) files[`entities/${anchor}.md`] += `\n[[entities/${id}|${title}]]: ${text}\n`;
}
for (const [path, content] of Object.entries(files)) {
  mkdirSync(join(root, path.split('/').slice(0, -1).join('/')), { recursive: true });
  writeFileSync(join(root, path), content);
}

  writeFileSync(join(root, "vault.yaml"), `quick:\n  agent: ${agent}\n  model: ${model}\n${agent === "pi" ? "  reasoning: low\n" : ""}`);
  const start = performance.now();
  const full = noteBriefingInput(root, { selected: ["entities/maya.md", "entities/atlas.md"], excluded: [] });
  const { prompt, input } = briefingPrompt({ ...full, links: full.links.slice(0, Number(limit)) });
  console.log(JSON.stringify({ preparationMs: performance.now() - start, promptCharacters: prompt.length, candidates: input.links.length,
    memories: JSON.parse(prompt).memories.length }));
  if (mode !== "prepare") for (let run = 0; run < Number(samples); run++) {
    let firstSummaryMs: number | undefined;
    const started = performance.now();
    try {
    const result = await runBriefingModel(root, prompt, text => {
      if (firstSummaryMs === undefined && noteBriefingPreview(text)?.trim()) firstSummaryMs = performance.now() - started;
    }, NOTE_BRIEFING_SYSTEM, { ...NOTE_BRIEFING_MODEL_OPTIONS, outputSchema: noteBriefingSchema(input) });
    const parsed = parseNoteBriefing(result.text, input);
    console.log(JSON.stringify({ run, agent, model, mode, candidates: input.links.length, ...result.timing, firstSummaryMs,
      descriptionWords: parsed.links.map(link => link.description?.split(/\s+/).length) }));
    } catch (error) {
      console.log(JSON.stringify({ run, agent, model, mode, status: "failed", totalMs: performance.now() - started, firstSummaryMs,
        error: error instanceof Error ? error.message : String(error) }));
      process.exitCode = 1;
    }
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
