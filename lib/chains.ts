/** The registered chains (lib/chain.ts), in the order a tick reports them.
 * The classic chain is first: `bigbrain tend --json` keeps its result at the
 * top level, the contract the Claude plugin's /bigbrain:tend reads. */
import type { Chain } from "./chain";
import { classicChain } from "./tend";

export const CHAINS: readonly Chain[] = [classicChain as Chain];
