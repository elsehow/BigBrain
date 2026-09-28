// Synthetic EntityFolds scenes. Names, IDs, counts, and explanations are invented.
// Optional private previews stay in the gitignored entityFolds.local.json file.
import type { EntityFolds, FoldGroup } from "../lib/types";

export interface FoldScene {
  label: string;
  note: string;
  proposedAt: string | null;
  groups: FoldGroup[];
}

const g = (seed: number, canonical: number, why: string, ...labels: [string, number][]): FoldGroup => {
  const members = labels.map(([label, assertions], i) => ({
    id: `ent_${(seed * 16 + i).toString(16).padStart(20, "0")}`, label, assertions,
  }));
  return { members, canonical: members[canonical]!.id, why };
};

export const SAMPLE_GROUPS: FoldGroup[] = [
  g(1, 1, "The demo dashboard was renamed; its old title and descriptive label remain in older notes.",
    ["Trail Map", 40], ["TrailAtlas", 12], ["Trail Atlas Dashboard", 6], ["Trailmap", 3], ["Route planning dashboard", 1]),
  g(2, 0, "Six invented names for one table-export benchmark exercise the crowded group layout.",
    ["TableSim", 32], ["Table Simulation", 30], ["Table Simulation Benchmark", 20],
    ["TableBenchSim", 4], ["TableBench-sim", 2], ["TableBench Sim", 1]),
  g(3, 0, "The short label is the organization's initialism.",
    ["Field Research Institute", 120], ["FRI", 25]),
  g(4, 0, "A spacing variant of the demo application's name.",
    ["MapBook", 75], ["Map Book", 20]),
  g(5, 0, "A spacing variant of the benchmark's name.",
    ["FieldBench", 60], ["Field Bench", 24]),
  g(6, 0, "Two transcription variants refer to the same invented contributor.",
    ["Jules Lane", 80], ["J Lane", 3], ["J. Lane", 1]),
  g(7, 0, "The longer label describes the same demo survey.",
    ["PINE", 40], ["PINE survey", 2]),
  g(8, 0, "Both titles refer to the same sample paper.",
    ["Route planning paper", 8], ["Trail dashboard paper", 7]),
  g(9, 0, "A familiar form of the same invented person's given name.",
    ["Peter Sutton", 16], ["Pete Sutton", 5]),
  g(10, 0, "An abbreviated organization name.",
    ["Northstar Workshop", 10], ["Northstar", 9]),
  g(11, 0, "Hyphenation variants of a demo project.",
    ["River-Flow Sensors", 4], ["River Flow Sensors", 1]),
];

const local = Object.values(
  import.meta.glob<{ default: EntityFolds }>("./entityFolds.local.json", { eager: true })
)[0]?.default;

const SAMPLE_AT = "2026-01-01T12:00:00.000Z";

export const FOLD_SCENES: Record<string, FoldScene> = {
  proposals: {
    label: "1 · proposals — eleven synthetic groups",
    note: "Eleven invented groups cover renamed projects, initialisms, transcription variants, and long label lists. Choose a canonical label, remove a member, or accept a group to preview each state. Nothing writes until accept.",
    proposedAt: SAMPLE_AT,
    groups: SAMPLE_GROUPS,
  },
  everything: {
    label: local ? `2 · everything — this machine's ${local.groups.length}` : "2 · everything — (no local run; the sample)",
    note: local
      ? `The whole of this machine's last run — web/ui/src/dev/entityFolds.local.json, gitignored: ${local.groups.length} groups over ${local.census} entities, proposed ${local.proposedAt.slice(0, 10)} by ${local.model}. Write it with \`bigbrain entity folds --json > web/ui/src/dev/entityFolds.local.json\`.`
      : "No entityFolds.local.json beside foldFixtures.ts on this machine, so this is the sample again. `bigbrain entity folds --json > web/ui/src/dev/entityFolds.local.json` writes a real one; it is gitignored.",
    proposedAt: local?.proposedAt ?? SAMPLE_AT,
    groups: local?.groups ?? SAMPLE_GROUPS,
  },
  one: {
    label: "3 · one group — the six-label case",
    note: "The case the pill row exists for: six labels, one paper, and the canonical is a coin flip between the two most-cited. Pick, prune, accept.",
    proposedAt: SAMPLE_AT,
    groups: [SAMPLE_GROUPS[1]!],
  },
  none: {
    label: "4 · nothing proposed",
    note: "The pass ran and found nothing to fold — the state most vaults are in most days.",
    proposedAt: SAMPLE_AT,
    groups: [],
  },
};
