/**
 * sharedProtocol.ts — which version of the API between the app and a shared
 * vault server (bin/shared.ts) a server speaks. A change that only adds (a
 * route, an optional field) keeps the number; one that would make either
 * side misread the other raises it. The server names its version on every
 * reply; the app talks only to the versions it knows, and pauses a server
 * that speaks another, saying why, rather than acting on a reply it may
 * misread: a misread list of contributions reads as nothing shared, and the
 * claims it retracts in answer are gone for good.
 */
export const SHARED_PROTOCOL = 1;
export const PROTOCOL_HEADER = "BigBrain-Protocol";
/** The versions this app talks to: its own, and any older one it still reads
 * correctly, added by hand. A server from before the header speaks 1. */
export const SPOKEN: readonly number[] = [SHARED_PROTOCOL];
export const spokenBy = (headers: Headers): number => Number(headers.get(PROTOCOL_HEADER) ?? 1);
