/**
 * The desktop app's Rust ⇄ TypeScript contracts (#636).
 *
 * A `#[tauri::command]` is spelled in four places, and the viewer is a REMOTE
 * origin, so a release build holds it to the ACL: a command missing from
 * build.rs or from the capability works in `tauri dev` and dies in the
 * shipped app with "not allowed by ACL". That is not hypothetical — the
 * palette's commands shipped broken exactly once, which is why build.rs
 * carries a comment begging the next person to edit both places.
 *
 * A comment cannot fail CI. This can.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ENGINE_ROOT } from "../lib/engine";
import { NO_ENV_FILE } from "../lib/env";

const read = (rel: string): string => readFileSync(join(ENGINE_ROOT, rel), "utf8");

/** snake_case (Rust) → kebab-case (the ACL's `allow-…` permission). */
const kebab = (name: string): string => name.replace(/_/g, "-");

const LIB_RS = read("desktop/src-tauri/src/lib.rs");
const BUILD_RS = read("desktop/src-tauri/build.rs");
const NATIVE_TS = read("web/ui/src/lib/native.ts");

function block(text: string, open: RegExp): string[] {
  const start = text.match(open);
  if (!start?.index) throw new Error(`no ${open} in the source`);
  const rest = text.slice(start.index + start[0].length);
  const end = rest.indexOf("]");
  return rest
    .slice(0, end)
    .split(",")
    .map((s) => s.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
}

describe("every #[tauri::command] is spelled the same in all four places", () => {
  const registered = block(LIB_RS, /invoke_handler\(tauri::generate_handler!\[/).sort();
  const declared = block(BUILD_RS, /\.commands\(&\[/).sort();
  const granted = (JSON.parse(read("desktop/src-tauri/capabilities/default.json")) as { permissions: string[] })
    .permissions.filter((p) => p.startsWith("allow-"))
    .map((p) => p.slice("allow-".length))
    .sort();

  test("the handler list is not empty (the parse still works)", () => {
    expect(registered.length).toBeGreaterThan(0);
    expect(registered).toContain("update_check");
  });

  test("build.rs declares exactly what lib.rs registers", () => {
    expect(declared).toEqual(registered);
  });

  test("the capability grants exactly what lib.rs registers", () => {
    expect(granted).toEqual(registered.map(kebab));
  });

  test("every command the viewer invokes is one the app registers", () => {
    const invoked = [...NATIVE_TS.matchAll(/\binvoke(?:<[^>]*>)?\(\s*"([a-z_]+)"/g)].map((m) => m[1] as string);
    expect(invoked.length).toBeGreaterThan(0);
    for (const cmd of invoked) expect(registered).toContain(cmd);
  });
});

describe("the literals the two languages agree on by hand", () => {
  test("the app starts the supervisor without bun's .env autoload, as the engine starts its jobs", () => {
    const start = LIB_RS.slice(LIB_RS.indexOf("fn start_supervisor("));
    expect(start.slice(0, start.indexOf(".arg(supervisor)"))).toContain(`.arg("${NO_ENV_FILE}")`);
  });

  test("the shim marker the app writes is the one the engine looks for", () => {
    const rust = LIB_RS.match(/const SHIM_MARKER: &str = "([^"]+)"/)?.[1];
    const ts = read("lib/bigbrainCommand.ts").match(/APP_SHIM_MARKER = "([^"]+)"/)?.[1];
    expect(rust).toBeTruthy();
    expect(ts).toBe(rust);
  });


  test("every window the shell builds keeps foreign navigation out of the webview", () => {
    // One page, every route a hash on it: a top-level navigation anywhere
    // else is a trap with no way back (2026-09-02). The viewer diverts the
    // click (lib/links.ts); the shell's policy is the floor under it, and
    // it must be on the main window.
    expect(LIB_RS.match(/\.on_navigation\(stay_on\(/g)?.length).toBe(1);
    expect(read("web/ui/src/components/Base.svelte")).toContain("onclick={openExternalLinks}");
  });


  test("the /api/engine keys the app reads are the ones the engine sends", () => {
    // lib.rs's engine_info() reads these out of the JSON; lib/engine.ts's
    // engineIdentity() is what puts them there (bin/desktop.ts, web/server.ts).
    for (const key of ["engine", "supervisor"]) {
      expect(LIB_RS).toContain(`v.get("${key}")`);
      expect(read("lib/engine.ts")).toContain(`${key}:`);
    }
  });
});
