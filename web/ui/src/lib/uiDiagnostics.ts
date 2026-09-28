interface UIDiagnostics {
  graphOff: boolean;
  render(phase: "start" | "end" | "error", ms?: number): void;
}
// Only the explicitly enabled diagnostic native shell supplies this object.
export const uiDiagnostics = (window as Window & { __BIGBRAIN_UI_DIAGNOSTICS__?: UIDiagnostics }).__BIGBRAIN_UI_DIAGNOSTICS__;
