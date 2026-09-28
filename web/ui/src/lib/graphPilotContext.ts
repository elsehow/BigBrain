type PilotContextNode = { pilotActive?: boolean; pilotPhase?: string; pilotNeedsYou?: boolean; live?: string };

/** Roster-active Pilots retain their context between turns until closed. */
export function activeContextPilot(node: PilotContextNode): boolean {
  return !!node.pilotPhase && (!!node.pilotActive || !!node.pilotNeedsYou
      || node.live === "working" || node.live === "waiting" || node.pilotPhase === "working" || node.pilotPhase === "active");
}
