import { afterAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { machineSettings, saveMachineSettings } from "../lib/desktopMachines";
import { nativeVault } from "./support/vault";

const roots: string[] = [];
afterAll(() => roots.forEach(r => rmSync(r, { recursive: true, force: true })));

test("desktop machine settings: defaults, a saved choice, and a refusal that saves nothing", () => {
  const root = nativeVault(); roots.push(root);
  expect(machineSettings(root)).toEqual({ memoryGiB: 2, running: 3 });
  expect(saveMachineSettings(root, { memoryGiB: 4 })).toEqual({ memoryGiB: 4, running: 3 });
  expect(saveMachineSettings(root, { running: 1 })).toEqual({ memoryGiB: 4, running: 1 });
  expect(() => saveMachineSettings(root, { memoryGiB: 5 })).toThrow(/Choose 1, 2, 3, 4, 6, 8 GB/);
  expect(() => saveMachineSettings(root, { running: 40 })).toThrow(/Choose 1 to 6/);
  expect(machineSettings(root)).toEqual({ memoryGiB: 4, running: 1 });
});
