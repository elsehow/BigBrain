fn main() {
  // The viewer is a REMOTE origin (the engine's own :4747), and release
  // builds hold remote pages to the ACL: every #[tauri::command] the page
  // invokes must be named here so its `allow-…` permission exists, and be
  // granted in capabilities/default.json. `tauri dev` does not enforce
  // this — a command missing here works in dev and dies in the shipped
  // app with "not allowed by ACL", which is how the palette's commands
  // shipped broken once. Add the command to BOTH places or the button it
  // backs is dev-only.
  tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
    "update_check",
    "update_install",
    "window_background",
    "window_is_maximized",
    "window_toggle_maximize",
    "ui_diagnostic",
  ])))
  .expect("failed to run tauri-build");
}
