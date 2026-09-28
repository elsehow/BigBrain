/** Explicit commands supplied by the application composition boundary. */
export interface PilotCoordination {
  navigate(id: string, replace?: boolean, focus?: boolean): void;
  selection(): string[];
  clearSelection(): void;
  recordChanged(): void;
  settled(): void;
  refreshWorkers(): Promise<void>;
}
let owner: PilotCoordination | undefined;
export function configurePilotCoordination(value: PilotCoordination): void { owner = value; }
export function pilotCoordination(): PilotCoordination {
  if (!owner) throw new Error("Pilot application coordination is not initialized.");
  return owner;
}
