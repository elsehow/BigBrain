export const SOURCES = {
  granola: { name: "Granola", account: "Fable Studio", scope: "Read meeting transcripts",
    rule: "Remember all available full transcripts, including history. Skip generated summaries. Keep up with new and changed transcripts. Preserve the original evidence." },
  "that-tracks": { name: "That Tracks", account: "Sample journal", scope: "Read entries and tags",
    rule: "Remember entries since 1 September 2026, including notes and tags. Keep up with new and changed entries. Skip empty entries." },
} as const;
export type Source = keyof typeof SOURCES;
type Integration = { active: boolean; rule: string };
export type ActivationState = {
  integrations: Record<Source, Integration>;
  setup: null | { source: Source; step: "account" | "review" | "rule"; authenticated: boolean; draft: string; error: string };
  failNext: boolean;
};
export type Action = { type: "begin" | "deactivate"; source: Source }
  | { type: "connect" | "allow" | "back" | "cancel" | "finish" }
  | { type: "edit"; value: string };
export function initialActivation(active = false, failNext = false): ActivationState {
  return { integrations: { granola: { active, rule: SOURCES.granola.rule },
    "that-tracks": { active: false, rule: SOURCES["that-tracks"].rule } }, setup: null, failNext };
}
// Active state changes only at the final gate; setup edits never mutate saved config.
export function transition(state: ActivationState, action: Action): ActivationState {
  if (action.type === "cancel") return { ...state, setup: null };
  if (action.type === "deactivate") return { ...state, setup: null, integrations: {
    ...state.integrations, [action.source]: { ...state.integrations[action.source], active: false },
  } };
  if (action.type === "begin") {
    if (state.integrations[action.source].active) return state;
    return { ...state, setup: { source: action.source, step: "account", authenticated: false,
      draft: state.integrations[action.source].rule, error: "" } };
  }
  const setup = state.setup;
  if (!setup) return state;
  if (action.type === "connect" && setup.step === "account") return {
    ...state, failNext: false, setup: { ...setup, step: state.failNext ? "account" : "review",
      authenticated: false, error: state.failNext ? "Couldn’t connect. Try again." : "" },
  };
  if (action.type === "allow" && setup.step === "review") return { ...state, setup: { ...setup, step: "rule", authenticated: true } };
  if (action.type === "back") return { ...state, setup: { ...setup, step: "account", authenticated: false, error: "" } };
  if (action.type === "edit" && setup.step === "rule") return { ...state, setup: { ...setup, draft: action.value } };
  if (action.type === "finish" && setup.step === "rule" && setup.authenticated && setup.draft.trim()) return {
    ...state, setup: null, integrations: { ...state.integrations,
      [setup.source]: { active: true, rule: setup.draft.trim() } },
  };
  return state;
}
