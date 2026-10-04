/** The registered chains (lib/chain.ts), in the order a tick reports them.
 * The classic chain is first: `bigbrain tend --json` keeps its result at the
 * top level, the contract the Claude plugin's /bigbrain:tend reads. */
import type { Chain } from "./chain";
import { goalChain } from "./goalChain";
import { classicChain } from "./tend";

/** A chain with no configuration (the goal chain without `chains.goals`) is
 * never due, so registering it costs a vault that does not use it nothing. */
export const CHAINS: readonly Chain[] = [classicChain as Chain, goalChain as Chain];
