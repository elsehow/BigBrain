/**
 * lib/cliflags.ts — pinning the exact behaviors bin/'s nine hand-rolled
 * parsers had before #265 consolidated them, so the switchover is provably
 * behavior-preserving rather than merely "looks the same".
 */
import { describe, expect, test } from "bun:test";
import { flagValue, flagValues, hasFlag, positionals } from "../lib/cliflags";

describe("flagValue — bin/drop.ts's/init.ts's/receive.ts's original flag()", () => {
  test("reads the token right after --<name>", () => {
    expect(flagValue(["--name", "note.md"], "name")).toBe("note.md");
  });

  test("absent flag → undefined", () => {
    expect(flagValue(["--other", "x"], "name")).toBeUndefined();
  });

  test("flag is the last token, nothing after it → undefined", () => {
    expect(flagValue(["--name"], "name")).toBeUndefined();
  });

  test("repeated flag: FIRST occurrence wins (matches the indexOf() every hand-rolled version used)", () => {
    expect(flagValue(["--x", "a", "--x", "b"], "x")).toBe("a");
  });

  test("bare-name convention: caller passes 'json', not '--json'", () => {
    expect(flagValue(["--json", "yes"], "json")).toBe("yes");
    expect(flagValue(["json", "yes"], "json")).toBeUndefined(); // no -- prefix in argv → no match
  });
});

describe("flagValues — bin/queue.ts's repeatable --ref / --param", () => {
  test("collects every occurrence, in order", () => {
    expect(flagValues(["--ref", "a", "--ref", "b", "--ref", "c"], "ref")).toEqual(["a", "b", "c"]);
  });

  test("none present → empty array", () => {
    expect(flagValues(["--guidance", "x"], "ref")).toEqual([]);
  });

  test("a trailing flag with nothing after it is skipped, not undefined", () => {
    expect(flagValues(["--ref", "a", "--ref"], "ref")).toEqual(["a"]);
  });
});

describe("hasFlag — the boolean switches (--force, --json, --no-poke, --dry-run, --uninstall...)", () => {
  test("present anywhere → true", () => {
    expect(hasFlag(["note.md", "--force"], "force")).toBe(true);
  });
  test("absent → false", () => {
    expect(hasFlag(["note.md"], "force")).toBe(false);
  });
  test("a flag that merely shares a substring does not match (exact token only)", () => {
    expect(hasFlag(["--forceful"], "force")).toBe(false);
  });
});

describe("positionals — bin/drop.ts's file argument, bin/search.ts's query words", () => {
  test("drop.ts: the file arg is whatever isn't a flag or a value-taking flag's value", () => {
    const VALUE_FLAGS = new Set(["dest", "name", "attach"]);
    const argv = ["note.md", "--attach", "fig.png", "--name", "custom.md"];
    expect(positionals(argv, VALUE_FLAGS)).toEqual(["note.md"]);
  });

  test("drop.ts: --no-poke is boolean, not in valueFlags, so it's excluded but swallows nothing after it", () => {
    const VALUE_FLAGS = new Set(["dest", "name", "attach"]);
    const argv = ["note.md", "--no-poke", "trailing.md"];
    // trailing.md is NOT --no-poke's value (--no-poke takes none), so it
    // remains a positional — exactly what the original filter did, since
    // "trailing.md" only gets excluded when the PRECEDING token is a
    // recognized value flag.
    expect(positionals(argv, VALUE_FLAGS)).toEqual(["note.md", "trailing.md"]);
  });

  test("search.ts: query words join back into one string, --limit/--why values excluded", () => {
    const VALUE_FLAGS = new Set(["limit", "why"]);
    const argv = ["catastrophic", "risks", "--limit", "5"];
    expect(positionals(argv, VALUE_FLAGS).join(" ")).toBe("catastrophic risks");
  });

  test("search.ts: --why's value is excluded even though its text isn't flag-shaped", () => {
    const VALUE_FLAGS = new Set(["limit", "why"]);
    const argv = ["rrsp", "room", "--why", "planning Q3 taxes"];
    // note: --why's value is ONE argv token here (the shell/array already
    // split it) — this pins that only the token directly after --why is
    // dropped, not everything to the end of argv.
    expect(positionals(argv, VALUE_FLAGS)).toEqual(["rrsp", "room"]);
  });

  test("no valueFlags supplied → every --flag is excluded, everything else kept", () => {
    expect(positionals(["a", "--x", "b"])).toEqual(["a", "b"]);
  });
});
