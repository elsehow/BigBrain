/** The integrations BigBrain manages, in the order Settings lists them. Each
 * declares itself (lib/integrations/contract.ts); adding one is a file here and
 * a line below. */
import type { OriginKind } from "../provenance";
import type { Integration, IntegrationTool } from "./contract";
import { email } from "./email";
import { granola } from "./granola";
import { hardcover } from "./hardcover";
import { rss } from "./rss";
import { thatTracks } from "./thatTracks";

export type { Integration, IntegrationTool, IntegrationCallOptions, ToolContext } from "./contract";

export const INTEGRATIONS: readonly Integration[] = [email, granola, thatTracks, rss, hardcover];
export const MANAGED_INTEGRATIONS: ReadonlySet<string> = new Set(INTEGRATIONS.map(i => i.id));

export const integrationNamed = (id: string): Integration | undefined => INTEGRATIONS.find(i => i.id === id);

const TOOLS = new Map(INTEGRATIONS.flatMap(integration => integration.tools.map(tool => [tool.name, { integration, tool }] as const)));
/** A live tool by the name agents call it, with the integration that declares it. */
export const integrationTool = (name: string): { integration: Integration; tool: IntegrationTool } | undefined => TOOLS.get(name);

/** The origin a live tool's results come from, or undefined for one that returns no content. */
export const liveOrigin = (name: string): OriginKind | undefined => {
  const found = TOOLS.get(name);
  return found?.tool.reads ? found.integration.origin : undefined;
};

/** A live integration read's result as an agent receives it. */
export const liveForAgent = (name: string, result: unknown, now = Date.now()): unknown =>
  TOOLS.get(name)?.tool.forAgent?.(result, { screened: 0, held: 0 }, now) ?? result;
