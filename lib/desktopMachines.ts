/**
 * desktopMachines.ts — the person's settings for contained desktops'
 * machines (docs/plans/2026-10-12-contained-desktops.md, "What the person
 * sees", Settings › Desktops): memory per machine and how many run at once,
 * kept in the vault's .env like the desktop network; and what the machine
 * image takes on this computer.
 */
import { readEnvValues, writeEnvValues } from "./envFile";

const MEMORY = "BIGBRAIN_DESKTOP_MACHINE_MEMORY";
const RUNNING = "BIGBRAIN_DESKTOP_MACHINES_RUNNING";

export const MEMORY_GIB = [1, 2, 3, 4, 6, 8] as const;
export const RUNNING_CHOICES = [1, 2, 3, 4, 5, 6] as const;
const DEFAULTS = { memoryGiB: 2, running: 3 };

export interface MachineSettings { memoryGiB: number; running: number }

const pick = <T extends number>(raw: string | undefined, choices: readonly T[], fallback: number): number => {
  const n = Number(raw);
  return (choices as readonly number[]).includes(n) ? n : fallback;
};

export function machineSettings(root: string): MachineSettings {
  const env = readEnvValues(root);
  return { memoryGiB: pick(env[MEMORY], MEMORY_GIB, DEFAULTS.memoryGiB), running: pick(env[RUNNING], RUNNING_CHOICES, DEFAULTS.running) };
}

export function saveMachineSettings(root: string, input: unknown): MachineSettings {
  const o = (input ?? {}) as Record<string, unknown>;
  const next = machineSettings(root);
  if (o.memoryGiB !== undefined) {
    if (!(MEMORY_GIB as readonly unknown[]).includes(o.memoryGiB)) throw new Error(`Choose ${MEMORY_GIB.join(", ")} GB.`);
    next.memoryGiB = o.memoryGiB as number;
  }
  if (o.running !== undefined) {
    if (!(RUNNING_CHOICES as readonly unknown[]).includes(o.running)) throw new Error(`Choose 1 to ${RUNNING_CHOICES.at(-1)} at once.`);
    next.running = o.running as number;
  }
  writeEnvValues(root, { [MEMORY]: String(next.memoryGiB), [RUNNING]: String(next.running) });
  return next;
}
