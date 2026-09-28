import { describe, expect, test } from "bun:test";
import { isSettingsView, SETTINGS_TABS } from "../web/ui/src/lib/settingsViews";

// One list: the rail's rows and the top bar's "inside settings" test. When the
// bar kept its own copy, the shortcuts screen fell outside it and took two
// clicks to leave (Nick, 2026-09-02).
describe("the settings screens", () => {
  test("every rail row is inside settings", () => {
    for (const t of SETTINGS_TABS) expect(isSettingsView(t.view)).toBe(true);
    expect(SETTINGS_TABS.map((t) => t.view)).toContain("vaultSettings");
  });

  test("the rest of the app is not", () => {
    for (const v of ["home", "vault", "search", "graph", "palette"] as const) expect(isSettingsView(v)).toBe(false);
  });
});
