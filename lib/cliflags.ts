/**
 * cliflags.ts — the shared machinery under bin/'s nine hand-rolled `--flag`
 * readers (#265). Every one did the same
 * three things over `process.argv` — read a value flag, check a boolean
 * switch, and (drop.ts, search.ts) collect the positional words that are
 * neither — with one real convention mismatch: queue.ts's own `flagValue`
 * took the flag WITH its `--` (`flagValue("--guidance")`), every other
 * file's took the bare name (`flag("guidance")`). This module picks ONE
 * convention (bare name, matching the majority) and every caller adapts to
 * it — a signature change at the call site, not a behavior change: which
 * flags exist, what they default to, and which are repeatable is still
 * each command's own business and stays there.
 */

/** The token right after `--<name>` in argv, or undefined if the flag
 * isn't present (or is the very last token, with nothing after it). Last
 * occurrence... no — FIRST occurrence wins, matching every hand-rolled
 * `indexOf` this replaces: `--x a --x b` reads as `a`. */
export function flagValue(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 ? argv[i + 1] : undefined;
}

/** Every value following a (possibly repeated) `--<name>` — bin/queue.ts's
 * `--ref <id>`... and legacy `--param k=v`... are the only repeatable
 * flags in bin/ today. Order preserved; a flag with nothing after it (the
 * last argv token) is skipped rather than yielding `undefined`. */
export function flagValues(argv: readonly string[], name: string): string[] {
  return argv
    .flatMap((a, i) => (a === `--${name}` ? [argv[i + 1]] : []))
    .filter((v): v is string => v !== undefined);
}

/** Is `--<name>` present anywhere in argv — a boolean switch that takes no
 * value (`--force`, `--json`, `--no-poke`, ...). */
export function hasFlag(argv: readonly string[], name: string): boolean {
  return argv.includes(`--${name}`);
}

/** Every argv token that is neither a `--flag` itself nor the value
 * belonging to one immediately before it — bin/drop.ts's file argument,
 * bin/search.ts's query words. `valueFlags` names the flags that consume
 * the token after them (bare names, same convention as flagValue); a
 * `--flag` not listed there is excluded on its own but does NOT swallow
 * whatever follows it. */
export function positionals(
  argv: readonly string[],
  valueFlags: ReadonlySet<string> = new Set()
): string[] {
  return argv.filter((a, i) => {
    if (a.startsWith("--")) return false;
    const prev = argv[i - 1];
    return !(prev?.startsWith("--") && valueFlags.has(prev.slice(2)));
  });
}
